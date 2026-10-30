import { detectionConfig } from "./config";
import { measurementPoints } from "./measurement-status";
import type { SignalResult } from "./types";

export function environmentScores(browser: SignalResult[] | null, claude: SignalResult[] | null) {
  const ids = Object.entries(detectionConfig.signals).filter(([, config]) => config.enabled).map(([id]) => id);
  const total = (left: SignalResult[] | null, right: SignalResult[] | null) => Math.min(100, ids.reduce((sum, id) => sum + measurementPoints(id, left?.find(signal => signal.id === id), right?.find(signal => signal.id === id)), 0));
  // Keep known anomaly points, but zero requires evidence for every applicable scoring rule.
  const sideScore = (samples: SignalResult[] | null, side: "browser" | "claude") => {
    if (samples === null) return null;
    const score = side === "browser" ? total(samples, null) : total(null, samples);
    if (score > 0) return score;
    const complete = ids.filter(id => detectionConfig.signals[id].weight > 0 && detectionConfig.signals[id].environment !== (side === "browser" ? "claude" : "browser")).every(id => {
      const sample = samples.find(signal => signal.id === id);
      return sample?.assessment === "not_applicable" || Boolean(sample?.testedAt && sample.value && (sample.assessment === "ok" || sample.assessment === "warning"));
    });
    return complete ? 0 : null;
  };
  const browserScore = sideScore(browser, "browser");
  const claudeScore = sideScore(claude, "claude");
  return {
    browser: browserScore,
    claude: claudeScore,
    combined: total(browser, claude) > 0 ? total(browser, claude) : browserScore === 0 && claudeScore === 0 ? 0 : null,
  };
}

export function comparisonEvidence(browser?: SignalResult, claude?: SignalResult, missingValues: readonly string[] = []) {
  if (browser?.assessment === "not_applicable" || claude?.assessment === "not_applicable") return "not_applicable";
  const unavailable = (signal?: SignalResult) => !signal?.value || missingValues.includes(signal.value) || signal.assessment === "unknown" || signal.assessment === "error";
  if (unavailable(browser) || unavailable(claude)) return "unknown";
  if (claude?.cloaked) return "rewritten";
  return browser?.value === claude?.value ? "same" : "different";
}

export type OptimizationEvidence = "none" | "optimized" | "pending" | "not_applicable" | "unattributed" | "not_improved" | "unknown";

export function signalOptimization(browser: SignalResult | undefined, claude: SignalResult | undefined, enabled: boolean, verified: boolean): OptimizationEvidence {
  if (!browser || !(browser.contribution > 0) || browser.assessment === "unknown" || browser.assessment === "not_applicable") return "none";
  if (claude?.assessment === "not_applicable") return "not_applicable";
  const rewritable = ["language", "languageVariant", "locale"].includes(browser.id);
  if (enabled && rewritable && !verified) return "pending";
  if (claude && claude.contribution > 0 && claude.assessment !== "unknown") return "not_improved";
  if (!claude?.value || claude.assessment !== "ok") return "unknown";
  if (rewritable && enabled && verified && claude.cloaked && claude.contribution === 0) return "optimized";
  return "unattributed";
}

// A configuration switch or a preview is not evidence of a successful rewritten request.
export function verifiedOptimization(check: import("./gateway-check").GatewayCheck | null, live: import("./gateway-check").CloakState | null) {
  if (!live?.enabled || !check?.verifiedRequest || !check.cloak?.enabled || live.updatedAt !== check.cloak.updatedAt) return false;
  if (!live.target?.updatedAt || live.target.updatedAt !== check.report?.lastRequest?.profileUpdatedAt) return false;
  const startedAt = Date.parse(check.report?.lastRequest?.startedAt ?? "");
  const changedAt = live.updatedAt === null ? 0 : Date.parse(live.updatedAt);
  return Number.isFinite(startedAt) && Number.isFinite(changedAt) && startedAt >= changedAt;
}
