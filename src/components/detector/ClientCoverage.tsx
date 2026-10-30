import { clientCoverage, signalPolicyCopy } from "@/detection/signal-policy";
import type { SignalResult } from "@/detection/types";
import type { LocaleCode } from "@/i18n/messages";

export function ClientCoverage({ signals, proxy, locale, onSelect }: { signals: SignalResult[]; proxy?: { mode: string; address: string | null }; locale: LocaleCode; onSelect: (id: string) => void }) {
  if (!signals.length) return null;
  const zh = locale.startsWith("zh");
  const coverage = clientCoverage(signals);
  return <section className="client-coverage" aria-label={zh ? "客户端检测覆盖" : "Client detection coverage"}>
    <strong>{zh ? "客户端检测" : "Client checks"}</strong>
    <span>{zh ? `${coverage.measured}/${coverage.total} 项有判定 · ${coverage.risks.length} 项加分 · ${coverage.pending.length} 项未执行 · ${coverage.limited.length} 项证据不足 · ${coverage.failed.length} 项失败` : `${coverage.measured}/${coverage.total} assessed · ${coverage.risks.length} flagged · ${coverage.pending.length} not run · ${coverage.limited.length} limited · ${coverage.failed.length} failed`}</span>
    {proxy && <span>{proxy.mode === "http-connect" ? `${zh ? "经代理" : "Via proxy"} ${proxy.address}` : zh ? "网关直连（系统 TUN 路由另计）" : "Gateway direct (system TUN may still route traffic)"}</span>}
    {coverage.risks.length > 0 && <ul>{coverage.risks.map((signal) => <li key={signal.id}><button type="button" onClick={() => onSelect(signal.id)}>{signal.label} +{signal.contribution} · {signalPolicyCopy(signal.id, locale).treatmentLabel}</button></li>)}</ul>}
    {coverage.unknown.length > 0 && <p>{zh ? "已执行但缺少数据的项目显示最终原因；未执行项需运行测试。模拟通过不会清除网络出口加分。" : "Completed checks with missing data show their final reason; unrun checks need a test. Simulation does not clear egress risk points."}</p>}
  </section>;
}
