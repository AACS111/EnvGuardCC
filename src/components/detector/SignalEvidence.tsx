import type { SignalResult } from "@/detection/types";
import type { LocaleCode } from "@/i18n/messages";

function evidenceCopy(locale: LocaleCode) {
  if (locale.startsWith("zh")) return {
    legend: "标识说明", browser: "仍有加分", measured: "网关改写后通过", neutral: "未测得 / 不适用",
    description: "右上分数依次对应浏览器 / 客户端，仅显示适用侧图标。深绿色为适用侧均通过，浅绿色为网关改写后通过，红色为仍有加分；待测试或需复核的项目保留具体原因。",
  };
  if (locale === "ru") return {
    legend: "Обозначения", browser: "Баллы браузера", measured: "0 баллов / симуляция пройдена", neutral: "Нет данных / неприменимо",
    description: "+0: измерено без баллов; нет данных: результата пока нет; неприменимо: шлюз не проверяет этот пункт. Зелёный фон означает ноль баллов или пройденную симуляцию. Баллы браузера показаны отдельно.",
  };
  return {
    legend: "Legend", browser: "Original browser points", measured: "Measured zero / simulation passed", neutral: "Pending / not applicable",
    description: "+0: measured with no added points; Pending: no result yet; N/A: not checked by the gateway. Pale green marks measured zero points or a passed simulation. Original browser points remain separate.",
  };
}

export function SignalEvidence({ browser, locale }: { browser?: SignalResult; locale: LocaleCode }) {
  if (!browser || browser.contribution <= 0 || browser.assessment === "unknown" || browser.assessment === "not_applicable") return null;
  return <span className="signal-evidence" data-signal-id={browser.id}>
    <span className="signal-status signal-status--flagged">{evidenceCopy(locale).browser} +{browser.contribution}</span>
  </span>;
}

export function SignalEvidenceLegend({ locale }: { locale: LocaleCode }) {
  const copy = evidenceCopy(locale);
  return <div className="signal-evidence-legend">
    <div><span>{copy.legend}</span><span className="signal-status signal-status--native">{locale.startsWith("zh") ? "原生通过" : "Native pass"}</span><span className="signal-status signal-status--flagged">{copy.browser}</span><span className="signal-status signal-status--verified">{copy.measured}</span><span className="signal-status signal-status--neutral">{copy.neutral}</span></div>
    <p>{copy.description}</p>
  </div>;
}
