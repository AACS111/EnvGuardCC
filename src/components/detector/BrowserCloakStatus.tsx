import type { BrowserCloakExecution } from "@/detection/environment-runtime";
import type { LocaleCode } from "@/i18n/messages";

export function BrowserCloakStatus({ report, locale }: { report: BrowserCloakExecution | null; locale: LocaleCode }) {
  const zh = locale.startsWith("zh");
  const browser = report?.results.find((item) => item.target === "web");
  const failed = report?.results.find((item) => item.state === "failed");
  const verified = !failed && report?.enabled && browser?.state === "verified" && report.requestProbe?.state === "verified";
  const status = !report ? (zh ? "未跟随网关，请点击接入并验证浏览器。" : "Not linked; connect and verify the browser.")
    : failed ? (zh ? "同步或执行失败。" : "Synchronization or execution failed.")
    : !report.enabled ? (zh ? "已关闭；请核对各端恢复结果。" : "Off; check restoration results.")
    : verified ? (zh ? "受控 Claude 页面接口与实际请求语言头均已验证。" : "Managed Claude interfaces and request language verified.")
    : (zh ? "已尝试接入，外部页面或请求头尚未完整验证。" : "Connection attempted; external pages or request headers remain unverified.");
  const detail = failed?.detail ?? (browser?.state !== "verified" ? browser?.detail : undefined);
  return <p className="repair-description" role="status" data-browser-cloak={verified ? "verified" : report?.enabled ? "unverified" : "off"}>
    <strong>{zh ? "浏览器模拟保护：" : "Browser cloak: "}</strong>{status}
    {report?.requestProbe?.receivedLanguage && ` · Accept-Language: ${report.requestProbe.receivedLanguage}`}
    {detail && ` · ${detail}`}
    {report?.requestProbe?.sampledAt && <span> · {zh ? "上次请求头验证：" : "Last header probe: "}{report.requestProbe.sampledAt}</span>}
  </p>;
}
