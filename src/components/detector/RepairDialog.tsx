"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { SignalView } from "@/detection/client-engine";
import type { ExitTarget } from "@/detection/exit-geo";
import { helperRequest, type HelperSession } from "@/detection/local-helper";
import { signalPolicy } from "@/detection/signal-policy";
import type { RepairChoice } from "@/detection/repair-options";
import { verificationLabel as signalScoreLabel, verificationSampleStatus } from "@/detection/verification-score";
import { saveRepairTarget } from "@/detection/repair-target";
import { notifyRepairTargetChange, useRepairTarget } from "@/detection/use-repair-target";
import { previewTotal, repairChoices } from "@/detection/repair-options";
import { targetOutcome, targetOutcomeLabel } from "@/detection/target-outcome";
import { choiceRuntimePolicy } from "@/detection/environment-actions";
import { applyEnvironment, type EnvironmentExecution } from "@/detection/environment-runtime";
import type { LocaleCode } from "@/i18n/messages";

type Session = HelperSession;

export function isDialogBackdropEvent(event: Pick<MouseEvent<HTMLDialogElement>, "target" | "currentTarget" | "clientX" | "clientY">) {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

export function RepairDialog({ signal, browser, claude, signals, locale, loading, target, protectionEnabled, onClose, onRecheck, onRuntimeRecheck, onApplyGateway }: {
  signal: SignalView; browser?: SignalView; claude?: SignalView; onApplyGateway: (choice: RepairChoice) => Promise<void>; signals: SignalView[]; locale: LocaleCode; loading: boolean; target?: ExitTarget | null; protectionEnabled?: boolean;
  onClose: () => void; onRecheck: () => Promise<void>; onRuntimeRecheck?: () => Promise<void>;
}) {
  const zh = locale.startsWith("zh");
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connection, setConnection] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [execution, setExecution] = useState<EnvironmentExecution | null>(null);
  const savedTarget = useRepairTarget(signal.id);
  const choices = useMemo(() => repairChoices(signal, target, session?.platform), [signal, target, session?.platform]);
  const savedChoice = choices.find((choice) => choice.id === savedTarget?.id && choice.value === savedTarget.value);
  const observationOnly = choices.every((choice) => choice.action === "information" && !choiceRuntimePolicy(signal.id, choice));
  const selected = observationOnly ? choices.find((choice) => choice.current) : choices.find((choice) => choice.id === selectedId) ?? savedChoice ?? choices.find((choice) => choice.match === "target") ?? choices.find((choice) => choice.current);
  const runtimeChoice = choiceRuntimePolicy(signal.id, selected);
  const runtimeSignal = ["chineseFonts", "vendorFonts", "language", "languageVariant", "locale", "webrtcLeak"].includes(signal.id);
  const policy = signalPolicy(signal.id);
  const navigationUrl = ({ claudeReachability: "https://claude.ai/", claudeAccessRisk: "https://claude.ai/", anthropicReachability: "https://www.anthropic.com/", apiReachability: "https://api.anthropic.com/v1/models" } as Record<string, string>)[signal.id];
  const isTimezone = signal.id === "timezone" || signal.id === "timezoneOffset";
  const isLanguage = signal.id === "language" || signal.id === "languageVariant";
  const isLocale = signal.id === "locale";
  const readOnly = !isTimezone && !isLanguage && !isLocale;
  const locked = busy || loading;

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; element?.close(); previousFocus?.focus(); };
  }, []);

  useEffect(() => {
    if (!isTimezone) return;
    let cancelled = false;
    helperRequest("/session").then((result: Session) => {
      if (!cancelled) { setSession(result); setConnection(result.capabilities?.timezoneWrite ? "ready" : "unsupported"); }
    }).catch(() => { if (!cancelled) setConnection("offline"); });
    return () => { cancelled = true; };
  }, [isTimezone]);

  const explain = navigationUrl
    ? zh ? "此项分别显示浏览器跨站脚本探测和网关出口探测。可先打开网站人工核对，再按需要重新探测；脚本未完成时保留无法判定，实际出口国家风险仍单独计分。" : "Browser cross-site probing and gateway egress probing are shown separately. Open the site to check navigation, then retry if needed. Incomplete script probes remain inconclusive; actual exit-country risks are assessed separately."
    : runtimeSignal
    ? zh ? "可执行选项会调用本机脚本：在当前检测页面以及启动器接入的独立浏览器、Claude 桌面渲染页面屏蔽指定接口，再读取采样结果。桌面端不支持脚本接入或尚未打开目标页面时，会单独显示未验证或失败。不会卸载系统字体，也不保证覆盖所有指纹检测方式。" : "Executable options apply renderer-interface protection to this page and managed browser/desktop pages, then verify observations. Unsupported desktop access or missing target pages are reported separately. System fonts are not removed; not all fingerprint methods are covered."
    : policy.treatment === "network"
    ? zh ? "此项来自实际网络采样。更换 FlClash 节点或调整分流后，点击原生测试核对结果；以下选项仅展示实测配置，已禁用修改。" : "This signal samples the network. Change FlClash routing or node, then run its native test. The disabled options show the observed configuration."
    : policy.treatment === "gateway"
    ? zh ? "浏览器原始配置与客户端网关配置分别采样。选择单一语言或区域后可应用到网关，再发送当前项目的模拟消息验证接收值。" : "Browser and gateway values are sampled separately. Apply a single language or locale to the gateway and verify it with a local simulated message."
    : isTimezone
    ? zh ? "系统时区和 UTC 偏移来自实际系统设置，修改会影响本机其他应用。关联项一起预估，复检继续读取真实值。Windows 的香港时区与上海共用映射，因此按实际映射计分。" : "Timezone changes affect other applications. The preview includes the linked UTC offset. Windows maps Hong Kong and Shanghai to the same zone, so the preview uses the actual Windows mapping."
    : isLanguage
      ? zh ? "读取 navigator.languages；只要列表仍包含中文，增加英语首选项也可能继续加分。语言文字特征与此项联动；Intl 的变化需要单独复检。" : "The rule reads navigator.languages. Keeping Chinese anywhere in the list can still add points. Language-variant points are linked; Intl must be rechecked separately."
      : isLocale
        ? zh ? "读取 Intl 默认区域设置。网页不能直接改写浏览器配置；请在语言设置中应用实际需要的区域，重启浏览器后复检。" : "This reads the default Intl locale. Apply the intended region in browser/system language settings, restart the browser, then recheck."
        : signal.id === "emojiStyle"
          ? zh ? "此项根据 User-Agent 推断操作系统，没有检测 Emoji 渲染。Windows / Android 计 2 分，Apple 计 1 分；没有可用于一键修复的 0 分系统选项。" : "This infers the OS from User-Agent, without measuring emoji rendering. Windows / Android add 2 points and Apple adds 1. There is no genuine zero-point OS option here."
          : zh ? "这是字体、浏览器或设备特征，下面列出不同真实环境的规则分数用于比较。网页不能替换设备或卸载字体，不会通过修改检测结果将其标为正常。" : "These are real font, browser or device characteristics. Options compare rule scores for different environments; a website cannot replace a device or remove system fonts.";

  const report = (text: string, error = false) => { setMessage(text); setFailed(error); };
  const applyTimezone = async (restore = false) => {
    if (!session?.capabilities?.timezoneWrite || (!restore && selected?.action !== "timezone")) return;
    setBusy(true);
    report(zh ? "正在修改系统时区…" : "Updating system timezone…");
    try {
      const result = await helperRequest(restore ? "/timezone/restore" : "/timezone", session.token, restore ? {} : { timezone: session.capabilities?.timezoneFormat === "iana" ? selected?.value : selected?.windowsTimezone });
      setSession({ ...session, timezone: result.timezone, canRestore: result.canRestore });
      if (!restore && selected) { saveRepairTarget(window.localStorage, signal.id, selected); notifyRepairTargetChange(); }
      report(zh ? `系统时区已设为 ${result.timezone}，正在复检…` : `System timezone set to ${result.timezone}. Rechecking…`);
      await (onRuntimeRecheck ?? onRecheck)();
      report(zh ? "系统时区已修改，已重新采样。请对照当前实测值；浏览器尚未更新时可重启后复检。" : "System timezone changed and samples refreshed. Check the measured value; restart the browser if it has cached the old timezone.");
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  };
  const applyGateway = async () => {
    if (!selected || locked) return;
    setBusy(true);
    report(zh ? "正在应用网关配置并测试此项…" : "Applying gateway configuration and testing…");
    try {
      saveRepairTarget(window.localStorage, signal.id, selected); notifyRepairTargetChange();
      await onApplyGateway(selected);
      report(zh ? "网关配置已应用，模拟消息测试已完成。各端是否达到目标见实测结果。" : "Gateway configuration applied and simulation completed. See each side's measured target outcome.");
    }
    catch (error) { report(error instanceof Error ? error.message : String(error), true); }
    finally { setBusy(false); }
  };

  const confirmTarget = async () => {
    if (!selected || selected.action !== "information" || locked) return;
    setBusy(true);
    let saved = false;
    try {
      saveRepairTarget(window.localStorage, signal.id, selected);
      saved = true;
      notifyRepairTargetChange();
      report(zh ? "目标已保存，正在复测当前实际配置…" : "Target saved; retesting the actual configuration…");
      await onRecheck();
      report(zh ? "目标已保存，复测已完成，请核对当前实测结果。目标仅保存在此浏览器，实际网络或设备配置需在对应应用中调整。" : "Target saved and retested. Check the measured result. The target is stored in this browser; apply network or device changes in the relevant app.");
    } catch (error) {
      report(`${zh ? (saved ? "目标已保存，但复测失败：" : "无法保存目标，未开始复测：") : (saved ? "Target saved, but retest failed: " : "Could not save target; test not started: ")}${error instanceof Error ? error.message : String(error)}`, true);
    } finally { setBusy(false); }
  };

  const applyScripts = async () => {
    const restore = false;
    if (locked || (!restore && (!runtimeChoice || !selected))) return;
    setBusy(true); report(zh ? "正在执行环境脚本并分别验证各端…" : "Applying scripts and verifying each environment…");
    try {
      if (!restore && selected) { saveRepairTarget(window.localStorage, signal.id, selected); notifyRepairTargetChange(); }
      if (!restore && policy.treatment === "gateway" && selected && !selected.value.includes(",")) await onApplyGateway(selected);
      const result = await applyEnvironment(runtimeChoice!);
      if (!restore && policy.treatment === "gateway" && selected) result.results.push({ target: "gateway", state: selected.value.includes(",") ? "unverified" : "verified", detail: selected.value.includes(",") ? "网关仅支持单一语言，本次语言列表仅应用于浏览器接口，网关未修改。" : "网关配置已应用并通过当前检测项的模拟消息验证。", pages: 1 });
      setExecution(result);
      if (!restore && selected && result.results.some((item) => item.target === "local" && item.state === "verified")) {
        saveRepairTarget(window.localStorage, signal.id, selected); notifyRepairTargetChange();
      }
      await (onRuntimeRecheck ?? onRecheck)();
      const incomplete = result.results.some((item) => item.state !== "verified" && item.state !== "restored");
      report(zh ? incomplete ? "执行已结束，部分环境未通过验证，原因见各端报告。当前卡片使用重新采样的实际值。" : "脚本执行及指定接口验证完成，当前卡片已重新采样。" : incomplete ? "Some environments remain unverified; see individual reports. Cards use fresh observations." : "Scripts and interface verification completed; cards refreshed.", incomplete);
    } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
    finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} className="repair-dialog" aria-labelledby="repair-title" aria-describedby="repair-description"
      onPointerDown={(event) => { backdropPointerDown.current = !locked && isDialogBackdropEvent(event); }}
      onClick={(event) => { const dismiss = backdropPointerDown.current && !locked && isDialogBackdropEvent(event); backdropPointerDown.current = false; if (dismiss) onClose(); }}
      onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}>
      <header className="repair-dialog__header">
        <div><p className="repair-caption">{zh ? "检测详情与处理" : "Signal details & actions"}</p><h2 id="repair-title">{signal.label}</h2></div>
        <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={locked} aria-label={zh ? "关闭配置" : "Close configuration"}>{"×"}</button>
      </header>
      <div className="repair-dialog__body">
        <div className="repair-measured"><div><span>{zh ? "当前实测值" : "Measured value"}</span><strong>{loading ? zh ? "复检中…" : "Rechecking…" : signal.value}</strong></div><strong className="repair-points" data-score-state={verificationSampleStatus(signal) === "passed" ? "pass" : verificationSampleStatus(signal) === "failed" ? "flagged" : "pending"}>{loading ? "…" : signalScoreLabel(signal, zh)}</strong></div>
        {browser && policy.scope !== "claude" && <p className="repair-description"><strong>{zh ? "浏览器当前配置：" : "Current browser: "}</strong>{browser.value} · {signalScoreLabel(browser, zh)}</p>}
        {claude && policy.scope !== "browser" && <p className="repair-description"><strong>{zh ? "客户端当前配置：" : "Current client: "}</strong>{claude.value} · {signalScoreLabel(claude, zh)}</p>}
        {claude?.cloaked && claude.originalValue && <p className="repair-description"><strong>{zh ? "原始请求 / 网关配置：" : "Original request / gateway: "}</strong>{claude.originalValue} / {claude.value}</p>}
        {signal.detail && <p className="repair-description">{signal.detail}</p>}
        {!protectionEnabled && <p className="repair-notice">{zh ? "模拟保护未启动，本次仅重测当前环境。启动模拟保护后可应用配置。" : "Protection is off; this action only retests. Start protection to apply changes."}</p>}
        <p id="repair-description" className="repair-description">{explain}</p>
        {navigationUrl && <p className="repair-notice">{zh ? "浏览器跨站脚本探测与正常打开网站是两种访问方式。网站能打开但脚本请求未完成时，浏览器侧显示无法判定，不因该失败加分；网关收到 HTTP 响应的结果独立保留。" : "Cross-site script probes and normal site navigation differ. If navigation works but the script cannot complete, browser reachability remains inconclusive without added risk points. Gateway HTTP-response evidence remains separate."}</p>}
        <p className="repair-notice">{zh ? "按原站对应权重计分：通过得满分，未测试或证据不足暂计半分，未通过或检测失败计0分；不适用项不计分。选择目标不改变实测状态，复检后更新得分。" : "Reference weights: full credit for passed items, provisional half credit for untested or unresolved items, and zero for failures. Inapplicable items earn no credit. Choosing a target does not change observations; recheck to update the score."}</p>
        {choices.length > 0 ? <fieldset className="repair-options" disabled={locked || observationOnly}>
          <legend>{observationOnly ? (zh ? "当前实测配置 · 此项无法在页面修改" : "Observed configuration · cannot be changed here") : target ? (zh ? `选择目标设置 · 优先与出口地区（${target.city ?? target.countryName}）一致的选项` : `Choose a target · exit-consistent options (${target.city ?? target.countryName}) first`) : zh ? "选择目标设置 · 符合条件的选项优先" : "Choose a target · matching options first"}</legend>
          {choices.map((choice) => <label key={choice.id} className={`repair-option${selected?.id === choice.id ? " repair-option--selected" : ""}`}>
            <input type="radio" name="repair-choice" value={choice.id} checked={selected?.id === choice.id} onChange={() => { setSelectedId(choice.id); report(""); }} />
            <span className="repair-option__value">{choice.label}{choice.match === "target" && <span className="repair-option__target">{zh ? "与出口一致" : "Matches exit"}</span>}{policy.scope !== "claude" && targetOutcome(browser ?? (signal.environment === "browser" ? signal : undefined), choice) === "matched" && <small className="repair-option__current">{zh ? "当前浏览器配置" : "Current browser"}</small>}{policy.scope !== "browser" && targetOutcome(claude ?? (signal.environment === "claude" ? signal : undefined), choice) === "matched" && <small className="repair-option__current">{zh ? "当前客户端配置" : "Current client"}</small>}{choice.action === "information" && !choice.current && <span className="repair-option__target">{choiceRuntimePolicy(signal.id, choice) ? (zh ? "可执行·接口屏蔽" : "Executable · interface protection") : (zh ? "仅比较" : "Compare only")}</span>}</span>
            <span className="repair-option__score">{choice.contribution === 0 ? (zh ? "符合条件 · 待实测" : "Matches · unverified") : (zh ? "不符合条件" : "Does not match")}</span>
          </label>)}
        </fieldset> : <p className="repair-notice">{zh ? "此项暂无可执行的设置选项。" : "No executable settings are available for this signal."}</p>}
        {!observationOnly && savedTarget && <div className="repair-notice" role="status"><strong>{zh ? "处理目标：" : "Treatment target: "}</strong>{savedTarget.label}
          {policy.scope !== "claude" && <p>{zh ? "浏览器：" : "Browser: "}{targetOutcomeLabel(browser ?? (signal.environment === "browser" ? signal : undefined), savedTarget, zh)}</p>}
          {policy.scope !== "browser" && <p>{zh ? "客户端：" : "Client: "}{targetOutcomeLabel(claude ?? (signal.environment === "claude" ? signal : undefined), savedTarget, zh)}</p>}
        </div>}
        {!observationOnly && selected && !loading && <div className="repair-preview" aria-live="polite">
          <div><span>{zh ? "采用此选项后，预计剩余风险" : "Estimated remaining risk with this option"}</span><strong>{previewTotal(signals, selected)} / 100</strong></div>
          <p>{zh ? "该风险预估越低越好，仅供选项比较，不计入验证得分。未测试暂计半分，执行并复检后更新实际得分。" : "Lower estimated risk is better. This estimate is for comparison and earns no verification credit. Apply and recheck to earn passing points."}</p>
        </div>}
        {isTimezone && <p className="repair-description" role="status">{connection === "checking" ? zh ? "正在连接本机助手…" : "Connecting to local helper…" : connection === "ready" ? `${zh ? "本机助手已连接，系统时区：" : "Local helper connected. System timezone: "}${session?.timezone}` : zh ? "本机助手未连接或当前系统不支持自动修改。请检查连接后重试，或在系统的日期与时间设置中调整。" : "Local helper unavailable or automatic changes unsupported. Check the connection and retry, or use system Date & Time settings."}</p>}
        {readOnly && !runtimeSignal && <p className="repair-description">{zh ? (policy.treatment === "network" ? "请在 FlClash 中实际调整节点或规则后测试；页面选项为只读。" : "此项为实际设备特征或观测数据，没有可可靠自动执行的修改脚本。") : "This observation has no reliable automatic change script. Apply actual network or device changes before retesting."}</p>}
        {execution && <div className="repair-notice" aria-live="polite"><strong>{zh ? "各端脚本执行报告" : "Execution by environment"}</strong>{execution.results.map((item) => <p key={item.target}><strong>{({ local: zh ? "当前检测浏览器" : "Current browser", web: zh ? "独立 Claude 网页窗口" : "Managed Claude browser", desktop: zh ? "Claude 桌面端" : "Claude desktop", remote: zh ? "外部环境" : "External environments", gateway: zh ? "Claude 网关" : "Claude gateway" } as Record<string, string>)[item.target] ?? item.target}：{item.state === "verified" ? zh ? "指定接口已验证" : "Interfaces verified" : item.state === "restored" ? zh ? "已恢复" : "Restored" : item.state === "failed" ? zh ? "执行失败" : "Failed" : zh ? "待验证" : "Unverified"}</strong> · {item.detail}</p>)}</div>}
        {message && <p className={`repair-feedback${failed ? " repair-feedback--error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
      </div>
      <footer className="repair-dialog__footer">
        {isTimezone && session?.canRestore && <button type="button" className="repair-button" disabled={locked || connection !== "ready"} onClick={() => void applyTimezone(true)}>{zh ? "恢复原始系统时区" : "Restore original system timezone"}</button>}
        <button type="button" className="repair-button repair-button--primary" disabled={locked || (isTimezone && connection !== "ready")} onClick={() => {
          if (isTimezone && selected?.action === "timezone" && connection === "ready") void applyTimezone();
          else if (observationOnly || !protectionEnabled || !selected) { setBusy(true); report(""); void onRecheck().then(() => report(zh ? "已完成当前环境重测。" : "Environment retested.")).catch((error) => report(String(error), true)).finally(() => setBusy(false)); }
          else if (isTimezone && selected.action === "timezone") void applyTimezone();
          else if (runtimeChoice) void applyScripts();
          else if (policy.treatment === "gateway" && selected.action !== "information") void applyGateway();
          else void confirmTarget();
        }}>{locked ? (zh ? "执行中…" : "Working…") : isTimezone ? (zh ? "设置系统时区并复检" : "Set system timezone & recheck") : observationOnly ? (zh ? "重新检测" : "Retest") : (zh ? "确认并重测" : "Confirm & retest")}</button>
      </footer>
    </dialog>
  );
}
