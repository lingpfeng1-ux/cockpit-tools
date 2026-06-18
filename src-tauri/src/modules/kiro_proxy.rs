//! kiro-proxy Node 边车进程管理。
//!
//! 把 https://github.com/Colin3191/kiro-proxy 作为 Node 边车进程托管:
//! - `start` 用 `node server.js` 启动,绑定指定端口与可选 PROXY_API_KEY
//! - `stop` 优雅终止(Windows: taskkill /T,*nix: SIGTERM)
//! - `status` / `health` / `credits` 走 HTTP 直接转发给前端
//!
//! 路径解析顺序:
//! 1. Tauri Resource 目录下的 `sidecars/kiro-proxy/server.js`
//! 2. 从 current_exe 向上回溯找到 `sidecars/kiro-proxy/server.js`(开发模式)
//! 3. 项目根目录(env CARGO_MANIFEST_DIR/.. 等)的 `sidecars/kiro-proxy`(测试)

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::modules::logger;

const DEFAULT_PORT: u16 = 3456;
const REQUEST_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KiroProxyConfig {
    pub port: u16,
    /// 可选 API Key,设置后客户端必须以 Bearer 形式带上
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 可选 HTTPS_PROXY,透传给 Node 子进程
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub https_proxy: Option<String>,
}

impl Default for KiroProxyConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            api_key: None,
            https_proxy: None,
        }
    }
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct KiroProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    /// node_modules 是否已安装,前端用来引导用户安装依赖
    pub deps_installed: bool,
    pub server_path: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct NodeAvailability {
    pub available: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

struct ProxyHandle {
    child: Child,
    port: u16,
    pid: u32,
}

static PROXY_HANDLE: Mutex<Option<ProxyHandle>> = Mutex::new(None);

/// 解析 sidecars/kiro-proxy 的目录(包含 server.js)
fn resolve_kiro_proxy_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Tauri Resource (生产模式)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecars").join("kiro-proxy");
        if candidate.join("server.js").exists() {
            return Ok(candidate);
        }
    }

    // 2. 从 current_exe 向上找
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            let candidate = d.join("sidecars").join("kiro-proxy");
            if candidate.join("server.js").exists() {
                return Ok(candidate);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    // 3. 从 cwd 向上找
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd);
        while let Some(d) = dir {
            let candidate = d.join("sidecars").join("kiro-proxy");
            if candidate.join("server.js").exists() {
                return Ok(candidate);
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }

    Err("未找到 sidecars/kiro-proxy 目录,请确认安装是否完整".to_string())
}

fn deps_installed(dir: &Path) -> bool {
    dir.join("node_modules").is_dir()
}

/// 检查 node 是否可用,版本是否 >= 18
pub async fn check_node() -> NodeAvailability {
    match Command::new("node").arg("--version").output().await {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // 解析 v18.x.x
            let major = version
                .trim_start_matches('v')
                .split('.')
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if major >= 18 {
                NodeAvailability {
                    available: true,
                    version: Some(version),
                    error: None,
                }
            } else {
                NodeAvailability {
                    available: false,
                    version: Some(version),
                    error: Some("需要 Node.js >= 18".to_string()),
                }
            }
        }
        Ok(out) => NodeAvailability {
            available: false,
            version: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(err) => NodeAvailability {
            available: false,
            version: None,
            error: Some(format!("未检测到 node 命令: {}", err)),
        },
    }
}

/// 在 sidecars/kiro-proxy 内执行 npm install(或 npm ci 如果有 lock)
pub async fn install_dependencies(app: AppHandle) -> Result<(), String> {
    let dir = resolve_kiro_proxy_dir(&app)?;
    logger::log_info(&format!(
        "[KiroProxy] 开始安装依赖: dir={}",
        dir.display()
    ));

    let npm = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };
    let status = Command::new(npm)
        .arg("install")
        .arg("--omit=dev")
        .arg("--no-audit")
        .arg("--no-fund")
        .current_dir(&dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .map_err(|e| format!("启动 npm install 失败: {}", e))?;

    if !status.success() {
        return Err(format!("npm install 失败,exit={:?}", status.code()));
    }
    logger::log_info("[KiroProxy] 依赖安装完成");
    Ok(())
}

/// 启动 kiro-proxy,如果已经在运行,先停掉
pub async fn start_service(app: AppHandle, cfg: KiroProxyConfig) -> Result<KiroProxyStatus, String> {
    stop_service().await.ok();

    let dir = resolve_kiro_proxy_dir(&app)?;
    if !deps_installed(&dir) {
        return Err(format!(
            "{} 下尚未安装依赖,请先调用安装",
            dir.display()
        ));
    }

    let server_js = dir.join("server.js");
    let mut cmd = Command::new("node");
    // 注意: Windows 上 dir 可能带 `\\?\` verbatim 前缀, 直接把绝对路径传给 node 会让其
    // 模块解析器在切 `\` 时把 `D:` 当成首段去 lstat 而炸掉 (EISDIR)。
    // 因为已经设置了 current_dir, 这里只传文件名即可。
    cmd.arg("server.js")
        .current_dir(&dir)
        .env("PORT", cfg.port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(key) = &cfg.api_key {
        if !key.trim().is_empty() {
            cmd.env("PROXY_API_KEY", key);
        }
    }
    if let Some(proxy) = &cfg.https_proxy {
        if !proxy.trim().is_empty() {
            cmd.env("HTTPS_PROXY", proxy);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // 创建独立的进程组以便可以被一并 kill 掉
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 kiro-proxy 失败: {}", e))?;

    let pid = child
        .id()
        .ok_or_else(|| "无法获取 kiro-proxy pid".to_string())?;

    // pipe stdout/stderr 到 logger
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logger::log_info(&format!("[KiroProxy] {}", line));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logger::log_warn(&format!("[KiroProxy] {}", line));
            }
        });
    }

    let mut guard = PROXY_HANDLE
        .lock()
        .map_err(|_| "kiro-proxy 状态锁中毒".to_string())?;
    *guard = Some(ProxyHandle {
        child,
        port: cfg.port,
        pid,
    });

    logger::log_info(&format!(
        "[KiroProxy] 已启动: pid={}, port={}",
        pid, cfg.port
    ));

    Ok(KiroProxyStatus {
        running: true,
        port: Some(cfg.port),
        pid: Some(pid),
        deps_installed: true,
        server_path: Some(server_js.to_string_lossy().to_string()),
    })
}

pub async fn stop_service() -> Result<(), String> {
    let mut handle_opt = {
        let mut guard = PROXY_HANDLE
            .lock()
            .map_err(|_| "kiro-proxy 状态锁中毒".to_string())?;
        guard.take()
    };

    if let Some(handle) = handle_opt.as_mut() {
        // tokio::process::Child::kill 是异步的
        let _ = handle.child.kill().await;
        let _ = handle.child.wait().await;
        logger::log_info(&format!("[KiroProxy] 已停止: pid={}", handle.pid));
    }
    Ok(())
}

pub fn current_status(app: &AppHandle) -> KiroProxyStatus {
    let guard = match PROXY_HANDLE.lock() {
        Ok(g) => g,
        Err(_) => return KiroProxyStatus::default(),
    };

    let dir = resolve_kiro_proxy_dir(app).ok();
    let installed = dir.as_ref().map(|d| deps_installed(d)).unwrap_or(false);
    let server_path = dir.map(|d| d.join("server.js").to_string_lossy().to_string());

    if let Some(handle) = guard.as_ref() {
        KiroProxyStatus {
            running: true,
            port: Some(handle.port),
            pid: Some(handle.pid),
            deps_installed: installed,
            server_path,
        }
    } else {
        KiroProxyStatus {
            running: false,
            port: None,
            pid: None,
            deps_installed: installed,
            server_path,
        }
    }
}

/// HTTP GET /health 透传
pub async fn fetch_health() -> Result<Value, String> {
    let port = current_port().ok_or("kiro-proxy 未运行".to_string())?;
    http_get(format!("http://127.0.0.1:{}/health", port), None).await
}

/// HTTP GET /credits?period= 透传
pub async fn fetch_credits(period: Option<String>) -> Result<Value, String> {
    let port = current_port().ok_or("kiro-proxy 未运行".to_string())?;
    let period = period.unwrap_or_else(|| "today".to_string());
    http_get(
        format!("http://127.0.0.1:{}/credits?period={}", port, period),
        None,
    )
    .await
}

/// HTTP GET /v1/models 透传
pub async fn fetch_models(api_key: Option<String>) -> Result<Value, String> {
    let port = current_port().ok_or("kiro-proxy 未运行".to_string())?;
    http_get(format!("http://127.0.0.1:{}/v1/models", port), api_key).await
}

/// HTTP GET /quota — 查询 Kiro 官方配额
pub async fn fetch_quota() -> Result<Value, String> {
    let port = current_port().ok_or("kiro-proxy 未运行".to_string())?;
    http_get(format!("http://127.0.0.1:{}/quota", port), None).await
}

/// POST /v1/messages 发送一条简单 prompt 测试模型连通性
pub async fn test_model(model: String, prompt: String, api_key: Option<String>) -> Result<Value, String> {
    let port = current_port().ok_or("kiro-proxy 未运行".to_string())?;
    let url = format!("http://127.0.0.1:{}/v1/messages", port);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .no_proxy()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 64,
        "messages": [{"role": "user", "content": prompt}]
    });

    let mut req = client.post(&url).json(&body);
    if let Some(key) = api_key.filter(|s| !s.trim().is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status_code = resp.status();
    let json: Value = resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

    if status_code.is_success() {
        let text = json["content"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        Ok(serde_json::json!({"ok": true, "message": text}))
    } else {
        let err_msg = json["error"]["message"]
            .as_str()
            .or_else(|| json["message"].as_str())
            .unwrap_or("unknown error");
        Ok(serde_json::json!({"ok": false, "message": format!("HTTP {}: {}", status_code.as_u16(), err_msg)}))
    }
}

fn current_port() -> Option<u16> {
    PROXY_HANDLE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.port))
}

async fn http_get(url: String, bearer: Option<String>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .no_proxy()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;

    let mut req = client.get(&url);
    if let Some(key) = bearer.filter(|s| !s.trim().is_empty()) {
        req = req.bearer_auth(key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 kiro-proxy 失败: {}", e))?;
    let status = resp.status();
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "kiro-proxy 返回 HTTP {}: {}",
            status,
            value.to_string()
        ));
    }
    Ok(value)
}
