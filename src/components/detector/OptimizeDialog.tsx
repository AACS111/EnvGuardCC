"use client";

// EnvGuardCC 的一键优化面板，按当前网络出口地区推导每个检测项的最佳目标，并集中执行能自动完成的部分。
import { useEffect, useMemo, useRef, useState } from "react";
import type { CloakState } from "@/detection/gateway-check";
import type { SignalView } from "@/detection/client-engine";
import { buildExitTarget, exitTargetLabel, type ExitGeo } from "@/detection/exit-geo";
import { browserSettingsAddress, copyText, gatewayUrl, helperRequest, type HelperSession } from "@/detection/local-helper";
import { previewTotal, recommendedChoice, repairChoices } from "@/detection/repair-options";
import type { LocaleCode } from "@/i18n/messages";

type Row = {
  signal: SignalView;
  targetLabel: string;
  points: number;
  preview: number;
  auto: boolean;
  manual: boolean;
  gateway: boolean;
};

export function OptimizeDialog({ optimization, optimizationBusy, optimizationNotice, onToggleOptimization, onReconnectGateway, signals, locale, exitGeo, exitLoading, exitError, onRefreshExit, onRecheck, onOpenSignal, onClose }: {
  optimization: CloakState | null;
  optimizationBusy: boolean;
  optimizationNotice: string;
  onToggleOptimization: (enabled: boolean) => Promise<void>;
  onReconnectGateway: () => Promise<void>;
  signals: SignalView[];
  locale: LocaleCode;
  exitGeo: ExitGeo | null;
  exitLoading: boolean;
  exitError: string;
  onRefreshExit: () => Promise<void>;
  onRecheck: () => Promise<void>;
  onOpenSignal: (id: string) => void;
  onClose: () => void;
}) {
  const zh = locale.startsWith("zh");
  const dialog = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<HelperSession | null>(null);
  const [connection, setConnection] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [helperAttempt, setHelperAttempt] = useState(0);

  // 助手执行系统时区与浏览器接口保护；共享开关由父组件协调网关和浏览器。
  const timezoneSupported = session?.capabilities?.timezoneWrite === true;
  const working = busy || optimizationBusy;

  const target = useMemo(() => buildExitTarget(exitGeo), [exitGeo]);
  const exitLabel = exitTargetLabel(target);
  const rows = useMemo<Row[]>(() => signals.flatMap((signal) => {
    if (signal.state !== "done") return [];
    const choice = recommendedChoice(signal, target, session?.platform);
    if (!choice || choice.id === "current" || choice.contribution >= signal.contribution) return [];
    const auto = choice.action === "timezone" && timezoneSupported;
    const manual = choice.action === "language" || choice.action === "locale";
    // 语言与区域类可以通过网关层对齐，不需要修改本机环境。
    const gateway = choice.action === "language" || choice.action === "locale";
    return [{ signal, targetLabel: choice.label, points: choice.contribution, preview: previewTotal(signals, choice), auto, manual, gateway }];
  }), [signals, target, session?.platform, timezoneSupported]);
  const projected = useMemo(() => {
    const values = new Map(signals.filter((signal) => signal.state === "done").map((signal) => [signal.id, signal.contribution]));
    for (const row of rows) {
      const choice = recommendedChoice(row.signal, target, session?.platform);
      if (!choice) continue;
      for (const [id, contribution] of Object.entries(choice.impacts)) if (values.has(id)) values.set(id, contribution);
    }
    return Math.min(100, Array.from(values.values()).reduce((sum, value) => sum + value, 0));
  }, [rows, signals, target, session?.platform]);
  const timezoneTarget = rows.find((row) => row.signal.id === "timezone" || row.signal.id === "timezoneOffset");
  const timezoneZone = timezoneTarget ? (session?.capabilities?.timezoneFormat === "iana" ? recommendedChoice(timezoneTarget.signal, target, session?.platform)?.value : recommendedChoice(timezoneTarget.signal, target, session?.platform)?.windowsTimezone) ?? null : null;
  const manualRows = rows.filter((row) => row.manual);
  // 出口地区本身被规则判为高风险时（例：出口在中国大陆），最佳选项与出口不一致，必须说明冲突。
  const conflicts = useMemo(() => signals.flatMap((signal) => {
    if (signal.state !== "done") return [];
    const choices = repairChoices(signal, target, session?.platform);
    const targetChoice = choices.find((choice) => choice.match === "target" && choice.id !== "current");
    const best = choices[0];
    if (!targetChoice || !best || targetChoice.contribution <= best.contribution) return [];
    return [{ signal, targetChoice, best }];
  }), [signals, target, session?.platform]);
  const currentTotal = Math.min(100, signals.filter((signal) => signal.state === "done").reduce((sum, signal) => sum + signal.contribution, 0));

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; element?.close(); previousFocus?.focus(); };
  }, []);

  // 打开面板就探测本机助手；不能依赖“当前有没有时区待修正项”，否则时区已达标时按钮会永远禁用。
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      helperRequest("/session").then((result) => {
        if (cancelled) return;
        setSession(result);
        setConnection("ready");
      }).catch(() => { if (!cancelled) setConnection("offline"); });
    }, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [helperAttempt]);

  const report = (text: string, error = false) => { setMessage(text); setFailed(error); };

  const applyTimezone = async () => {
    if (!session || !timezoneZone) return;
    setBusy(true);
    report(zh ? "正在修改系统时区…" : "Updating system timezone…");
    try {
      const result = await helperRequest("/timezone", session.token, { timezone: timezoneZone });
      setSession({ ...session, timezone: result.timezone, canRestore: result.canRestore });
      report(zh ? `系统时区已设为 ${result.timezone}，正在复检…` : `System timezone set to ${result.timezone}. Rechecking…`);
      await onRecheck();
      report(zh ? "系统时区已按出口地区修改并重新采样。浏览器缓存旧时区时请重启后复检。" : "Timezone aligned to the exit region and samples refreshed. Restart the browser if it cached the old zone.");
    } catch (error) {
      report(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  };

  const copyGatewayCommand = async () => {
    const env = `ANTHROPIC_BASE_URL=${gatewayUrl}`;
    const copied = await copyText(env);
    report(copied
      ? zh ? `已复制 ${env}，请在 Claude Code 的运行环境中设置。` : `Copied ${env}. Set it in the environment running Claude Code.`
      : zh ? `请在 Claude Code 的运行环境中手动设置 ${env}。` : `Set ${env} manually in the environment running Claude Code.`);
  };

  const copySettings = async () => {
    const address = browserSettingsAddress();
    const language = target?.language ?? manualRows[0]?.targetLabel ?? "";
    const ok = await copyText(`${address}\n${language}`);
    report(ok
      ? zh ? `已复制 ${address}。粘贴到地址栏打开，添加 ${language} 并移到首位，重启浏览器后复检。` : `Copied ${address}. Open it, put ${language} first, restart the browser, then recheck.`
      : zh ? `请手动打开 ${address}，把 ${language} 放到首位后复检。` : `Open ${address} manually, put ${language} first, then recheck.`);
  };

  return (
    <dialog ref={dialog} className="repair-dialog" aria-labelledby="optimize-title" aria-describedby="optimize-description" onCancel={(event) => { event.preventDefault(); if (!working) onClose(); }}>
      <header className="repair-dialog__header">
        <div>
          <p className="repair-caption">{zh ? "优化设置 · 按出口地区匹配" : "Optimization settings · matched to exit region"}</p>
          <h2 id="optimize-title">{exitLabel ? exitLabel : zh ? "尚未识别出口地区" : "Exit region not detected"}</h2>
        </div>
        <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={working}>{zh ? "关闭" : "Close"}</button>
      </header>
      <div className="repair-dialog__body">
        <div className="repair-measured">
          <div>
            <span>{zh ? "网络出口" : "Network exit"}</span>
            <strong>{exitLoading ? zh ? "正在读取出口 IP…" : "Reading exit IP…" : exitGeo ? `${exitGeo.ip ?? "--"}${exitGeo.asn ? ` · ${exitGeo.asn}` : ""}` : zh ? "未检测" : "Not detected"}</strong>
          </div>
          <strong className="repair-points">{currentTotal} → {projected}</strong>
        </div>
        <p id="optimize-description" className="repair-description">
          {target
            ? zh
              ? `出口位于 ${exitLabel}，以下选项按该地区推导：时区 ${target.timezone ?? "未知"}，语言 ${target.language ?? "未知"}。每项都优先给出与出口一致的设置，其次才是与出口无关的低分项。`
              : `The exit is in ${exitLabel}. Recommended settings follow that region: timezone ${target.timezone ?? "unknown"}, language ${target.language ?? "unknown"}. Each item prefers exit-consistent settings, then unrelated lower-point options.`
            : zh
              ? "未能在浏览器中读取出口地区。可先刷新出口信息，或逐项打开检测详情手动选择目标。"
              : "The exit region could not be read in this browser. Refresh the exit info, or open signals one by one and pick targets manually."}
        </p>
        <p className="repair-notice">
          {zh ? "这里的分数是项目规则加分，不是封号概率。语言与区域按网关目标对齐；接入的浏览器跟随迷惑层开关，页面接口保护由本机助手执行。系统时区单独修改并保留恢复入口。" : "Scores are heuristic rule points, not a ban probability. Language and region follow the gateway target. Connected browsers follow the cloak switch, with renderer protection executed by the local helper. System timezone changes are separate and reversible."}
        </p>

        {rows.length > 0 ? (
          <ul className="optimize-list">
            {rows.map((row) => (
              <li key={row.signal.id} className="optimize-row">
                <div className="optimize-row__head">
                  <strong>{row.signal.label}</strong>
                  <span className="repair-points">+{row.signal.contribution} → +{row.points}</span>
                </div>
                <p className="optimize-row__value">{row.signal.value}</p>
                <p className="optimize-row__target">
                  <span className={row.auto ? "optimize-tag optimize-tag--auto" : row.manual ? "optimize-tag optimize-tag--manual" : "optimize-tag"}>
                    {row.auto ? (zh ? "可自动执行·系统时区" : "Auto · system timezone") : row.gateway ? (zh ? "网关层可对齐·不改本机" : "Gateway layer · no local change") : row.manual ? (zh ? "需手动设置" : "Manual") : (zh ? "仅比较" : "Compare")}
                  </span>
                  {row.targetLabel}
                </p>
                <button type="button" className="repair-button repair-button--quiet" onClick={() => onOpenSignal(row.signal.id)} disabled={working}>{zh ? "打开该项详情" : "Open details"}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="repair-description">{zh ? "当前没有可以降低加分的可执行选项；若出口或环境本身与目标地区一致，保持现状即可。" : "No executable option can lower the score right now. If the exit and environment already match, keep them as they are."}</p>
        )}

        {conflicts.length > 0 && <p className="repair-feedback" role="status">
          {zh
            ? `出口地区（${exitLabel}）的自身设置在本项目规则中加分更高：${conflicts.map((item) => `${item.signal.label} ${item.targetChoice.label}(+${item.targetChoice.contribution})`).join("，")}。一键优化不会把加分更高的设置当作优化，也不会自动把环境改成与出口矛盾的地区，请自行判断是否需要调整出入口。`
            : `Settings native to the exit region (${exitLabel}) score higher under these rules: ${conflicts.map((item) => `${item.signal.label} ${item.targetChoice.label} (+${item.targetChoice.contribution})`).join(", ")}. One-click optimize will not present a higher-point setting as an improvement, nor switch you to a region that contradicts your exit. Decide for yourself whether the exit needs to change.`}
        </p>}

        {optimizationNotice && <p className="repair-feedback" role="status">{optimizationNotice}</p>}
        {message && <p className={`repair-feedback${failed ? " repair-feedback--error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
      </div>
      <footer className="repair-dialog__footer">
        {timezoneZone && <button type="button" className="repair-button repair-button--primary" disabled={working || !timezoneSupported} onClick={() => void applyTimezone()}>{busy ? zh ? "执行中…" : "Working…" : zh ? `应用系统时区 ${timezoneZone} 并复检` : `Set ${timezoneZone} & recheck`}</button>}
        <button type="button" role="switch" aria-label={zh ? "网关迷惑层（浏览器跟随）" : "Gateway cloak (browser follows)"} aria-checked={optimization?.enabled === true} className="repair-button optimization-switch" disabled={working || !optimization} onClick={() => void onToggleOptimization(!optimization?.enabled)}>
          <span className="optimization-switch__track" aria-hidden="true"><span /></span>
          {optimizationBusy ? (zh ? "正在连接或切换…" : "Connecting or switching…") : !optimization ? (zh ? "优化 · 网关未连接" : "Optimization · disconnected") : optimization.enabled ? (zh ? "优化 · 已开启" : "Optimization · on") : (zh ? "优化 · 已关闭" : "Optimization · off")}
        </button>
        {!optimization && <button type="button" className="repair-button" disabled={working} onClick={() => void onReconnectGateway()}>{zh ? "重连网关" : "Reconnect gateway"}</button>}
        {optimization?.enabled && <button type="button" className="repair-button" disabled={working} onClick={() => void copyGatewayCommand()}>{zh ? "复制 Claude Code 连接变量" : "Copy Claude Code connection variable"}</button>}
        {manualRows.length > 0 && <button type="button" className="repair-button" disabled={working} onClick={() => void copySettings()}>{zh ? "改为本机手动设置（复制浏览器地址）" : "Change locally instead (copy browser address)"}</button>}
        <button type="button" className="repair-button" disabled={working || exitLoading} onClick={() => void onRefreshExit().catch((error) => report(String(error), true))}>{exitLoading ? zh ? "读取中…" : "Reading…" : zh ? "重新识别出口地区" : "Re-detect exit region"}</button>
        <button type="button" className="repair-button" disabled={working} onClick={() => { report(""); void onRecheck().catch((error) => report(String(error), true)); }}>{zh ? "重新检测实际环境" : "Recheck actual environment"}</button>
      </footer>
      {exitError && <p className="repair-feedback repair-feedback--error" role="alert">{exitError}</p>}
      {!optimization && !optimizationBusy && <p className="repair-feedback" role="status">{zh ? "网关未连接。请在项目目录运行 npm run gateway，再点击重连网关。" : "Gateway disconnected. Run npm run gateway in the project, then reconnect."}</p>}
      {connection === "offline" && <p className="repair-feedback" role="status">{zh ? "本机助手未连接，浏览器执行器与自动修改时区暂不可用。重启 npm run dev，或运行 npm run repair:helper 后重试；API 网关独立运行。" : "Local helper disconnected; browser protection and automatic timezone changes are unavailable. Restart npm run dev or run npm run repair:helper. The API gateway operates independently."}<button type="button" className="repair-button repair-button--quiet" disabled={working} onClick={() => { setConnection("checking"); setHelperAttempt((value) => value + 1); }}>{zh ? "重连时区助手" : "Reconnect timezone helper"}</button></p>}
      {connection === "ready" && !timezoneSupported && <p className="repair-feedback" role="status">{zh ? "当前助手不支持修改系统时区，请在系统设置中手动调整。" : "This helper cannot change the system timezone; use system settings."}</p>}
    </dialog>
  );
}
