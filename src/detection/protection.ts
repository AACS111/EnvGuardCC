import { helperRequest, helperUrl } from './local-helper';

export type ProtectionTarget = { ip: string; countryCode: string; countryName: string; city: string | null; timezone: string | null; windowsTimezone: string | null; language: string; locale: string };
export type ProtectionReport = {
  phase: 'idle' | 'starting' | 'active' | 'partial' | 'restart_required' | 'stopping' | 'restore_failed';
  enabled: boolean; target: ProtectionTarget | null; issues: string[];
  /** 当前系统时区（由本机助手读取），用于和 target.timezone 对照。 */
  systemTimezone?: string | null;
  desiredEnabled?: boolean;
  /** 保护关闭时的 Claude 阻断：active 表示已生效，error 表示未能建立及原因。 */
  unprotectedBlock?: { active: boolean; error: string | null };
  connection?: { state: string; checkedAt: string | null; tunCaptured: boolean | null; reason: string | null; systemKillSwitch: boolean; strictTravel: boolean };
  history: { at: string; message: string }[]; lastTestAt: string | null; nextTestAt: string | null;
  runId: string | null; score: number | null; alarm: boolean; monitoring: boolean;
  verificationScore?: number; scoreReference?: number | null; scoreDropPercent?: number;
  intervalMs: number;
  testing?: boolean; testState?: string; testError?: string | null;
};

export async function protectionRequest(action?: string, data: object = {}): Promise<ProtectionReport> {
  const session = action ? await helperRequest('/session?tokenOnly=1') : null;
  const response = await fetch(`${helperUrl}/protection`, {
    method: action ? 'POST' : 'GET',
    headers: { 'X-CheckCC-Client': 'repair-ui', ...(session ? { 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token } : {}) },
    body: action ? JSON.stringify({ action, ...data }) : undefined,
    signal: AbortSignal.timeout(action === 'start' || action === 'stop' || action === 'test' || action === 'resume' ? 180000 : 5000), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
