import { signalPolicy } from "@/detection/signal-policy";
import type { SimulationJob } from "@/detection/simulation";
import type { LocaleCode } from "@/i18n/messages";

function simulationCopy(locale: LocaleCode) {
  const zh = locale.startsWith("zh");
  return zh ? {
    title: "优化自检", idle: "尚未执行模拟请求", running: "模拟请求执行中", passed: "模拟请求已通过", failed: "模拟请求未通过", stale: "配置已变更，请重新自检", unknown: "自检连接异常 · 状态待确认",
    details: "查看逐项测试结果", pending: "待执行", pass: "通过", fail: "失败",
    scope: "覆盖消息协议、请求头、SSE流式、错误返回、重试与取消。TLS、真实出口、账号权限及服务端风控仍需实测；自检通过不保证账号安全。",
    covered: "模拟请求已通过", uncovered: "模拟未覆盖", staleShort: "自检已过期", moduleRunning: "模拟请求执行中", moduleFailed: "模拟请求未通过",
  } : {
    title: "Optimization self-test", idle: "Local self-test not run", running: "Local self-test running", passed: "Simulated requests passed", failed: "Local self-test failed", stale: "Configuration changed; rerun self-test", unknown: "Connection interrupted · status unknown",
    details: "Test scenario results", pending: "Pending", pass: "Passed", fail: "Failed",
    scope: "Covers message protocol, headers, SSE, errors, retries and cancellation. Real TLS, egress, account permissions and server decisions need separate verification. Passing is not an account-safety guarantee.",
    covered: "Simulation passed", uncovered: "Not covered locally", staleShort: "Self-test stale", moduleRunning: "Local checks running", moduleFailed: "Local checks failed",
  };
}

export function SimulationBadge({ job, signalId, busy, locale }: { job: SimulationJob | null; signalId: string; busy: boolean; locale: LocaleCode }) {
  if (!job && !busy || job?.state === "idle" && !busy) return null;
  const copy = simulationCopy(locale);
  const result = job?.signalResults[signalId];
  const starting = busy && !job?.running;
  const needsLive = signalPolicy(signalId).treatment === "gateway" && !(job?.messageProbe?.viaLiveGateway && job.messageProbe.status === 200 && job.messageProbe.bodyUnchanged);
  const state = starting ? "running" : job?.state === "stale" ? "stale" : needsLive ? busy ? "running" : "uncovered" : !result ? "uncovered" : result.state;
  const label = state === "passed" ? copy.covered : state === "failed" ? copy.moduleFailed : state === "running" ? copy.moduleRunning : state === "stale" ? copy.staleShort : copy.uncovered;
  return <span className={`simulation-module simulation-module--${state}`} data-simulation-signal={signalId} data-simulation-state={state}>{label}{result && state === "running" ? ` ${starting ? 0 : result.completed}/${result.total}` : ""}</span>;
}

export function SimulationPanel({ job, busy, error, locale }: { job: SimulationJob | null; busy: boolean; error: string; locale: LocaleCode }) {
  const copy = simulationCopy(locale);
  if (!job && !busy && !error || job?.state === "idle" && !busy && !error) return null;
  const state = error ? "unknown" : busy ? "running" : job?.state ?? "idle";
  const starting = busy && !job?.running;
  return <section className="simulation-panel" aria-label={copy.title} aria-busy={busy} data-simulation-state={state}>
    <div className="simulation-panel__header">
      <strong>{copy.title}</strong>
      <span className={`simulation-module simulation-module--${state}`} role="status" aria-live="polite">{copy[state]}{job?.total ? ` · ${starting ? 0 : job.passed ?? 0}/${job.total}` : ""}</span>

      {job?.target && <span className="simulation-panel__target">{job.target.language} · {job.target.locale}</span>}
    </div>
    {job?.messageProbe && !busy && job.state !== "stale" && <p className="simulation-panel__proof">{locale.startsWith("zh") ? `模拟消息 POST /v1/messages · HTTP ${job.messageProbe.status} · 接收语言 ${job.messageProbe.receivedLanguage} · 接收区域 ${job.messageProbe.receivedLocale} · 正文${job.messageProbe.bodyUnchanged ? "保持一致" : "不一致"}` : `Simulated POST /v1/messages · HTTP ${job.messageProbe.status} · ${job.messageProbe.receivedLanguage} · ${job.messageProbe.receivedLocale} · body ${job.messageProbe.bodyUnchanged ? "unchanged" : "changed"}`}</p>}
    {busy && <progress aria-label={copy.running} max={job?.total ?? 13} value={starting ? 0 : job?.completed ?? 0} />}
    {error || job?.error ? <p className="simulation-panel__error" role="alert">{error || job?.error}</p> : null}
    <p>{copy.scope}</p>
    {job?.scenarios.length ? <details><summary>{copy.details}</summary><ol className="simulation-cases">{job.scenarios.map((item) => <li key={item.id}><span>{item.label}</span><span className={`simulation-module simulation-module--${item.state}`}>{item.state === "passed" ? copy.pass : item.state === "failed" ? copy.fail : copy.pending}</span></li>)}</ol></details> : null}
  </section>;
}
