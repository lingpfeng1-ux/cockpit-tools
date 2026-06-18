//! Tauri commands for kiro-proxy Node sidecar.

use serde_json::Value;
use tauri::AppHandle;

use crate::modules::kiro_proxy::{
    self, KiroProxyConfig, KiroProxyStatus, NodeAvailability,
};

#[tauri::command]
pub async fn kiro_proxy_check_node() -> NodeAvailability {
    kiro_proxy::check_node().await
}

#[tauri::command]
pub fn kiro_proxy_get_status(app: AppHandle) -> KiroProxyStatus {
    kiro_proxy::current_status(&app)
}

#[tauri::command]
pub async fn kiro_proxy_install_dependencies(app: AppHandle) -> Result<(), String> {
    kiro_proxy::install_dependencies(app).await
}

#[tauri::command]
pub async fn kiro_proxy_start(
    app: AppHandle,
    config: KiroProxyConfig,
) -> Result<KiroProxyStatus, String> {
    kiro_proxy::start_service(app, config).await
}

#[tauri::command]
pub async fn kiro_proxy_stop() -> Result<(), String> {
    kiro_proxy::stop_service().await
}

#[tauri::command]
pub async fn kiro_proxy_get_health() -> Result<Value, String> {
    kiro_proxy::fetch_health().await
}

#[tauri::command]
pub async fn kiro_proxy_get_credits(period: Option<String>) -> Result<Value, String> {
    kiro_proxy::fetch_credits(period).await
}

#[tauri::command]
pub async fn kiro_proxy_list_models(api_key: Option<String>) -> Result<Value, String> {
    kiro_proxy::fetch_models(api_key).await
}

#[tauri::command]
pub async fn kiro_proxy_get_quota() -> Result<Value, String> {
    kiro_proxy::fetch_quota().await
}

#[tauri::command]
pub fn kiro_proxy_update_account_quota(
    account_id: String,
    plan_name: Option<String>,
    plan_tier: Option<String>,
    credits_total: Option<f64>,
    credits_used: Option<f64>,
    bonus_total: Option<f64>,
    bonus_used: Option<f64>,
    usage_reset_at: Option<i64>,
) -> Result<crate::models::kiro::KiroAccount, String> {
    crate::modules::kiro_account::update_account_quota_from_proxy(
        &account_id,
        plan_name,
        plan_tier,
        credits_total,
        credits_used,
        bonus_total,
        bonus_used,
        usage_reset_at,
    )
}

#[tauri::command]
pub async fn kiro_proxy_test_model(
    model: String,
    prompt: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    kiro_proxy::test_model(model, prompt, api_key).await
}
