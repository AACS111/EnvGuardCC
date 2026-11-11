"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nodeMeasurementScope } from "@/detection/net-core-view.mjs";
import { ProtectionWorkspace, type Baseline } from "./ProtectionWorkspace";
import { useProtection } from "./useProtection";
import { measurementStatus, measurementPoints } from "@/detection/measurement-status";
import type { SimulationJob } from "@/detection/simulation";
import { useSimulation } from "./useSimulation";
import { SignalTable } from "./SignalTable";
import { RepairDialog } from "./RepairDialog";
import { currentSimulation, simulationSignals, nativeClientSignals } from "@/detection/simulation-evidence";
import { mergePointSignals, mergePointCheckSignals, requestSignalSimulation } from "@/detection/single-signal";
import { signalPolicy, signalTestKind } from "@/detection/signal-policy";
import { activeRuntimePolicy, synchronizeBrowserCloak, watchBrowserCloak, type BrowserCloakExecution } from "@/detection/environment-runtime";
import { installRuntimePolicy, restoreRuntimePolicy } from "@/detection/runtime-policy.mjs";
import { protectionRequest } from "@/detection/protection";
import { buildGatewayCheck, readNetCore, readNetCoreNetwork, controlNetCore, importNetCore, netCoreSourceAction, measureNetCoreDelay, setNetCoreMode, setNetCoreNetworkFailure, installKernelHost, type NetCoreReport, type NetCoreExit, type NetCoreNetworkState, type NetCoreAction, type NetCoreImportPayload, type NetCoreSourceAction, type ExitHistory } from "@/detection/gateway-check";
import { SourcesDialog } from "./SourcesDialog";
import { NetworkExemptDialog } from "./NetworkExemptDialog";
import { BrowserPickerDialog } from "./BrowserPickerDialog";
import { HostAuthorizationDialog } from "./HostAuthorizationDialog";
import { environmentScores } from "@/detection/environment-evidence";
import { verificationScores, verificationItem } from "@/detection/verification-score";
import { defaultSignals, normalizeRegion, type SignalView } from "@/detection/client-engine";
import { runBrowserScan, type BrowserScan } from "@/detection/browser-scan";
import { buildExitTarget, fetchExitGeo, type ExitGeo } from "@/detection/exit-geo";
import { checkGateway, probeNodeExits, readGateway, setGatewayCloak, type CloakState, type GatewayCheck } from "@/detection/gateway-check";
import { detectorLocaleText } from "@/detection/locale";
import { detectionConfig } from "@/detection/config";
import type { LocaleCode } from "@/i18n/messages";
import type { SignalResult } from "@/detection/types";
import type { RepairChoice } from "@/detection/repair-options";

const baselineKey = "checkcc.protection-baseline.v1";
const storageKeys = [...orderedIds().map((id) => `checkcc.repair-target.v1.${id}`), "checkcc.applied-environment.v1", "checkcc.browser-gateway-linked.v1", "checkcc.repair-targets.v1"];
function orderedIds() { return Object.entries(detectionConfig.signals).filter(([, config]) => config.enabled).sort(([, a], [, b]) => a.order - b.order).map(([id]) => id); }

export function Detector({ locale = "zh" }: { locale?: LocaleCode }) {
  const zh = locale.startsWith("zh");
  const detectorText = detectorLocaleText[locale];
  const region = "auto";
  const protection = useProtection();
  const selfTest = useSimulation();
  const [browserScan, setBrowserScan] = useState<BrowserScan | null>(null);
  const [claudeCheck, setClaudeCheck] = useState<GatewayCheck | null>(null);
  const [optimization, setOptimization] = useState<CloakState | null>(null);
  const [pointBusy, setPointBusy] = useState<string | null>(null);
  const [pointResults, setPointResults] = useState<Record<string, { signal: SignalResult; simulation: boolean; profileUpdatedAt?: string | null; cloakUpdatedAt?: string | null }>>({});
  const [exitGeo, setExitGeo] = useState<ExitGeo | null>(null);
  const [netCore, setNetCore] = useState<NetCoreReport | null>(null);
  const [netCoreBusy, setNetCoreBusy] = useState(false);
  const [netCoreError, setNetCoreError] = useState("");
  // 配置与供应商：新增/编辑/切换/删除都在这一个弹窗里完成。
  const [manageSourcesOpen, setManageSourcesOpen] = useState(false);
  const [manageSourcesView, setManageSourcesView] = useState<"list" | "add">("list");
  // 逐节点实测出口：显式触发，避免自动轮询造成出口 IP 抖动。
  const [netCoreExitSample, setNetCoreExitSample] = useState<{ scope: string; exits: Record<string, NetCoreExit | null>; at: string } | null>(null);
  const [netCoreExiting, setNetCoreExiting] = useState(false);
  const [networkExemptOpen, setNetworkExemptOpen] = useState(false);
  const [netCoreNetwork, setNetCoreNetwork] = useState<NetCoreNetworkState | null>(null);
  const [exitHistory, setExitHistory] = useState<ExitHistory | null>(null);
  const [netCoreDelaySample, setNetCoreDelaySample] = useState<{ scope: string; delays: Record<string, number | null> } | null>(null);
  const [netCoreMeasuring, setNetCoreMeasuring] = useState(false);
  const sourceScope = nodeMeasurementScope(netCore);
  const latestSourceScope = useRef(sourceScope);
  useEffect(() => { latestSourceScope.current = sourceScope; }, [sourceScope]);
  const netCoreExits = netCoreExitSample?.scope === sourceScope ? netCoreExitSample.exits : {};
  const netCoreExitsAt = netCoreExitSample?.scope === sourceScope ? netCoreExitSample.at : null;
  const netCoreDelays = netCoreDelaySample?.scope === sourceScope ? netCoreDelaySample.delays : (netCore?.delays ?? {});
  const [checkError, setCheckError] = useState("");
  // 浏览器迷惑层报告：未接入就是 null，界面把它显示成「未验证」而不是通过。
  const [browserCloak, setBrowserCloak] = useState<BrowserCloakExecution | null>(null);
  const [linkingBrowser, setLinkingBrowser] = useState(false);
  const [browserPickerOpen, setBrowserPickerOpen] = useState(false);
  // 系统级隧道授权：保护启动时若 TUN 因缺少特权助手失败，就在这里请求一次系统授权。
  const [hostAuth, setHostAuth] = useState<{ error: string; purpose?: "proxy" | "protection" | "strict" } | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [detailSignalId, setDetailSignalId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [manualChecking, setManualChecking] = useState(false);
  const [completedSample, setCompletedSample] = useState<{ id: string; runId?: string } | null>(null);
  const [sampleRetry, setSampleRetry] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [powerAction, setPowerAction] = useState<"start" | "stop" | null>(null);
  const powerLock = useRef(false);
  const powerVersion = useRef(0);
  const activationBaseline = useRef<Baseline | null>(null);
  const scanLock = useRef(false);
  const scanTask = useRef<Promise<void> | null>(null);
  const scanVersion = useRef(0);
  const cloakBusy = protection.busy;
  const gatewayConnecting = !protection.connected;
  const loading = manualChecking || pointBusy !== null;
  const target = protection.report?.enabled && protection.report.target ? protection.report.target : buildExitTarget(exitGeo);
  const measurementsStale = Boolean(protection.report?.enabled && (protection.report.phase === "restart_required" || !protection.report.runId));
  const browserSignals = useMemo(() => measurementsStale ? [] : browserScan?.signals ?? [], [browserScan, measurementsStale]);
  const simulationJob = measurementsStale ? null : currentSimulation(selfTest.job, optimization, selfTest.error);
  const claudeSignals = useMemo(() => measurementsStale ? [] : simulationSignals(nativeClientSignals(claudeCheck?.signals ?? [], claudeCheck?.cloak?.updatedAt === optimization?.updatedAt && claudeCheck?.report?.profile?.updatedAt === optimization?.target?.updatedAt), simulationJob, optimization, locale).map((signal) => {
    const point = pointResults[signal.id];
    return point && (!point.simulation || optimization?.enabled && point.profileUpdatedAt === optimization.target?.updatedAt && point.cloakUpdatedAt === optimization.updatedAt) ? point.signal : signal;
  }), [claudeCheck, simulationJob, optimization, locale, pointResults, measurementsStale]);

  const refreshExit = useCallback(async () => {
    const geo = await fetchExitGeo(locale); setExitGeo(geo);
  }, [locale]);
  // 内核状态只读轮询：失败保留真实错误，不静默回退为“未启用”。
  const refreshNetCore = useCallback(async () => {
    const requestScope = latestSourceScope.current;
    try {
      const value = await readNetCore();
      if (latestSourceScope.current !== requestScope) return;
      latestSourceScope.current = nodeMeasurementScope(value.netCore);
      setNetCore(value.netCore);
      setExitHistory(value.exitHistory);
      // 延迟随状态下发：检测时自动填上，用户不需要先点「测速」。
      const measured = value.netCore?.delays;
      if (measured) setNetCoreDelaySample({ scope: nodeMeasurementScope(value.netCore), delays: measured });
      setNetCoreError("");
    }
    catch (error) {
      if (latestSourceScope.current !== requestScope) return;
      const reason = error instanceof Error ? error.message : String(error);
      setNetCoreError(reason);
      setNetCore(previous => previous ? { ...previous, state: "unavailable", reason, tunCaptured: null, routing: undefined } : null);
    }
  }, []);
  const measureNetCore = useCallback(async (options: { silent?: boolean } = {}) => {
    const requestScope = nodeMeasurementScope(netCore);
    const names = (netCore?.nodes ?? []).filter((name): name is string => typeof name === "string");
    if (!names.length) return;
    // 自动/定时测速静默执行：界面不切「测速中」，旧结果继续显示，新结果回来直接覆盖。
    if (!options.silent) setNetCoreMeasuring(true);
    try {
      const result = await measureNetCoreDelay(names, { force: true });
      if (latestSourceScope.current !== requestScope || (result.netCore && nodeMeasurementScope(result.netCore) !== requestScope)) return;
      if (result.delays) setNetCoreDelaySample({ scope: requestScope, delays: result.delays });
      if (result.netCore) setNetCore(result.netCore);
      if (!result.ok) setNetCoreError(result.reason ?? "测速失败。");
    } catch (error) { if (latestSourceScope.current === requestScope) setNetCoreError(error instanceof Error ? error.message : String(error)); }
    finally { if (!options.silent) setNetCoreMeasuring(false); }
  }, [netCore]);
  const probeExits = useCallback(async () => {
    const requestScope = nodeMeasurementScope(netCore);
    const names = (netCore?.nodes ?? []).filter((name): name is string => typeof name === "string");
    if (!names.length) return;
    setNetCoreExiting(true);
    setNetCoreError("");
    try {
      const result = await probeNodeExits(names);
      if (latestSourceScope.current !== requestScope || (result.netCore && nodeMeasurementScope(result.netCore) !== requestScope)) return;
      setNetCoreExitSample({ scope: requestScope, exits: result.exits ?? {}, at: new Date().toISOString() });
      if (result.netCore) setNetCore(result.netCore);
      if (!result.ok) setNetCoreError(result.reason ?? (zh ? "出口检测失败。" : "Exit probe failed."));
    } catch (error) {
      if (latestSourceScope.current !== requestScope) return;
      setNetCoreExitSample({ scope: requestScope, exits: {}, at: new Date().toISOString() });
      setNetCoreError(error instanceof Error ? error.message : String(error));
    }
    finally { setNetCoreExiting(false); }
  }, [netCore, zh]);
  const netCoreAction = useCallback(async (action: NetCoreAction, node?: string, options: { enabled?: boolean } = {}) => {
    setNetCoreBusy(true);
    try {
      const result = await controlNetCore(action, node, options);
      if (result.netCore) setNetCore(result.netCore);
      setNetCoreError(result.ok ? "" : (result.reason ?? (zh ? "内核操作未生效。" : "Kernel action had no effect.")));
      return result;
    } catch (error) {
      setNetCoreError(error instanceof Error ? error.message : String(error));
      return { ok: false, reason: error instanceof Error ? error.message : String(error), netCore: null };
    }
    finally { setNetCoreBusy(false); }
  }, [zh]);
  // 需要系统授权的原因：一次性安装/更新特权助手都能解决，取消授权后要能直接重试。
  const hostPermissionError = (reason: string | null | undefined) => /TUN 需要更高权限|隧道未接管|严格模式需要|需要管理员权限|特权助手|授权已取消/.test(reason ?? "");
  const authorizeHost = useCallback(async () => {
    if (hostBusy) return;
    const purpose = hostAuth?.purpose ?? "proxy";
    setHostBusy(true);
    setHostAuth({ error: "", purpose });
    try {
      const installed = await installKernelHost();
      if (!installed.ok) throw new Error(installed.reason ?? (zh ? "安装未完成。" : "Installation did not complete."));
      if (purpose === "protection") await protection.act("start");
      else {
        const result = await netCoreAction(purpose === "strict" ? "strict" : "tunnel", undefined, { enabled: true });
        if (!result.ok) throw new Error(result.reason ?? "隧道未接管。");
      }
      await refreshNetCore();
      setHostAuth(null);
    } catch (error) {
      setHostAuth({ error: error instanceof Error ? error.message : String(error), purpose });
    } finally { setHostBusy(false); }
  }, [hostBusy, hostAuth, netCoreAction, protection, refreshNetCore, zh]);
  useEffect(() => {
    let cancelled = false, pending = false;
    const tick = async () => {
      if (cancelled || pending || document.hidden) return;
      pending = true;
      try { await refreshNetCore(); } finally { pending = false; }
    };
    void tick();
    // 连接标签十秒过期，可见页面每四秒更新；后台暂停，避免请求重叠。
    const timer = setInterval(() => void tick(), 4000);
    document.addEventListener('visibilitychange', tick);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [refreshNetCore]);
  // 节点列表就绪后自动测一次延迟：用户不必先点「测速」。
  const delaysCount = Object.keys(netCoreDelays).length;
  const nodeCount = netCore?.nodes?.length ?? 0;
  useEffect(() => {
    if (netCore?.state !== "running" || !nodeCount || delaysCount > 0 || netCoreMeasuring) return;
    // 放到下一个 tick 再触发：effect 里直接改状态会违反 react-hooks/set-state-in-effect。
    const timer = setTimeout(() => { void measureNetCore({ silent: true }); }, 0);
    return () => clearTimeout(timer);
  }, [netCore?.state, nodeCount, delaysCount, netCoreMeasuring, measureNetCore]);

  // 内网豁免摘要只读一次：它不是轮询指标，弹窗保存后会用返回的真实状态覆盖它。
  useEffect(() => {
    let cancelled = false;
    void readNetCoreNetwork().then((value) => { if (!cancelled) setNetCoreNetwork(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const runAll = useCallback((options: { background?: boolean; isCurrent?: () => boolean; runId?: string } = {}) => {
    if (scanTask.current) return scanTask.current;
    const version = scanVersion.current;
    const current = () => version === scanVersion.current && (options.isCurrent?.() ?? true);
    scanLock.current = true; setRunning(true);
    if (!options.background) setCheckError("");
    const task = (async () => { try {
      if (options.runId) {
        const report = await synchronizeBrowserCloak();
        if (!current()) return;
        setBrowserCloak(report);
      }
      const [browser, gateway] = await Promise.all([runBrowserScan(normalizeRegion("auto"), locale, detectorText), checkGateway(locale)]);
      if (!current()) return;
      if (gateway.error) throw new Error(gateway.error);
      setBrowserScan(browser); setClaudeCheck(gateway); setOptimization(gateway.cloak); setPointResults({});
      if (gateway.geo) setExitGeo(gateway.geo);
      setCompletedSample({ id: crypto.randomUUID(), runId: options.runId });
    } catch (error) { if (current() && !options.background) setCheckError(error instanceof Error ? error.message : String(error)); throw error; }
    finally { if (version === scanVersion.current) { scanTask.current = null; scanLock.current = false; setRunning(false); } }
    })();
    scanTask.current = task;
    return task;
  }, [locale, detectorText]);
  const scanRef = useRef(runAll);
  const selfTestRef = useRef(selfTest);
  useEffect(() => { scanRef.current = runAll; selfTestRef.current = selfTest; }, [runAll, selfTest]);
  useEffect(() => {
    const loadBaseline = () => { try { const saved = JSON.parse(localStorage.getItem(baselineKey) ?? "null"); if (saved?.at && Array.isArray(saved.browser) && Array.isArray(saved.claude)) setBaseline(saved); } catch { /* An invalid snapshot is not evidence. */ } };
    const timer = setTimeout(() => { loadBaseline(); void refreshExit().catch(() => {}); }, 0);
    return () => clearTimeout(timer);
  }, [refreshExit]);
  useEffect(() => {
    if (!protection.connected || protection.report?.enabled || protection.report?.desiredEnabled || protection.busy) return;
    let cancelled = false, attempts = 0;
    const scan = async () => {
      if (cancelled) return;
      if (scanLock.current || powerLock.current) { timer = setTimeout(() => void scan(), 1000); return; }
      try { await scanRef.current({ background: true, isCurrent: () => !cancelled }); }
      catch { if (!cancelled) timer = setTimeout(() => void scan(), Math.min(30000, 3000 * 2 ** Math.min(attempts++, 3))); }
    };
    let timer = setTimeout(() => void scan(), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [protection.connected, protection.report?.enabled, protection.report?.desiredEnabled, protection.busy]);
  useEffect(() => {
    if (!baseline || protection.report?.phase !== "idle" || !protection.connected || transitioning || protection.busy) return;
    const timer = setTimeout(() => {
      if (!localStorage.getItem("checkcc.protection-local-pending.v1")) return;
      if (Object.keys(baseline.policy).length) installRuntimePolicy(baseline.policy); else restoreRuntimePolicy();
      for (const [key, value] of Object.entries(baseline.storage)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      localStorage.removeItem("checkcc.protection-local-pending.v1");
      activationBaseline.current = null;
    }, 0);
    return () => clearTimeout(timer);
  }, [baseline, protection.report?.phase, protection.connected, transitioning, protection.busy]);
  const lastSampledRun = useRef<string | null>(null);
  const sampleLock = useRef(false);
  useEffect(() => {
    const id = protection.report?.runId;
    if (!id || lastSampledRun.current === id || !protection.report?.enabled || !protection.connected || !["passed", "failed"].includes(protection.report.testState ?? "") || transitioning || protection.busy || protection.report.phase === "starting" || protection.report.phase === "stopping") return;
    let cancelled = false;
    const sample = async () => {
      if (cancelled) return;
      if (powerLock.current || scanLock.current || sampleLock.current) { timer = setTimeout(() => void sample(), 500); return; }
      sampleLock.current = true;
      try {
        await selfTestRef.current.refresh();
        if (cancelled) return;
        await scanRef.current({ background: true, isCurrent: () => !cancelled, runId: id });
        if (!cancelled) lastSampledRun.current = id;
      } catch { if (!cancelled) timer = setTimeout(() => setSampleRetry(value => value + 1), Math.min(30000, 3000 * 2 ** Math.min(sampleRetry, 3))); }
      finally { sampleLock.current = false; }
    };
    let timer = setTimeout(() => void sample(), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [protection.report?.runId, protection.report?.enabled, protection.report?.phase, protection.report?.testState, protection.connected, protection.busy, transitioning, sampleRetry]);

  const runSignal = async (id: string, choice?: RepairChoice) => {
    if (protection.report?.phase === "restart_required") throw new Error(zh ? "出口已变化，请先重新启动保护。" : "The exit changed. Restart protection first.");
    const policy = signalPolicy(id);
    if (loading || sampleLock.current || scanLock.current || policy.scope !== "browser" && (cloakBusy || gatewayConnecting)) throw new Error(zh ? "已有测试进行中，请稍候。" : "A test is already running.");
    scanLock.current = true;
    setPointBusy(id);
    setCheckError("");
    try {
      if (policy.scope !== "claude") {
        const scan = await runBrowserScan(normalizeRegion(region), locale, detectorText, id);
        const sample = scan.signals.find((item) => item.id === id);
        if (sample) setBrowserScan((previous) => ({ ...scan, signals: scan.signals.reduce((signals, current) => mergePointSignals(signals, current), previous?.signals ?? []) }));
      }
      if (policy.scope !== "browser") {
        let result: GatewayCheck;
        let sample: SignalResult | undefined;
        let relatedSamples: SignalResult[] = [];
        let probe: SimulationJob | null = null;
        if (signalTestKind(id) === "simulation" && optimization?.enabled) {
          const status = await readGateway("/__checkcc/status");
          let nextTarget = status.cloak?.target ?? target;
          if (!nextTarget?.language) {
            const geo = exitGeo ?? await fetchExitGeo(locale);
            if (geo) setExitGeo(geo);
            nextTarget = buildExitTarget(geo);
          }
          if (!nextTarget?.language) throw new Error(zh ? "请先识别出口地区或配置网关语言。" : "Identify the exit or configure gateway language first.");
          if (choice) nextTarget = { ...nextTarget, ...(id === "locale" ? { locale: choice.value } : { language: choice.value.split(",")[0].trim() }) };
          const cloak = choice ? await setGatewayCloak(true, nextTarget) : status.cloak;
          setOptimization(cloak ?? null);
          probe = await requestSignalSimulation(id, Boolean(choice));
          const after = await readGateway("/__checkcc/status");
          setOptimization(after.cloak ?? null);
          result = buildGatewayCheck(after, locale);
          const observed = simulationSignals(result.signals, probe, after.cloak ?? null, locale);
          sample = observed.find((item) => item.id === id);
          if (choice) relatedSamples = observed.filter((item) => item.sampleKind === "simulation" && probe?.signalResults[item.id]?.state === "passed");
          if (!currentSimulation(probe, after.cloak ?? null) || probe.state !== "passed" || sample?.sampleKind !== "simulation") throw new Error(zh ? "单项模拟未通过或配置已变更，请重新测试。" : "Simulation failed or configuration changed; retry this signal.");
        } else {
          result = await checkGateway(locale, id);
          setOptimization(result.cloak ?? null);
          sample = result.signals.find((item) => item.id === id);
          if (result.error) throw new Error(result.error);
        }
        if (sample) {
          const measured = sample;
          setClaudeCheck((previous) => ({ ...result, signals: mergePointCheckSignals(previous, result, probe ? undefined : measured) }));
          setPointResults((previous) => {
            const next = { ...previous };
            if (!probe) for (const refreshed of result.signals.filter((item) => result.report?.testedSignals?.includes(item.id))) next[refreshed.id] = { signal: refreshed, simulation: false };
            for (const refreshed of relatedSamples) next[refreshed.id] = { signal: refreshed, simulation: true, profileUpdatedAt: probe?.profileUpdatedAt, cloakUpdatedAt: probe?.cloakUpdatedAt };
            next[id] = { signal: measured, simulation: Boolean(probe), profileUpdatedAt: probe?.profileUpdatedAt, cloakUpdatedAt: probe?.cloakUpdatedAt };
            return next;
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCheckError(message);
      const config = detectionConfig.signals[id];
      const failure: SignalResult = { id, label: detectorText.signalLabels[id] ?? config.labelKey, value: message, detail: message, score: 0, contribution: 0, weight: config.weight, source: policy.scope === "browser" ? "browser" : "gateway", assessment: "error" };
      if (policy.scope === "browser") setBrowserScan((previous) => previous ? { ...previous, signals: mergePointSignals(previous.signals, failure) } : previous);
      else setPointResults((previous) => ({ ...previous, [id]: { signal: failure, simulation: false } }));
      throw error;
    } finally {
      scanLock.current = false;
      setPointBusy(null);
    }
  };


  // 展示用信号：Claude 侧结果覆盖同名项，浏览器独有项保留。
  const signals = useMemo<SignalView[]>(() => {
    const map = new Map<string, SignalView>();
    for (const signal of browserSignals) map.set(signal.id, { ...signal, state: "done" });
    for (const signal of claudeSignals) {
      const existing = map.get(signal.id);
      if (detectionConfig.signals[signal.id]?.environment === "browser") {
        if (!existing) map.set(signal.id, { ...signal, value: zh ? "请先检测浏览器环境" : "Run browser checks first", assessment: "unknown", source: "browser", state: "pending" });
        continue;
      }
      map.set(signal.id, { ...signal, contribution: Math.max(existing?.contribution ?? 0, signal.contribution), label: detectionConfig.signals[signal.id]?.environment === "claude" ? signal.label : detectorText.signalLabels[signal.id] ?? signal.label, state: "done", ...(existing && existing.source === "browser" && !signal.cloaked ? { value: signal.value } : {}) });
    }
    return orderedIds().map((id) => map.get(id)).filter((signal): signal is SignalView => Boolean(signal));
  }, [browserSignals, claudeSignals, detectorText, zh]);


  const scores = useMemo(() => verificationScores(browserScan ? browserSignals : null, claudeCheck?.report ? claudeSignals : null), [browserScan, browserSignals, claudeCheck, claudeSignals]);

  const allSignals = signals.length ? signals : orderedIds().map((id) => {
    const signal = defaultSignals.find((item) => item.id === id);
    return { ...signal, id, label: detectorText.signalLabels[id] ?? id, value: null, detail: "", contribution: 0, score: 0, assessment: "unknown", source: "browser", weight: detectionConfig.signals[id].weight, state: "pending" } as SignalView;
  });
  const visibleSignals = allSignals.filter((signal) => {
    const status = measurementStatus(signal.id, browserSignals.find(item => item.id === signal.id), claudeSignals.find(item => item.id === signal.id));
    const result = verificationItem(signal.id, browserSignals.find(item => item.id === signal.id), claudeSignals.find(item => item.id === signal.id));
    const pending = result === "pending" || status === "error";
    const points = measurementPoints(signal.id, browserSignals.find(item => item.id === signal.id), claudeSignals.find(item => item.id === signal.id));
    const match = filter === "all" || filter === "issues" && (points > 0 || result === "failed") || filter === "pending" && pending || filter === "passed" && result === "passed";
    return match && (signal.label + " " + (signal.value ?? "")).toLocaleLowerCase().includes(search.toLocaleLowerCase());
  });
  const detailSignal = detailSignalId ? allSignals.find((signal) => signal.id === detailSignalId) : null;
  const observedRun = useRef<string | null>(null);
  useEffect(() => {
    const report = protection.report;
    const maximum = scores.coverage.combined.maximum;
    if (!report?.enabled || report.testing || !["passed", "failed"].includes(report.testState ?? "") || !report.runId || completedSample?.runId !== report.runId || running || observedRun.current === completedSample.id || scores.combined === null || maximum <= 0 || !browserScan || !claudeCheck?.report) return;
    observedRun.current = completedSample.id;
    void protectionRequest("observe", { runId: report.runId, sampleId: completedSample.id, score: Math.max(0, Math.min(100, 100 * (1 - scores.combined / maximum))), verificationScore: scores.combined, verificationMaximum: maximum }).then(() => protection.refresh()).catch(() => { observedRun.current = null; });
  }, [protection, completedSample, scores, running, browserScan, claudeCheck]);

  const refreshChecks = async (enabled: boolean) => {
    await Promise.all([refreshExit(), enabled ? protectionRequest("test").then(() => protection.refresh()) : runAll({ background: true })]);
  };
  const toggleProtection = async (stop = false) => {
    const retrying = powerLock.current || protection.busy || protection.report?.phase === 'starting' || protection.report?.phase === 'stopping';
    const attempt = ++powerVersion.current;
    powerLock.current = true;
    scanVersion.current++; scanTask.current = null; scanLock.current = false; setRunning(false);
    const restarting = !stop && (retrying || protection.report?.phase === "restart_required");
    const stopping = stop || (!restarting && (protection.report?.enabled || protection.report?.phase === "restore_failed"));
    setPowerAction(stopping ? "stop" : "start");
    setTransitioning(true); setCheckError("");
    try {
      // Capture reversible page settings before any asynchronous scan. Retries
      // share this baseline even when the first scan has not returned yet.
      if (!stopping && !activationBaseline.current) {
        if (localStorage.getItem('checkcc.protection-local-pending.v1')) {
          const saved = JSON.parse(localStorage.getItem(baselineKey) ?? 'null') as Baseline | null;
          if (!saved?.policy || !saved.storage) throw new Error(zh ? '原始配置备份不可用，请先关闭保护并重试恢复。' : 'The original settings backup is unavailable. Stop protection and retry restoration first.');
          activationBaseline.current = saved;
        }
        if (!activationBaseline.current) {
          const saved: Baseline = { at: new Date().toISOString(), browser: browserSignals, claude: claudeSignals, score: environmentScores(browserSignals, claudeSignals).combined, policy: activeRuntimePolicy(), storage: Object.fromEntries(storageKeys.map(key => [key, localStorage.getItem(key)])) };
          localStorage.setItem(baselineKey, JSON.stringify(saved));
          localStorage.setItem('checkcc.protection-local-pending.v1', 'true');
          activationBaseline.current = saved; setBaseline(saved);
        }
      }
      if (stopping) {
        // 后台先恢复环境，再解除 TUN；页面不再拆分网络与会话事务。
        const report = await protection.act("stop");
        if (attempt !== powerVersion.current) return;
        if (report.phase === "restore_failed") throw new Error(report.issues.join("；"));
        const original = activationBaseline.current ?? baseline;
        if (original) {
          if (Object.keys(original.policy).length) installRuntimePolicy(original.policy); else restoreRuntimePolicy();
          for (const [key, value] of Object.entries(original.storage)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        }
        localStorage.removeItem("checkcc.protection-local-pending.v1");
        activationBaseline.current = null;
      } else if (restarting) {
        await protection.act("restart");
      } else {
        const [browser, gateway] = await Promise.all([runBrowserScan(normalizeRegion(region), locale, detectorText), checkGateway(locale)]);
        if (attempt !== powerVersion.current) return;
        if (!gateway.report) throw new Error(gateway.error ?? "网关未连接。");
        const saved: Baseline = { ...activationBaseline.current!, browser: browser.signals, claude: gateway.signals, score: environmentScores(browser.signals, gateway.signals).combined };
        activationBaseline.current = saved;
        localStorage.setItem(baselineKey, JSON.stringify(saved)); setBaseline(saved);
        localStorage.setItem("checkcc.protection-local-pending.v1", "true");
        await protection.act("start");
      }
      if (attempt !== powerVersion.current) return;
      setPowerAction(null);
      if (stopping) {
        await selfTest.refresh();
      }
      void refreshChecks(!stopping).catch(() => {});
    } catch (error) {
      if (attempt !== powerVersion.current) return;
      const reason = error instanceof Error ? error.message : String(error);
      setCheckError(reason);
      if (hostPermissionError(reason) && ["darwin", "win32"].includes(netCore?.elevation?.platform ?? "")) setHostAuth({ error: "", purpose: "protection" });
    }
    finally { if (attempt === powerVersion.current) { powerLock.current = false; setPowerAction(null); setTransitioning(false); } }
  };
  const recheck = async () => {
    if (powerLock.current || manualChecking || transitioning || protection.busy) return;
    setManualChecking(true); setCheckError("");
    try {
      const report = protection.report;
      // 自动启动或后台恢复只应用配置、不立即检测：还没有 runId 时普通扫描不会产生得分。
      // 先补一轮验证测试，得分由 runId 下发后的采样流程回填。
      if (report?.enabled && report.phase !== "restart_required" && !report.runId) {
        if (!report.testing) await protectionRequest("test");
        await protection.refresh();
        return;
      }
      await runAll({ runId: report?.runId ?? undefined });
    }
    catch (error) { setCheckError(error instanceof Error ? error.message : String(error)); }
    finally { setManualChecking(false); }
  };
  // 接入并验证浏览器：带 launch 才会拉起受管浏览器；完成后重扫，让浏览器侧信号按新声明刷新。
  const linkBrowser = async () => {
    setLinkingBrowser(true);
    try {
      const report = await synchronizeBrowserCloak({ launch: true, force: true });
      setBrowserCloak(report);
      const web = report.results.find((item) => item.target === 'web');
      if (web?.state === 'failed') throw new Error(web.detail || '受管浏览器启动失败。');
      setCheckError("");
      await recheck();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally { setLinkingBrowser(false); }
  };
  useEffect(() => watchBrowserCloak((report) => setBrowserCloak(report)), []);
  return <>
    <ProtectionWorkspace error={checkError || protection.error} locale={locale} report={protection.report} connected={protection.connected} powerAction={powerAction} checking={manualChecking} busy={cloakBusy || transitioning} scores={scores} geo={exitGeo} target={target} baseline={baseline} browser={browserSignals} claude={claudeSignals} signals={allSignals} filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} onToggle={() => void toggleProtection()} onStop={() => void toggleProtection(true)} onMonitor={(enabled, intervalMs) => { void protection.act("monitor", { enabled, intervalMs }).catch(() => {}); }} onRefresh={() => void recheck()} onRepair={() => { void protection.act("resume").catch(() => {}); }} onSelect={setDetailSignalId} netCore={netCore} netCoreBusy={netCoreBusy} netCoreError={netCoreError} onNetCoreRefresh={() => void refreshNetCore()} onNetCoreStrict={(enabled) => { void netCoreAction("strict", undefined, { enabled }).then(result => { if (!result.ok && hostPermissionError(result.reason) && netCore?.elevation?.platform === "darwin") setHostAuth({ error: "", purpose: "strict" }); }); }} onNetCoreTunnel={(enabled) => { void netCoreAction("tunnel", undefined, { enabled }).then(result => { if (!result.ok && hostPermissionError(result.reason) && ["darwin", "win32"].includes(netCore?.elevation?.platform ?? "")) setHostAuth({ error: "" }); }); }} onNetCoreStart={() => void netCoreAction("start")} onNetCoreStop={() => void netCoreAction("stop")} onNetCoreRestart={() => void netCoreAction("restart")} onNetCoreAuthorizeHost={() => setHostAuth({ error: "" })} onNetCoreSelect={(name) => void netCoreAction("select", name)} onNetCoreManageSources={() => { setManageSourcesView("list"); setManageSourcesOpen(true); }} onNetCoreAddSource={() => { setManageSourcesView("add"); setManageSourcesOpen(true); }} onNetCoreOpenNetworkConfig={() => setNetworkExemptOpen(true)} netCoreNetwork={netCoreNetwork} netCoreExitHistory={exitHistory} onNetCoreMeasure={() => void measureNetCore()} onNetCoreModeChange={(mode) => { setNetCoreBusy(true); void setNetCoreMode(mode).then((result) => { if (result.netCore) setNetCore(result.netCore); if (!result.ok) setNetCoreError(result.reason ?? "切换出站模式失败。"); }).catch((error) => setNetCoreError(error instanceof Error ? error.message : String(error))).finally(() => setNetCoreBusy(false)); }} netCoreMeasuring={netCoreMeasuring} netCoreDelays={netCoreDelays} netCoreExits={netCoreExits} netCoreExitsAt={netCoreExitsAt} netCoreExiting={netCoreExiting} onNetCoreProbeExits={() => void probeExits()} onNetCoreUnlockRegion={() => { setNetCoreBusy(true); void netCoreAction("unlock-region").then((result) => { if (result.netCore) setNetCore(result.netCore); if (!result.ok) setNetCoreError(result.reason ?? "区域锁定解除失败。"); }).catch((error) => setNetCoreError(error instanceof Error ? error.message : String(error))).finally(() => setNetCoreBusy(false)); }} onNetCoreNetworkFailure={(policy) => { setNetCoreBusy(true); void setNetCoreNetworkFailure(policy).then((result) => { if (result.netCore) setNetCore(result.netCore); if (!result.ok) setNetCoreError(result.reason ?? "网络异常处置切换失败。"); }).catch((error) => setNetCoreError(error instanceof Error ? error.message : String(error))).finally(() => setNetCoreBusy(false)); }} browserCloak={browserCloak} linkingBrowser={linkingBrowser} onLinkBrowser={() => void linkBrowser()} onOpenBrowserPicker={() => setBrowserPickerOpen(true)}
      cards={<SignalTable signals={visibleSignals} browser={browserSignals} claude={claudeSignals} locale={locale} onSelect={setDetailSignalId} />} />
    {manageSourcesOpen && <SourcesDialog locale={locale} initialView={manageSourcesView} busy={netCoreBusy} sources={netCore?.sources ?? []} activeId={netCore?.activeId ?? null} onClose={() => setManageSourcesOpen(false)} onImport={async (payload: NetCoreImportPayload) => { const result = await importNetCore(payload); if (result.netCore) { latestSourceScope.current = nodeMeasurementScope(result.netCore); setNetCore(result.netCore); } else await refreshNetCore(); return result; }} onAction={async (action: NetCoreSourceAction, id: string, name?: string) => { const result = await netCoreSourceAction(action, id, name); if (result.netCore) { latestSourceScope.current = nodeMeasurementScope(result.netCore); setNetCore(result.netCore); } else await refreshNetCore(); return result; }} onChanged={() => void refreshNetCore()} />}
    {browserPickerOpen && <BrowserPickerDialog locale={locale} busy={netCoreBusy} onClose={() => setBrowserPickerOpen(false)} onSaved={() => {}} onLink={async () => { await linkBrowser(); }} />}
    {hostAuth && <HostAuthorizationDialog platform={netCore?.elevation?.platform} locale={locale} busy={hostBusy} error={hostAuth.error} onAuthorize={() => void authorizeHost()} onClose={() => { if (!hostBusy) setHostAuth(null); }} />}
    {networkExemptOpen && <NetworkExemptDialog locale={locale} busy={netCoreBusy} onClose={() => setNetworkExemptOpen(false)} onSaved={async (state) => { setNetCoreNetwork(state); if (state.netCore) setNetCore(state.netCore); else await refreshNetCore(); setNetCoreError(state.problem ?? ""); }} />}
    {detailSignal && <RepairDialog key={detailSignal.id} signal={detailSignal} browser={browserSignals.find((item) => item.id === detailSignal.id)} claude={claudeSignals.find((item) => item.id === detailSignal.id)} signals={allSignals} locale={locale} target={target} protectionEnabled={protection.report?.enabled} loading={loading || transitioning || cloakBusy || protection.report?.phase === "restart_required"} onClose={() => setDetailSignalId(null)} onRecheck={() => runSignal(detailSignal.id)} onRuntimeRecheck={runAll} onApplyGateway={(choice) => runSignal(detailSignal.id, choice)} />}
  </>;
}
