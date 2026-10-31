"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProtectionWorkspace, type Baseline } from "./ProtectionWorkspace";
import { useProtection } from "./useProtection";
import { measurementStatus, measurementPoints } from "@/detection/measurement-status";
import type { SimulationJob } from "@/detection/simulation";
import { useSimulation } from "./useSimulation";
import { SignalCard } from "./SignalCard";
import { RepairDialog } from "./RepairDialog";
import { currentSimulation, simulationSignals, nativeClientSignals } from "@/detection/simulation-evidence";
import { mergePointSignals, mergePointCheckSignals, requestSignalSimulation } from "@/detection/single-signal";
import { signalPolicy, signalTestKind } from "@/detection/signal-policy";
import { activeRuntimePolicy, synchronizeBrowserCloak, watchBrowserCloak, type BrowserCloakExecution } from "@/detection/environment-runtime";
import { installRuntimePolicy, restoreRuntimePolicy } from "@/detection/runtime-policy.mjs";
import { protectionRequest } from "@/detection/protection";
import { buildGatewayCheck } from "@/detection/gateway-check";
import { environmentScores } from "@/detection/environment-evidence";
import { verificationScores, verificationItem } from "@/detection/verification-score";
import { defaultSignals, normalizeRegion, type SignalView } from "@/detection/client-engine";
import { runBrowserScan, type BrowserScan } from "@/detection/browser-scan";
import { buildExitTarget, fetchExitGeo, type ExitGeo } from "@/detection/exit-geo";
import { checkGateway, readGateway, setGatewayCloak, type CloakState, type GatewayCheck } from "@/detection/gateway-check";
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
  const [exitLoading, setExitLoading] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [detailSignalId, setDetailSignalId] = useState<string | null>(null);
  const [browserReport, setBrowserReport] = useState<BrowserCloakExecution | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [sampleRetry, setSampleRetry] = useState(0);
  const [sampledRun, setSampledRun] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [powerAction, setPowerAction] = useState<"start" | "stop" | null>(null);
  const powerLock = useRef(false);
  const scanLock = useRef(false);
  const cloakBusy = protection.busy;
  const gatewayConnecting = !protection.connected;
  const loading = running || sampling || selfTest.busy || pointBusy !== null;
  const target = protection.report?.enabled && protection.report.target ? protection.report.target : buildExitTarget(exitGeo);
  const measurementsStale = Boolean(protection.report?.enabled && (protection.report.phase === "restart_required" || !protection.report.runId || sampledRun !== protection.report.runId));
  const browserSignals = useMemo(() => measurementsStale ? [] : browserScan?.signals ?? [], [browserScan, measurementsStale]);
  const simulationJob = measurementsStale ? null : currentSimulation(selfTest.job, optimization, selfTest.error);
  const claudeSignals = useMemo(() => measurementsStale ? [] : simulationSignals(nativeClientSignals(claudeCheck?.signals ?? [], claudeCheck?.cloak?.updatedAt === optimization?.updatedAt && claudeCheck?.report?.profile?.updatedAt === optimization?.target?.updatedAt), simulationJob, optimization, locale).map((signal) => {
    const point = pointResults[signal.id];
    return point && (!point.simulation || optimization?.enabled && point.profileUpdatedAt === optimization.target?.updatedAt && point.cloakUpdatedAt === optimization.updatedAt) ? point.signal : signal;
  }), [claudeCheck, simulationJob, optimization, locale, pointResults, measurementsStale]);

  const refreshExit = useCallback(async () => {
    setExitLoading(true);
    try { const geo = await fetchExitGeo(locale); setExitGeo(geo); }
    finally { setExitLoading(false); }
  }, [locale]);
  const runAll = useCallback(async () => {
    if (scanLock.current) throw new Error(zh ? "已有检测正在执行，请稍候。" : "A scan is already running.");
    scanLock.current = true; setRunning(true); setCheckError("");
    try {
      const [browser, gateway] = await Promise.all([runBrowserScan(normalizeRegion("auto"), locale, detectorText), checkGateway(locale)]);
      setBrowserScan(browser); setClaudeCheck(gateway); setOptimization(gateway.cloak); setPointResults({});
      if (gateway.geo) setExitGeo(gateway.geo);
      if (gateway.error) throw new Error(gateway.error);
    } catch (error) { setCheckError(error instanceof Error ? error.message : String(error)); throw error; }
    finally { scanLock.current = false; setRunning(false); }
  }, [locale, detectorText, zh]);
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
      try { await scanRef.current(); }
      catch { if (!cancelled) timer = setTimeout(() => void scan(), Math.min(30000, 3000 * 2 ** Math.min(attempts++, 3))); }
    };
    let timer = setTimeout(() => void scan(), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [protection.connected, protection.report?.enabled, protection.report?.desiredEnabled, protection.busy]);
  useEffect(() => {
    if (transitioning || protection.busy || protection.report?.phase === "starting" || protection.report?.phase === "stopping") return;
    if (protection.report?.phase === "restart_required") return;
    return watchBrowserCloak(setBrowserReport);
  }, [transitioning, protection.busy, protection.report?.phase]);
  useEffect(() => {
    if (!baseline || protection.report?.phase !== "idle" || !protection.connected || transitioning || protection.busy) return;
    const timer = setTimeout(() => {
      if (!localStorage.getItem("checkcc.protection-local-pending.v1")) return;
      if (Object.keys(baseline.policy).length) installRuntimePolicy(baseline.policy); else restoreRuntimePolicy();
      for (const [key, value] of Object.entries(baseline.storage)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      localStorage.removeItem("checkcc.protection-local-pending.v1");
    }, 0);
    return () => clearTimeout(timer);
  }, [baseline, protection.report?.phase, protection.connected, transitioning, protection.busy]);
  const lastSampledRun = useRef<string | null>(null);
  const sampleLock = useRef(false);
  useEffect(() => {
    const id = protection.report?.runId;
    if (!id || lastSampledRun.current === id || !protection.report?.enabled || !protection.connected || protection.report.testState !== "passed" || transitioning || protection.busy || protection.report.phase === "starting" || protection.report.phase === "stopping") return;
    let cancelled = false;
    const sample = async () => {
      if (cancelled) return;
      if (powerLock.current || scanLock.current || sampleLock.current) { timer = setTimeout(() => void sample(), 500); return; }
      sampleLock.current = true; setSampling(true);
      try {
        await synchronizeBrowserCloak({ force: true });
        if (cancelled) return;
        await selfTestRef.current.refresh();
        if (cancelled) return;
        await scanRef.current();
        if (!cancelled) { lastSampledRun.current = id; setSampledRun(id); }
      } catch (error) { if (!cancelled) { setCheckError(String(error)); timer = setTimeout(() => setSampleRetry(value => value + 1), Math.min(30000, 3000 * 2 ** Math.min(sampleRetry, 3))); } }
      finally { sampleLock.current = false; setSampling(false); }
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
      map.set(signal.id, { ...signal, contribution: Math.max(existing?.contribution ?? 0, signal.contribution), label: detectorText.signalLabels[signal.id] ?? signal.label, state: "done", ...(existing && existing.source === "browser" && !signal.cloaked ? { value: signal.value } : {}) });
    }
    return orderedIds().map((id) => map.get(id)).filter((signal): signal is SignalView => Boolean(signal));
  }, [browserSignals, claudeSignals, detectorText, zh]);

  const riskScores = useMemo(() => environmentScores(browserScan ? browserSignals : null, claudeCheck?.report ? claudeSignals : null), [browserScan, browserSignals, claudeCheck, claudeSignals]);

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
    if (!report?.enabled || report.testState !== "passed" || !report.runId || sampledRun !== report.runId || running || observedRun.current === `${report.runId}:${riskScores.combined}` || riskScores.combined === null || !browserScan || !claudeCheck?.report) return;
    observedRun.current = `${report.runId}:${riskScores.combined}`;
    void protectionRequest("observe", { runId: report.runId, score: riskScores.combined }).then(() => protection.refresh()).catch(() => { observedRun.current = null; });
  }, [protection, sampledRun, riskScores.combined, running, browserScan, claudeCheck]);

  const refreshChecks = async (enabled: boolean) => {
    await Promise.all([refreshExit(), enabled ? protection.act("test") : runAll()]);
  };
  const toggleProtection = async (stop = false) => {
    if (powerLock.current || sampleLock.current || transitioning || protection.busy || loading || exitLoading || protection.report?.testing || !protection.connected || !protection.report || protection.report.phase === "starting" || protection.report.phase === "stopping") return;
    powerLock.current = true;
    const restarting = protection.report.phase === "restart_required" && !stop;
    const stopping = !restarting && (protection.report.enabled || protection.report.phase === "restore_failed");
    setPowerAction(stopping ? "stop" : "start");
    setTransitioning(true); setCheckError("");
    try {
      if (stopping) {
        const report = await protection.act("stop");
        if (report.phase === "restore_failed") throw new Error(report.issues.join("；"));
        if (baseline) {
          if (Object.keys(baseline.policy).length) installRuntimePolicy(baseline.policy); else restoreRuntimePolicy();
          for (const [key, value] of Object.entries(baseline.storage)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        }
        localStorage.removeItem("checkcc.protection-local-pending.v1");
      } else if (restarting) {
        await protection.act("start");
      } else {
        const [browser, gateway] = await Promise.all([runBrowserScan(normalizeRegion(region), locale, detectorText), checkGateway(locale)]);
        if (!gateway.report) throw new Error(gateway.error ?? "网关未连接。");
        const saved: Baseline = { at: new Date().toISOString(), browser: browser.signals, claude: gateway.signals, score: environmentScores(browser.signals, gateway.signals).combined, policy: activeRuntimePolicy(), storage: Object.fromEntries(storageKeys.map((key) => [key, localStorage.getItem(key)])) };
        localStorage.setItem(baselineKey, JSON.stringify(saved)); setBaseline(saved);
        localStorage.setItem("checkcc.protection-local-pending.v1", "true");
        await protection.act("start");
      }
      setPowerAction(null);
      if (stopping) {
        await selfTest.refresh();
        while (scanLock.current) await new Promise(resolve => setTimeout(resolve, 100));
      }
      await refreshChecks(!stopping);
    } catch (error) { setCheckError(error instanceof Error ? error.message : String(error)); }
    finally { powerLock.current = false; setPowerAction(null); setTransitioning(false); }
  };
  const recheck = async () => {
    if (powerLock.current || sampleLock.current || scanLock.current || loading || transitioning || protection.busy || protection.report?.testing || exitLoading) return;
    setTransitioning(true); setCheckError("");
    try { await refreshChecks(Boolean(protection.report?.enabled)); }
    catch (error) { setCheckError(error instanceof Error ? error.message : String(error)); }
    finally { setTransitioning(false); }
  };
  return <>
    <ProtectionWorkspace browserReport={browserReport} onBrowserReport={setBrowserReport} error={checkError || protection.error} locale={locale} report={protection.report} connected={protection.connected} powerAction={powerAction} checking={!powerAction && (exitLoading || loading || protection.report?.testing === true)} busy={cloakBusy || transitioning || exitLoading || loading || protection.report?.testing === true} scores={scores} geo={exitGeo} target={target} baseline={baseline} browser={browserSignals} claude={claudeSignals} signals={allSignals} filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} onToggle={() => void toggleProtection()} onStop={() => void toggleProtection(true)} onMonitor={(enabled, intervalMs) => { void protection.act("monitor", { enabled, intervalMs }).catch(() => {}); }} onRefresh={() => void recheck()} onSelect={setDetailSignalId}
      cards={visibleSignals.length ? <div className="signal-card-grid">{visibleSignals.map((signal) => <SignalCard key={signal.id} signal={signal} browser={browserSignals.find((item) => item.id === signal.id)} claude={claudeSignals.find((item) => item.id === signal.id)} locale={locale} target={target} job={simulationJob} simulationBusy={selfTest.busy} checking={loading} testing={pointBusy === signal.id} detailLabel={zh ? "配置与详情" : "Configuration & details"} onSelect={setDetailSignalId} />)}</div> : <p className="workspace-empty">{zh ? "没有匹配的检测项目。" : "No matching test items."}</p>} />
    {detailSignal && <RepairDialog key={detailSignal.id} signal={detailSignal} browser={browserSignals.find((item) => item.id === detailSignal.id)} claude={claudeSignals.find((item) => item.id === detailSignal.id)} signals={allSignals} locale={locale} target={target} protectionEnabled={protection.report?.enabled} loading={loading || transitioning || cloakBusy || protection.report?.testing === true || protection.report?.phase === "restart_required"} onClose={() => setDetailSignalId(null)} onRecheck={() => runSignal(detailSignal.id)} onRuntimeRecheck={runAll} onApplyGateway={(choice) => runSignal(detailSignal.id, choice)} />}
  </>;
}
