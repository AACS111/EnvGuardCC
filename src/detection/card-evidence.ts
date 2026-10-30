import type { SignalResult } from "./types";
import { signalPolicy } from "./signal-policy";
import { measurementAbnormal } from "./measurement-status";
import { verificationItem, verificationPassed } from "./verification-score";

export function signalResultStatus(signal?: SignalResult & { state?: string }) {
  if (!signal || signal.state === "pending") return "pending";
  if (signal.state === "running") return "running";
  if (signal.assessment === "not_applicable") return "inapplicable";
  if (signal.assessment === "error" && (signal.contribution === 0 || /Reachability$|^dns/.test(signal.id))) return "failed";
  if (signal.testedAt && signal.assessment === "unknown") return signal.observation === "unavailable" || !signal.value || /^(未测得|Not measured)$/.test(signal.value) ? "unavailable" : "inconclusive";
  if (!signal.value || /^(未测得|未检测|Not measured|Not checked)$|等待真实|Awaiting a real/i.test(signal.value)) return "pending";
  if (signal.observation) return signal.observation;
  return measuredSignal(signal) ? "measured" : "review";
}

export function signalScoreLabel(signal: (SignalResult & { state?: string }) | undefined, zh: boolean) {
  const status = signalResultStatus(signal);
  if (status === "measured") return String(signal!.contribution);
  const labels = {
    pending: ["待测试", "Not tested"], running: ["测试中", "Testing"],
    review: ["证据不足", "Limited evidence"], unavailable: ["已测·无数据", "Tested · no data"],
    inconclusive: ["无法判定", "Inconclusive"],
    failed: ["测试失败", "Failed"], inapplicable: ["不适用", "N/A"],
  };
  return labels[status][zh ? 0 : 1];
}

export function measuredSignal(signal?: SignalResult) {
  return Boolean(signal?.value && !/^(未测得|未检测|Not measured|Not checked)$/.test(signal.value) && signal.assessment !== "unknown" && signal.assessment !== "not_applicable" && !(signal.assessment === "error" && signal.contribution === 0));
}

export function cardEvidence(id: string, browser?: SignalResult, client?: SignalResult) {
  const { scope } = signalPolicy(id);
  const sides = [scope !== "claude" ? browser : undefined, scope !== "browser" ? client : undefined].filter((side): side is SignalResult => Boolean(side));
  const expected = scope === "both" ? 2 : 1;
  const clientPassed = verificationPassed(client);
  const gatewayPassed = scope !== "browser" && clientPassed && client?.cloaked === true;
  const flagged = sides.some(measurementAbnormal) || verificationItem(id, browser, client) === "failed";
  const allPassed = verificationItem(id, browser, client) === "passed";
  const browserProtected = scope !== "claude" && browser?.cloaked === true && allPassed;
  const inapplicable = sides.length === expected && sides.every((side) => side.assessment === "not_applicable");
  const state: "flagged" | "simulated" | "measured" | "inapplicable" | "pending" = flagged ? "flagged" : allPassed ? gatewayPassed || browserProtected ? "simulated" : "measured" : inapplicable ? "inapplicable" : "pending";
  return { scope, state, gatewayPassed, browserProtected, allPassed };
}
