"use client";

import type { SignalView } from "@/detection/client-engine";
import type { ExitTarget } from "@/detection/exit-geo";
import type { SimulationJob } from "@/detection/simulation";
import type { LocaleCode } from "@/i18n/messages";
import { cardEvidence, signalResultStatus } from "@/detection/card-evidence";
import { signalPolicy } from "@/detection/signal-policy";
import { verificationPoint, verificationLabel as signalScoreLabel } from "@/detection/verification-score";
import { EnvironmentIcon } from "./EnvironmentIcon";

export function SignalCard({ signal, browser, claude, locale, testing, detailLabel, onSelect }: {
  target?: ExitTarget | null; signal: SignalView; browser?: SignalView; claude?: SignalView; job: SimulationJob | null; simulationBusy: boolean; locale: LocaleCode;
  checking: boolean; testing?: boolean; detailLabel: string; onSelect: (id: string) => void; onTest?: (id: string) => Promise<void>;
}) {
  const zh = locale.startsWith("zh");
  const { scope } = signalPolicy(signal.id);
  const original = scope === "claude" ? undefined : browser ?? (signal.source === "browser" ? signal : undefined);
  const client = scope === "browser" ? undefined : claude ?? (signal.source === "gateway" ? signal : undefined);
  const evidence = cardEvidence(signal.id, original, client);
  const sides = [
    ...(scope !== "claude" ? [{ id: "browser", label: zh ? "浏览器" : "Browser", sample: original }] : []),
    ...(scope !== "browser" ? [{ id: "client", label: zh ? "客户端" : "Client", sample: client }] : []),
  ];
  const value = (sample?: SignalView) => {
    const status = signalResultStatus(sample);
    if (status === "inapplicable") return zh ? "不适用" : "Not applicable";
    if (status === "pending") return zh ? "未采样" : "Not sampled";
    if (status === "running") return zh ? "检测中…" : "Testing…";
    if (status === "unavailable") return zh ? "未返回数据" : "No data returned";
    if (status === "inconclusive" || status === "review") return zh ? "无法判定" : "Inconclusive";
    if (status === "failed") return sample?.value || (zh ? "检测失败" : "Test failed");
    return sample?.value || (zh ? "未判定" : "Unresolved");
  };
  const stateLabels = zh ? { measured: "原生通过", simulated: "保护后通过", flagged: "异常", pending: "未判定", inapplicable: "不适用" } : { measured: "Native pass", simulated: "Protected pass", flagged: "Flagged", pending: "Unresolved", inapplicable: "Not applicable" };
  return <article className="signal-card" aria-label={signal.label} data-signal-card={signal.id} data-signal-state={evidence.state} data-signal-scope={scope} aria-busy={testing || undefined}>
    <div className="signal-card__header">
      <strong title={signal.label}>{signal.label}</strong>
      <div className="signal-card__scores" aria-label={zh ? "浏览器 / 客户端通过得分" : "Browser / client verified points"}>
        {sides.map(({ id, label, sample }) => <span key={id} className="signal-card__side" data-environment={id} title={`${label} · ${signalScoreLabel(sample, zh, signal.id)}`}>
          <EnvironmentIcon client={id === "client"} label={label} /><b data-score-side={id === "client" ? "claude" : "browser"}>{verificationPoint(sample, signal.id) === null ? "—" : verificationPoint(sample, signal.id)! > 0 ? `+${verificationPoint(sample, signal.id)}` : "0"}</b>
        </span>)}
      </div>
    </div>
    <div className="signal-card__values">{sides.map(({ id, label, sample }) => <div key={id} className="signal-card__value-row" data-environment={id}><span className="signal-card__source"><EnvironmentIcon client={id === "client"} label={label} />{label}</span><p title={`${label}：${value(sample)}`}>{value(sample)}</p></div>)}</div>

    <footer className="signal-card__footer"><span className="signal-card__status">{stateLabels[evidence.state]}</span><button type="button" className="signal-card__action" aria-label={`${detailLabel}：${signal.label}`} onClick={() => onSelect(signal.id)} aria-haspopup="dialog">{detailLabel} →</button></footer>
  </article>;
}
