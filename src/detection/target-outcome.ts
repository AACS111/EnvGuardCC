import type { SignalResult } from "./types";
import type { RepairTarget } from "./repair-target";
import { repairChoices, repairValueMatches } from "./repair-options";
import { signalResultStatus } from "./card-evidence";

// Compare the observed option semantics, never copy a saved target into samples.
export function targetOutcome(signal: SignalResult | undefined, target: RepairTarget) {
  const status = signalResultStatus(signal);
  if (status === "pending" || status === "running" || status === "inapplicable" || status === "failed") return status;
  if (status !== "measured") return "limited";
  const current = repairChoices(signal!).find((choice) => choice.id === target.id && choice.value === target.value);
  return current?.current || repairValueMatches(signal!.id, target.value, signal!.value ?? "") ? "matched" : "mismatch";
}

export function targetOutcomeLabel(signal: SignalResult | undefined, target: RepairTarget, zh: boolean) {
  const labels = {
    pending: ["尚未测试", "Not tested"], running: ["测试中", "Testing"],
    inapplicable: ["不适用", "N/A"], failed: ["测试失败", "Test failed"],
    limited: ["已测 · 证据不足，无法确认目标", "Tested · insufficient evidence to verify target"],
    matched: ["已达到目标", "Target reached"], mismatch: ["未达到目标 · 当前实测值不同", "Target not reached · observed value differs"],
  };
  return labels[targetOutcome(signal, target)][zh ? 0 : 1];
}
