import { invoke } from '@tauri-apps/api/core';

export interface KiroProxyConfig {
  port: number;
  api_key?: string | null;
  https_proxy?: string | null;
}

export interface KiroProxyStatus {
  running: boolean;
  port: number | null;
  pid: number | null;
  deps_installed: boolean;
  server_path: string | null;
}

export interface NodeAvailability {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface KiroProxyHealth {
  status: 'ok' | 'token_expired' | 'error';
  provider?: string;
  expiresAt?: string;
  message?: string;
}

export interface KiroProxyCreditsByModel {
  [model: string]: { requests: number; credits: number };
}

export interface KiroProxyCredits {
  period: string;
  requests: number;
  credits: number;
  byModel?: KiroProxyCreditsByModel;
}

export async function checkNode(): Promise<NodeAvailability> {
  return invoke('kiro_proxy_check_node');
}

export async function getKiroProxyStatus(): Promise<KiroProxyStatus> {
  return invoke('kiro_proxy_get_status');
}

export async function installKiroProxyDependencies(): Promise<void> {
  return invoke('kiro_proxy_install_dependencies');
}

export async function startKiroProxy(config: KiroProxyConfig): Promise<KiroProxyStatus> {
  return invoke('kiro_proxy_start', { config });
}

export async function stopKiroProxy(): Promise<void> {
  return invoke('kiro_proxy_stop');
}

export async function getKiroProxyHealth(): Promise<KiroProxyHealth> {
  return invoke('kiro_proxy_get_health');
}

export async function getKiroProxyCredits(period: 'today' | '7d' | '30d' | 'all' = 'today'): Promise<KiroProxyCredits> {
  return invoke('kiro_proxy_get_credits', { period });
}

export async function listKiroProxyModels(apiKey?: string): Promise<unknown> {
  return invoke('kiro_proxy_list_models', { apiKey: apiKey ?? null });
}

export interface KiroQuota {
  planName?: string;
  planTier?: string;
  creditsTotal?: number;
  creditsUsed?: number;
  bonusTotal?: number;
  bonusUsed?: number;
  usageResetAt?: string;
  raw?: unknown;
}

export async function getKiroProxyQuota(): Promise<KiroQuota> {
  const raw: any = await invoke('kiro_proxy_get_quota');
  const sub = raw?.subscriptionInfo;
  const breakdown = raw?.usageBreakdownList?.[0] ?? raw?.usageBreakdowns?.plan ?? raw;
  return {
    planName: sub?.subscriptionTitle ?? sub?.type ?? raw?.planName,
    planTier: sub?.type ?? raw?.planTier,
    creditsTotal: breakdown?.usageLimitWithPrecision ?? breakdown?.usageLimit ?? breakdown?.totalCredits ?? raw?.totalCredits,
    creditsUsed: breakdown?.currentUsageWithPrecision ?? breakdown?.currentUsage ?? breakdown?.usedCredits ?? raw?.usedCredits,
    bonusTotal: breakdown?.overageCapWithPrecision ?? breakdown?.overageCap,
    bonusUsed: breakdown?.currentOveragesWithPrecision ?? breakdown?.currentOverages,
    usageResetAt: breakdown?.nextDateReset
      ? new Date(breakdown.nextDateReset * 1000).toISOString()
      : raw?.nextDateReset
        ? new Date(raw.nextDateReset * 1000).toISOString()
        : undefined,
    raw,
  };
}
