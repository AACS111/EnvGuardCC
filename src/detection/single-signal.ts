import { gatewayUrl } from "./local-helper";
import type { SignalResult } from "./types";
import type { SimulationJob } from "./simulation";
import type { GatewayCheck } from "./gateway-check";
import { nativeClientSignals } from "./simulation-evidence";

export async function requestSignalSimulation(id: string, related = false): Promise<SimulationJob> {
  const response = await fetch(`${gatewayUrl}/__checkcc/message-probe?signal=${encodeURIComponent(id)}${related ? "&related=1" : ""}`, {
    method: "POST", headers: { "X-CheckCC-Client": "gateway-ui" }, cache: "no-store", signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  if (result.kind !== "local-simulation-only" || !result.messageProbe?.viaLiveGateway || !result.signalResults?.[id]) throw new Error("单项测试接口不兼容，请重启 npm run dev。");
  return result;
}

export function mergePointSignals(previous: SignalResult[], sample: SignalResult, template: SignalResult[] = []) {
  const base = previous.length ? previous : template.map((signal) => ({ ...signal, value: null, testedAt: undefined, settingValue: undefined, observation: undefined, score: 0, contribution: 0, assessment: "unknown" as const }));
  return base.some((signal) => signal.id === sample.id) ? base.map((signal) => signal.id === sample.id ? sample : signal) : [...base, sample];
}

export function mergePointCheckSignals(previous: GatewayCheck | null, next: GatewayCheck, sample?: SignalResult) {
  const matches = previous?.cloak?.updatedAt === next.cloak?.updatedAt && previous?.report?.profile?.updatedAt === next.report?.profile?.updatedAt;
  const preserved = nativeClientSignals(previous?.signals ?? [], matches);
  if (!sample) return preserved.length ? preserved : next.signals;
  const refreshed = next.signals.filter((signal) => next.report?.testedSignals?.includes(signal.id));
  return [...refreshed, sample].reduce((signals, signal) => mergePointSignals(signals, signal, next.signals), preserved);
}
