import { gatewayUrl } from "./local-helper";

export type SimulationJob = {
  version: 1;
  kind: "local-simulation-only";
  state: "idle" | "running" | "passed" | "failed" | "stale";
  running?: boolean;
  runId?: string;
  profileUpdatedAt?: string | null;
  cloakUpdatedAt?: string | null;
  target?: { language: string; locale: string; timezone: string | null };
  completed?: number;
  passed?: number;
  total?: number;
  error?: string | null;
  messageProbe?: { viaLiveGateway: boolean; method: "POST"; path: "/v1/messages"; status: number; elapsedMs?: number; headersIntegrity?: boolean; receivedHeaders?: Record<string, string>; sentLanguage: string; receivedLanguage: string; sentLocale: string; receivedLocale: string; bodyUnchanged: boolean };
  scenarios: Array<{ id: string; label: string; state: "pending" | "passed" | "failed"; signals: string[] }>;
  signalResults: Record<string, { state: "running" | "passed" | "failed" | "stale"; completed: number; total: number; failed: number }>;
};

export async function requestSimulation(start = false): Promise<SimulationJob> {
  const response = await fetch(`${gatewayUrl}/__checkcc/simulation`, {
    method: start ? "POST" : "GET", headers: { "X-CheckCC-Client": "gateway-ui" },
    cache: "no-store", signal: AbortSignal.timeout(8000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `自检接口 HTTP ${response.status}，请确认网关已更新并重启。`);
  if (value.version !== 1 || value.kind !== "local-simulation-only" || !Array.isArray(value.scenarios) || !value.signalResults) throw new Error("自检返回格式不兼容，请重启网关。");
  return value;
}
