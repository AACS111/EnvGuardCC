"use client";

import { installRuntimePolicy, restoreRuntimePolicy, verifyRuntimePolicy, migrateRuntimePolicy } from "./runtime-policy.mjs";
import { helperRequest, helperUrl } from "./local-helper";
import type { RuntimePolicy } from "./environment-actions";

type TargetExecution = { target: string; state: string; detail: string; pages: number };
export type EnvironmentExecution = { policy: RuntimePolicy; results: TargetExecution[]; appliedAt: string };
export type BrowserCloakExecution = EnvironmentExecution & { enabled: boolean; gatewayUpdatedAt: string | null; requestProbe: { state: string; receivedLanguage?: string; sampledAt?: string; detail: string } | null };
const storageKey = "checkcc.applied-environment.v1";
const linkedKey = "checkcc.browser-gateway-linked.v1";
let helperToken: string | null = null;
let revision = 0;
let mutating = false;

export function activeRuntimePolicy(): RuntimePolicy {
  return (globalThis as unknown as Record<symbol, { policy: RuntimePolicy }>)[Symbol.for("checkcc.runtime-policy.v1")]?.policy ?? {};
}

export function installStoredEnvironment() {
  try { if (localStorage.getItem(linkedKey)) return; const policy = JSON.parse(localStorage.getItem(storageKey) ?? "null"); if (policy && typeof policy === "object") { const migrated = migrateRuntimePolicy(policy); installRuntimePolicy(migrated); localStorage.setItem(storageKey, JSON.stringify(migrated)); } } catch { /* Stored settings are optional; an invalid setting is not a pass. */ }
}

async function executeHelper(path: string, body: object, retry = true): Promise<EnvironmentExecution> {
  if (!helperToken) helperToken = (await helperRequest("/session?tokenOnly=1")).token;
  const response = await fetch(`${helperUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-CheckCC-Client": "repair-ui", "X-CheckCC-Token": helperToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45000), cache: "no-store",
  });
  const result = await response.json();
  if (response.status === 403 && retry) { helperToken = null; return executeHelper(path, body, false); }
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function applyLocalExecution<T extends EnvironmentExecution>(result: T): T {
  const previous = activeRuntimePolicy();
  try {
    const observed = installRuntimePolicy(result.policy);
    if (!verifyRuntimePolicy(result.policy, observed)) throw new Error("当前浏览器指定接口的采样结果未达到所选条件。");
    localStorage.setItem(storageKey, JSON.stringify(result.policy));
    result.results.unshift({ target: "local", state: "verified", detail: "当前检测页面的浏览器接口已应用并采样通过。", pages: 1 });
  } catch (error) {
    installRuntimePolicy(previous);
    result.results.unshift({ target: "local", state: "failed", detail: error instanceof Error ? error.message : String(error), pages: 0 });
  }
  return result;
}

export async function applyEnvironment(delta: RuntimePolicy) {
  const version = ++revision; mutating = true;
  try { const result = await executeHelper("/environment", { policy: delta }); if (version !== revision) throw new Error("配置已变化，忽略旧的脚本执行结果。"); localStorage.removeItem(linkedKey); return applyLocalExecution(result); }
  finally { if (version === revision) mutating = false; }
}

export async function synchronizeBrowserCloak(options: { launch?: boolean; force?: boolean } = {}) {
  const explicit = options.launch || options.force;
  const version = explicit ? ++revision : revision;
  if (explicit) mutating = true;
  try {
    const result = await executeHelper("/browser-cloak", options) as BrowserCloakExecution;
    if (version !== revision) throw new Error("浏览器配置已发生变化，忽略旧同步结果。");
    if (typeof result.enabled !== "boolean") throw new Error("本机助手不支持浏览器迷惑层，请重启开发服务。");
    localStorage.setItem(linkedKey, "true");
    if (result.enabled) return applyLocalExecution(result);
    restoreRuntimePolicy(); localStorage.removeItem(storageKey);
    result.results.unshift({ target: "local", state: "restored", detail: "当前浏览器已跟随网关关闭接口覆盖。", pages: 1 });
    return result;
  } finally { if (explicit && version === revision) mutating = false; }
}

export function watchBrowserCloak(listener: (report: BrowserCloakExecution | null) => void) {
  let stopped = false, busy = false;
  const sync = async () => {
    if (busy || stopped || mutating) return;
    if (!localStorage.getItem(linkedKey)) { listener(null); return; }
    busy = true;
    const version = revision;
    try { const report = await synchronizeBrowserCloak(); if (!stopped) listener(report); }
    catch (error) {
      if (version !== revision || stopped) return;
      restoreRuntimePolicy(); localStorage.removeItem(storageKey);
      if (!stopped) listener({ enabled: false, policy: {}, appliedAt: new Date().toISOString(), gatewayUpdatedAt: null, requestProbe: null, results: [{ target: "local", state: "failed", detail: error instanceof Error ? error.message : String(error), pages: 0 }] });
    } finally { busy = false; }
  };
  void sync(); const timer = setInterval(() => void sync(), 2500);
  return () => { stopped = true; clearInterval(timer); };
}

export async function restoreEnvironment() {
  const version = ++revision; mutating = true;
  let result: EnvironmentExecution;
  try { result = await executeHelper("/environment/restore", {}); }
  catch (error) { result = { policy: {}, appliedAt: new Date().toISOString(), results: [{ target: "remote", state: "failed", detail: error instanceof Error ? error.message : String(error), pages: 0 }] }; }
  if (version !== revision) return result;
  try { restoreRuntimePolicy(); localStorage.removeItem(storageKey); localStorage.removeItem(linkedKey); }
  finally { if (version === revision) mutating = false; }
  result.results.unshift({ target: "local", state: "restored", detail: "当前浏览器已恢复原始接口。", pages: 1 });
  return result;
}
