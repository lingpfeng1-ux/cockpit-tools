import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowLeft, BadgeDollarSign, Copy, Play, RefreshCw, Send, ShieldCheck, Square, Terminal, Zap } from 'lucide-react';
import { KiroIcon } from '../components/icons/KiroIcon';
import {
  type KiroProxyConfig,
  type KiroProxyCredits,
  type KiroProxyHealth,
  type KiroProxyStatus,
  type KiroQuota,
  type NodeAvailability,
  checkNode,
  getKiroProxyCredits,
  getKiroProxyHealth,
  getKiroProxyQuota,
  getKiroProxyStatus,
  installKiroProxyDependencies,
  listKiroProxyModels,
  startKiroProxy,
  stopKiroProxy,
} from '../services/kiroProxyService';
import './KiroApiServicePage.css';

const DEFAULT_PORT = 3456;

export function KiroApiServicePage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<KiroProxyStatus | null>(null);
  const [node, setNode] = useState<NodeAvailability | null>(null);
  const [health, setHealth] = useState<KiroProxyHealth | null>(null);
  const [credits, setCredits] = useState<KiroProxyCredits | null>(null);
  const [creditsPeriod, setCreditsPeriod] = useState<'today' | '7d' | '30d' | 'all'>('today');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [apiKey, setApiKey] = useState('');
  const [httpsProxy, setHttpsProxy] = useState('');
  const [busy, setBusy] = useState<'idle' | 'install' | 'start' | 'stop' | 'refresh'>('idle');
  const [error, setError] = useState<string>('');
  const [models, setModels] = useState<Array<{id: string; name?: string}>>([]);
  const [testModel, setTestModel] = useState('');
  const [testPrompt, setTestPrompt] = useState('Say "hello" in one word.');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ok: boolean; message: string; latencyMs?: number} | null>(null);
  const [quota, setQuota] = useState<KiroQuota | null>(null);
  const refreshStatus = useCallback(async () => {
    try {
      const [s, n] = await Promise.all([getKiroProxyStatus(), checkNode()]);
      setStatus(s);
      setNode(n);
      if (s.running && s.port) {
        setPort(s.port);
      }
      if (s.running) {
        await Promise.all([
          getKiroProxyHealth().then(setHealth).catch(() => setHealth(null)),
          getKiroProxyCredits(creditsPeriod).then(setCredits).catch(() => setCredits(null)),
          getKiroProxyQuota().then(setQuota).catch(() => setQuota(null)),
          listKiroProxyModels(apiKey || undefined).then((resp: any) => {
            const data = resp?.data ?? resp?.models ?? [];
            setModels(Array.isArray(data) ? data : []);
            if (!testModel && Array.isArray(data) && data.length > 0) {
              setTestModel(data[0].id ?? data[0].modelId ?? '');
            }
          }).catch(() => setModels([])),
        ]);
      } else {
        setHealth(null);
        setCredits(null);
        setModels([]);
        setQuota(null);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [creditsPeriod]);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => void refreshStatus(), 10_000);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const handleInstall = async () => {
    setError('');
    setBusy('install');
    try {
      await installKiroProxyDependencies();
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy('idle');
    }
  };

  const handleStart = async () => {
    setError('');
    setBusy('start');
    try {
      const cfg: KiroProxyConfig = {
        port,
        api_key: apiKey.trim() || null,
        https_proxy: httpsProxy.trim() || null,
      };
      await startKiroProxy(cfg);
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy('idle');
    }
  };

  const handleStop = async () => {
    setError('');
    setBusy('stop');
    try {
      await stopKiroProxy();
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy('idle');
    }
  };

  const handleTestModel = async () => {
    if (!testModel || !status?.running) return;
    setTesting(true);
    setTestResult(null);
    const start = Date.now();
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<any>('kiro_proxy_test_model', {
        model: testModel,
        prompt: testPrompt || 'Say hello.',
        apiKey: apiKey.trim() || null,
      });
      const latencyMs = Date.now() - start;
      if (result?.ok) {
        setTestResult({ ok: true, message: result.message || 'Success', latencyMs });
      } else {
        setTestResult({ ok: false, message: result?.message || 'Unknown error', latencyMs });
      }
    } catch (err) {
      setTestResult({ ok: false, message: String(err), latencyMs: Date.now() - start });
    } finally {
      setTesting(false);
    }
  };

  const baseUrl = useMemo(() => {
    const p = status?.running ? status.port ?? port : port;
    return `http://localhost:${p}`;
  }, [status, port]);

  const claudeCodeSnippet = useMemo(() => {
    return JSON.stringify(
      {
        env: {
          ANTHROPIC_AUTH_TOKEN: apiKey.trim() || 'any',
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.6',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4.6',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4.5',
        },
        model: 'sonnet',
      },
      null,
      2,
    );
  }, [baseUrl, apiKey]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const nodeOk = node?.available === true;
  const depsOk = status?.deps_installed === true;
  const canStart = nodeOk && depsOk && !status?.running && busy === 'idle';

  return (
    <div className="kiro-api-service-page">
      <div className="kiro-api-service-content">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => window.dispatchEvent(new CustomEvent('app-request-navigate', { detail: 'kiro' }))}
          style={{ alignSelf: 'flex-start', gap: 6, marginBottom: -8 }}
        >
          <ArrowLeft size={16} />
          {t('kiroApiService.backToKiro', '返回 Kiro 账号')}
        </button>
        <header className="kiro-api-service-hero">
          <div className="kiro-api-service-hero-main">
            <div className="kiro-api-service-title-row">
              <div className="kiro-api-service-title-icon">
                <KiroIcon />
              </div>
              <div className="kiro-api-service-title-copy">
                <h1>{t('kiroApiService.title', 'Kiro 本地 API 服务')}</h1>
                <span className="kiro-api-service-title-line">
                  {t(
                    'kiroApiService.subtitle',
                    '基于 kiro-proxy,把 Kiro 订阅的 Claude 模型暴露成 OpenAI/Anthropic 兼容 HTTP 接口。',
                  )}
                </span>
              </div>
            </div>

            <div className="kiro-api-service-pill-row">
              <span
                className={`kiro-api-service-status ${
                  status?.running ? 'running' : 'stopped'
                }`}
              >
                <Activity size={14} />
                {status?.running
                  ? t('kiroApiService.running', '运行中')
                  : t('kiroApiService.stopped', '未运行')}
              </span>
              {nodeOk ? (
                <span className="kiro-api-service-pill success">
                  Node {node?.version}
                </span>
              ) : (
                <span className="kiro-api-service-pill error">
                  {node?.error || t('kiroApiService.nodeMissing', '未检测到 Node ≥ 18')}
                </span>
              )}
              {depsOk ? (
                <span className="kiro-api-service-pill success">deps ok</span>
              ) : (
                <span className="kiro-api-service-pill muted">deps not installed</span>
              )}
            </div>
          </div>

          <div className="kiro-api-service-hero-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void refreshStatus()}
              disabled={busy !== 'idle'}
            >
              <RefreshCw size={16} />
              {t('common.refresh', '刷新')}
            </button>
            {!depsOk && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleInstall}
                disabled={busy !== 'idle' || !nodeOk}
              >
                <Terminal size={16} />
                {busy === 'install'
                  ? t('kiroApiService.installing', '安装依赖中...')
                  : t('kiroApiService.installDeps', '安装依赖')}
              </button>
            )}
            {status?.running ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleStop}
                disabled={busy !== 'idle'}
              >
                <Square size={16} />
                {t('kiroApiService.stop', '停止服务')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleStart}
                disabled={!canStart}
              >
                <Play size={16} />
                {busy === 'start'
                  ? t('kiroApiService.starting', '启动中...')
                  : t('kiroApiService.start', '启动服务')}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="kiro-api-service-message error">
            <span>{error}</span>
          </div>
        )}

        <section className="kiro-api-service-panel">
          <h2>{t('kiroApiService.config', '配置')}</h2>
          <div className="kiro-api-service-config-grid">
            <label>
              <span>Port</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number.parseInt(e.target.value || '0', 10) || DEFAULT_PORT)}
                disabled={status?.running}
              />
            </label>
            <label>
              <span>PROXY_API_KEY</span>
              <input
                type="text"
                placeholder={t('kiroApiService.apiKeyPlaceholder', '留空则不鉴权')}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={status?.running}
              />
            </label>
            <label>
              <span>HTTPS_PROXY</span>
              <input
                type="text"
                placeholder="http://127.0.0.1:7890"
                value={httpsProxy}
                onChange={(e) => setHttpsProxy(e.target.value)}
                disabled={status?.running}
              />
            </label>
          </div>
        </section>

        {status?.running && (
          <section className="kiro-api-service-panel">
            <h2>{t('kiroApiService.runtime', '运行状态')}</h2>
            <div className="kiro-api-service-summary-grid">
              <div className="kiro-api-service-summary-card">
                <span>PID</span>
                <strong>{status.pid ?? '-'}</strong>
              </div>
              <div className="kiro-api-service-summary-card">
                <span>Port</span>
                <strong>{status.port ?? '-'}</strong>
              </div>
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.tokenStatus', 'Token')}</span>
                <strong>{health?.status ?? '...'}</strong>
                {health?.provider && <small>{health.provider}</small>}
              </div>
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.expires', '过期时间')}</span>
                <strong>{health?.expiresAt ?? '-'}</strong>
              </div>
            </div>
          </section>
        )}

        {status?.running && quota && (
          <section className="kiro-api-service-panel">
            <h2>{t('kiroApiService.officialQuota', '官方配额')}</h2>
            <div className="kiro-api-service-summary-grid">
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.plan', '套餐')}</span>
                <strong>{quota.planName || quota.planTier || '-'}</strong>
              </div>
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.quotaUsed', '已用')}</span>
                <strong>{quota.creditsUsed?.toFixed(2) ?? '-'}</strong>
                {quota.creditsTotal != null && <small>/ {quota.creditsTotal}</small>}
              </div>
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.quotaRemaining', '剩余')}</span>
                <strong>
                  {quota.creditsTotal != null && quota.creditsUsed != null
                    ? (quota.creditsTotal - quota.creditsUsed).toFixed(2)
                    : '-'}
                </strong>
              </div>
              {(quota.bonusTotal != null && quota.bonusTotal > 0) && (
                <div className="kiro-api-service-summary-card">
                  <span>{t('kiroApiService.bonus', '奖励积分')}</span>
                  <strong>{((quota.bonusTotal ?? 0) - (quota.bonusUsed ?? 0)).toFixed(2)}</strong>
                  <small>/ {quota.bonusTotal}</small>
                </div>
              )}
              {quota.usageResetAt && (
                <div className="kiro-api-service-summary-card">
                  <span>{t('kiroApiService.resetAt', '重置时间')}</span>
                  <strong>{new Date(quota.usageResetAt).toLocaleDateString()}</strong>
                </div>
              )}
            </div>
          </section>
        )}

        {status?.running && (
          <section className="kiro-api-service-panel">
            <div className="kiro-api-service-panel-head">
              <h2>
                <BadgeDollarSign size={16} />
                {t('kiroApiService.credits', '积分用量')}
              </h2>
              <div className="kiro-api-service-segmented">
                {(['today', '7d', '30d', 'all'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={creditsPeriod === p ? 'active' : ''}
                    onClick={() => setCreditsPeriod(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="kiro-api-service-summary-grid">
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.requests', '请求数')}</span>
                <strong>{credits?.requests ?? 0}</strong>
              </div>
              <div className="kiro-api-service-summary-card">
                <span>{t('kiroApiService.creditsUsed', '积分')}</span>
                <strong>{(credits?.credits ?? 0).toFixed(4)}</strong>
              </div>
            </div>
            {credits?.byModel && Object.keys(credits.byModel).length > 0 && (
              <table className="kiro-api-service-table">
                <thead>
                  <tr>
                    <th>{t('kiroApiService.model', '模型')}</th>
                    <th>{t('kiroApiService.requests', '请求数')}</th>
                    <th>{t('kiroApiService.creditsUsed', '积分')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(credits.byModel).map(([model, value]) => (
                    <tr key={model}>
                      <td>{model}</td>
                      <td>{value?.requests ?? 0}</td>
                      <td>{(value?.credits ?? 0).toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {status?.running && (
          <section className="kiro-api-service-panel">
            <div className="kiro-api-service-panel-head">
              <h2>
                <Zap size={16} />
                {t('kiroApiService.testModel', '联通测试')}
              </h2>
            </div>
            <div className="kiro-api-service-config-grid">
              <label>
                <span>{t('kiroApiService.model', '模型')}</span>
                <select
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                  disabled={testing}
                  style={{ padding: '8px 10px', background: 'var(--color-input-bg, transparent)', border: '1px solid var(--color-border)', borderRadius: '8px', color: 'var(--color-text)', fontSize: '13px' }}
                >
                  {models.length === 0 && <option value="">-- loading --</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('kiroApiService.testPrompt', '测试 Prompt')}</span>
                <input
                  type="text"
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  disabled={testing}
                  placeholder='Say "hello" in one word.'
                />
              </label>
            </div>
            <div className="kiro-api-service-hero-actions" style={{ marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleTestModel}
                disabled={testing || !testModel}
              >
                <Send size={14} />
                {testing
                  ? t('kiroApiService.testing', '测试中...')
                  : t('kiroApiService.runTest', '发送测试')}
              </button>
            </div>
            {testResult && (
              <div className={`kiro-api-service-message ${testResult.ok ? 'success' : 'error'}`} style={testResult.ok ? { background: 'rgba(34,197,94,0.08)', color: '#16a34a', borderColor: 'rgba(34,197,94,0.25)' } : undefined}>
                <span>
                  {testResult.ok ? '✓' : '✗'} {testResult.message}
                  {testResult.latencyMs != null && ` (${testResult.latencyMs}ms)`}
                </span>
              </div>
            )}
          </section>
        )}

        <section className="kiro-api-service-panel">
          <div className="kiro-api-service-panel-head">
            <h2>
              <ShieldCheck size={16} />
              {t('kiroApiService.endpoints', '接入说明')}
            </h2>
          </div>
          <div className="kiro-api-service-endpoint-grid">
            {[
              { path: '/v1/messages', desc: 'Anthropic Messages 兼容' },
              { path: '/v1/chat/completions', desc: 'OpenAI Chat Completions 兼容' },
              { path: '/v1/models', desc: '可用模型列表' },
              { path: '/health', desc: 'token 状态' },
              { path: '/credits', desc: '积分统计' },
            ].map((item) => (
              <div className="kiro-api-service-endpoint-card" key={item.path}>
                <code>{baseUrl}{item.path}</code>
                <span>{item.desc}</span>
                <button
                  type="button"
                  className="btn btn-ghost icon-only"
                  onClick={() => copy(`${baseUrl}${item.path}`)}
                  title={t('common.copy', '复制')}
                >
                  <Copy size={14} />
                </button>
              </div>
            ))}
          </div>

          <h3>{t('kiroApiService.claudeCodeSnippet', 'Claude Code 集成示例(~/.claude/settings.json)')}</h3>
          <pre className="kiro-api-service-code">
            {claudeCodeSnippet}
            <button
              type="button"
              className="btn btn-ghost icon-only kiro-api-service-code-copy"
              onClick={() => copy(claudeCodeSnippet)}
              title={t('common.copy', '复制')}
            >
              <Copy size={14} />
            </button>
          </pre>
          <p className="kiro-api-service-note">
            {t(
              'kiroApiService.tokenNote',
              'Token 来源:~/.aws/sso/cache/kiro-auth-token.json,与 npx kiro-proxy 行为一致。需要先用 Kiro 客户端登录。',
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

export default KiroApiServicePage;
