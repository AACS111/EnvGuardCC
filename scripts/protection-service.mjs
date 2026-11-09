import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sameTimezone, timezoneSupported } from './system-timezone.mjs';
import { ProtectionSession } from './protection-session.mjs';
import { collectNetworkDiagnostics } from './gateway-diagnostics.mjs';
import { assertClaudeSupportedExit } from '../src/detection/claude-regions.mjs';
import { isHostingExit } from '../src/detection/exit-quality.mjs';
import { setTimeout as pause } from 'node:timers/promises';
const regions = JSON.parse(await readFile(new URL('../src/detection/region-data.json', import.meta.url), 'utf8'));
const { COUNTRY_LANGUAGES, COUNTRY_TIMEZONES, FALLBACK_COUNTRY_NAMES, WINDOWS_ZONES } = regions;

const optionalFile = async (file) => { try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const saveFile = async (file, raw) => { if (raw === null) await rm(file, { force: true }); else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, raw, { mode: 0o600 }); } };
const gatewayUrl = process.env.CHECKCC_GATEWAY_URL || 'http://127.0.0.1:3010';
async function gateway(endpoint, data, origin = 'http://localhost:3000', signal) {
  const response = await fetch(gatewayUrl + endpoint, {
    method: data ? 'POST' : 'GET', headers: { Origin: origin, 'X-CheckCC-Client': 'gateway-ui', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

export function targetFromExit(exit) {
  if (!exit?.primary?.ip || exit.consistentCountry === false) throw new Error('出口情报缺失或国家信息冲突，无法自动适配。');
  const geo = exit.primary;
  const language = COUNTRY_LANGUAGES[geo.countryCode]?.[0];
  if (!language) throw new Error('当前出口国家暂无可靠的语言适配规则。');
  const timezone = geo.timezone ?? COUNTRY_TIMEZONES[geo.countryCode] ?? null;
  return {
    ip: geo.ip, countryCode: geo.countryCode, countryName: FALLBACK_COUNTRY_NAMES[geo.countryCode] ?? geo.countryCode,
    city: geo.city, timezone, windowsTimezone: WINDOWS_ZONES[timezone] ?? null, language, locale: language,
    // 云机房/托管 IP 即使国家正确也可能被 Claude 拒绝；界面据此给出警告。
    asn: geo.asn ?? null, org: geo.org ?? null, isp: geo.isp ?? null, domain: geo.domain ?? null,
    hosting: typeof geo.hosting === "boolean" ? geo.hosting : isHostingExit(geo),
  };
}

export function createProtectionService({ stateDir, runtime, browserCloak, currentZone, setZone, restoreTimezone, canTest, network = () => null, platform = process.platform, gatewayRequest = gateway }) {
  const profileFile = path.join(stateDir, 'region-profile.json');
  const timezoneBackup = path.join(stateDir, 'timezone-backup.json');
  const policyFile = path.join(stateDir, 'environment-policy.json');
  const gateway = gatewayRequest;
  let browserIssues = [];
  // 保护关闭时的 Claude 阻断状态：开启失败要如实展示，不能静默放行。
  let unprotectedBlock = { active: false, error: null };
  const applyUnprotectedBlock = async enabled => {
    const kernel = network();
    if (!kernel) { unprotectedBlock = { active: false, error: null }; return; }
    if (!kernel.setUnprotectedGuard) { unprotectedBlock = { active: false, error: "当前网络内核不支持未保护阻断，请更新 EnvGuardCC。" }; return; }
    try { await kernel.setUnprotectedGuard(enabled); unprotectedBlock = { active: enabled, error: null }; }
    catch (error) { unprotectedBlock = { active: false, error: error.message }; }
  };
  const assertNetwork = async () => {
    const kernel = network();
    if (!kernel) return;
    const report = kernel.verifyConnection ? await kernel.verifyConnection() : await kernel.report();
    if (report.state !== "running" || report.tunEnabled !== true || report.tunCaptured !== true) throw new Error(report.reason || "隧道接管尚未验证，环境防护未生效。");
  };
  const browserErrors = report => [...report.results.filter(result => result.state !== "verified").map(result => result.detail), ...(report.requestProbe?.state !== "verified" ? [report.requestProbe?.detail || "浏览器实际请求尚未验证。"] : [])];
  const session = new ProtectionSession({
    stateDir, canTest,
    beforeActivate: async () => {
      const kernel = network();
      if (!kernel) return;
      // 先解除未保护阻断，否则保护自己的模拟测试会被 REJECT 规则挡住。
      if (kernel.setUnprotectedGuard) await kernel.setUnprotectedGuard(false);
      unprotectedBlock = { active: false, error: null };
      await kernel.setTunnel(true, { ensureHost: true });
      await assertNetwork();
    },
    beforeTest: assertNetwork,
    afterStop: async ({ shutdown = false } = {}) => {
      const kernel = network();
      if (!kernel) return;
      if (shutdown) {
        // 退出应用即停止接管：阻断不需要跨进程保留，系统流量也不必再走内核。
        try { if (kernel.setUnprotectedGuard) await kernel.setUnprotectedGuard(false); } catch { /* 内核随后会整体停止 */ }
        try { if (!kernel.connectionState?.().strictEnabled) await kernel.setTunnel(false); } catch { /* 备份与错误由退出流程继续报告 */ }
        unprotectedBlock = { active: false, error: null };
        return;
      }
      await applyUnprotectedBlock(true);
    },
    detect: async () => {
      const kernel = network();
      if (kernel?.probeSelectedExit) {
        const primary = await kernel.probeSelectedExit();
        // 固定出口必须位于 Claude 官方支持地区：否则宁可拒绝启动，也不把账号暴露给封禁风险。
        assertClaudeSupportedExit(primary);
        return targetFromExit({ primary, consistentCountry: true });
      }
      return targetFromExit((await collectNetworkDiagnostics(new URL(process.env.CHECKCC_UPSTREAM || 'https://api.anthropic.com'), { signalId: 'country' })).exit);
    },
    snapshot: async () => {
      await runtime.load();
      const status = await gateway('/__checkcc/status');
      return { timezone: timezoneSupported(platform) ? await currentZone() : null, timezoneBackup: await optionalFile(timezoneBackup), profile: await optionalFile(profileFile), policyFile: await optionalFile(policyFile), gatewayEnabled: status.cloak.enabled, policy: structuredClone(runtime.policy), runtimeEnabled: runtime.enabled };
    },
    apply: async (target, origin) => {
      const issues = [];
      await gateway('/__checkcc/cloak', { enabled: true, target }, origin);
      if (timezoneSupported(platform)) {
        const zone = platform === 'win32' ? target.windowsTimezone : target.timezone;
        if (!zone) issues.push('当前地区暂无系统时区映射，需手动处理。');
        else try {
          // macOS must also disable automatic timezone selection, even if its
          // current zone already matches. setZone durably saves the original first.
          if (platform === 'darwin' || await currentZone() !== zone) await setZone(zone);
          const actual = await currentZone();
          if (!sameTimezone(actual, zone)) issues.push(`系统时区未应用：当前 ${actual || '未知'}，目标 ${zone}。`);
        } catch (error) { issues.push('系统时区适配失败：' + error.message); }
      }
      const report = await browserCloak.sync(origin, { launch: false, force: true });
      browserIssues = browserErrors(report);
      issues.push(...browserIssues);
      return issues;
    },
    restore: async (baseline, origin, { shutdown = false } = {}) => {
      const issues = [];
      // Attempt every restoration even when another target is unavailable.
      const attempt = async (name, operation) => { try { await operation(); } catch (error) { issues.push(name + '：' + error.message); } };
      await attempt('停止浏览器同步', () => browserCloak.close());
      await attempt('网关停止', () => gateway('/__checkcc/cloak', { enabled: false }, origin));
      await attempt('浏览器恢复', async () => {
        const report = await (shutdown ? runtime.close() : runtime.restore());
        for (const result of report.results) if (result.state === 'failed' || result.state === 'unverified') issues.push(result.detail);
      });
      await attempt('浏览器配置恢复', async () => {
        if (!shutdown && baseline.runtimeEnabled && Object.keys(baseline.policy).length) {
          const previous = await runtime.apply(baseline.policy, origin, [...runtime.clients.keys()]);
          for (const result of previous.results) if (result.state === 'failed') issues.push(result.detail);
        } else {
          runtime.policy = baseline.policy; runtime.enabled = baseline.runtimeEnabled;
        }
      });
      await attempt('浏览器配置文件恢复', () => saveFile(policyFile, Object.hasOwn(baseline, 'policyFile') ? baseline.policyFile : JSON.stringify(baseline.policy)));
      await attempt('系统时区恢复', async () => {
        if (restoreTimezone) { await restoreTimezone(); return; }
        if (baseline.timezone && !sameTimezone(await currentZone(), baseline.timezone)) await setZone(baseline.timezone);
        await saveFile(timezoneBackup, baseline.timezoneBackup);
      });
      await attempt('网关配置恢复', async () => {
        await saveFile(profileFile, baseline.profile);
        await gateway('/__checkcc/cloak', { enabled: baseline.gatewayEnabled }, origin);
      });
      return issues;
    },
    test: async ({ signal } = {}) => {
      signal?.throwIfAborted();
      let job = await gateway('/__checkcc/simulation', {}, undefined, signal);
      const deadline = Date.now() + 120000;
      while (job.running && Date.now() < deadline) {
        await pause(500, undefined, { signal });
        signal?.throwIfAborted();
        job = await gateway('/__checkcc/simulation', undefined, undefined, signal);
      }
      if (job.running) throw new Error('本轮模拟测试超时。');
      return job;
    },
  });
  session.refreshBrowser = report => {
    const remaining = session.report().issues.filter(issue => !browserIssues.includes(issue));
    browserIssues = browserErrors(report);
    session.updateIssues([...remaining, ...browserIssues]);
  };
  const environmentReport = session.report.bind(session);
  session.report = () => {
    const report = environmentReport();
    const connection = network()?.connectionState?.() ?? null;
    if (!connection) return { ...report, unprotectedBlock };
    if (report.enabled && connection.state !== "verified") {
      report.phase = report.phase === "active" ? "partial" : report.phase;
      report.issues = [...new Set([...report.issues, connection.reason || "系统隧道未验证，环境检测不能代表网络保护已生效。"] )];
    }
    return { ...report, connection, unprotectedBlock };
  };
  // 应用启动且自动保护关闭时，由本机助手调用：保护没开也要拦住 Claude。
  session.ensureUnprotectedBlock = async () => { await applyUnprotectedBlock(true); return session.report(); };
  return session;
}
