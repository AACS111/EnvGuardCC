// EnvGuardCC 的本机助手客户端，用于连接仅监听回环地址的 check-cc 修复服务并读写系统时区。
const runtimePorts = typeof window === "undefined" ? undefined : (window as Window & { __CHECKCC_PORTS__?: { helper: number; gateway: number } }).__CHECKCC_PORTS__;
export const helperUrl = `http://127.0.0.1:${runtimePorts?.helper ?? 3001}`;

export type HelperCapabilities = { timezoneRead: boolean; timezoneWrite: boolean; timezoneFormat: "iana" | "windows"; timezoneAuthorization: boolean; browserLaunch: boolean; desktopLaunch: boolean; desktopMode: "standard" | "managed"; desktopScripts: boolean; desktopReason: string };
export type HelperSession = { capabilities?: HelperCapabilities; token: string; timezone: string; canRestore: boolean; platform: string; profile?: unknown };
export const gatewayUrl = `http://127.0.0.1:${runtimePorts?.gateway ?? 3010}`;

export async function helperRequest(path: string, token?: string, body?: object): Promise<HelperSession & { timezone: string; canRestore: boolean }> {
  const response = await fetch(`${helperUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-CheckCC-Client": "repair-ui", ...(body ? { "Content-Type": "application/json", "X-CheckCC-Token": token ?? "" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body ? (path.startsWith("/timezone") ? 120000 : 45000) : 8000),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

export function browserSettingsAddress() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge://settings/languages";
  if (/Firefox\//.test(ua)) return "about:preferences#general";
  return "chrome://settings/languages";
}

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
