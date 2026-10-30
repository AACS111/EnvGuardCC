import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProtectionSession } from './protection-session.mjs';
import { collectNetworkDiagnostics } from './gateway-diagnostics.mjs';
const regions = JSON.parse(await readFile(new URL('../src/detection/region-data.json', import.meta.url), 'utf8'));
const { COUNTRY_LANGUAGES, COUNTRY_TIMEZONES, FALLBACK_COUNTRY_NAMES, WINDOWS_ZONES } = regions;

const optionalFile = async (file) => { try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const saveFile = async (file, raw) => { if (raw === null) await rm(file, { force: true }); else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, raw, { mode: 0o600 }); } };
const gatewayUrl = process.env.CHECKCC_GATEWAY_URL || 'http://127.0.0.1:3010';
async function gateway(endpoint, data, origin = 'http://localhost:3000') {
  const response = await fetch(gatewayUrl + endpoint, {
    method: data ? 'POST' : 'GET', headers: { Origin: origin, 'X-CheckCC-Client': 'gateway-ui', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(10000),
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
  return { ip: geo.ip, countryCode: geo.countryCode, countryName: FALLBACK_COUNTRY_NAMES[geo.countryCode] ?? geo.countryCode, city: geo.city, timezone, windowsTimezone: WINDOWS_ZONES[timezone] ?? null, language, locale: language };
}

export function createProtectionService({ stateDir, runtime, browserCloak, currentZone, setZone, canTest, gatewayRequest = gateway }) {
  const profileFile = path.join(stateDir, 'region-profile.json');
  const timezoneBackup = path.join(stateDir, 'timezone-backup.json');
  const policyFile = path.join(stateDir, 'environment-policy.json');
  const gateway = gatewayRequest;
  return new ProtectionSession({
    stateDir, canTest,
    detect: async () => targetFromExit((await collectNetworkDiagnostics(new URL(process.env.CHECKCC_UPSTREAM || 'https://api.anthropic.com'), { signalId: 'country' })).exit),
    snapshot: async () => {
      await runtime.load();
      const status = await gateway('/__checkcc/status');
      return { timezone: process.platform === 'win32' ? await currentZone() : null, timezoneBackup: await optionalFile(timezoneBackup), profile: await optionalFile(profileFile), policyFile: await optionalFile(policyFile), gatewayEnabled: status.cloak.enabled, policy: structuredClone(runtime.policy), runtimeEnabled: runtime.enabled };
    },
    apply: async (target, origin) => {
      const issues = [];
      await gateway('/__checkcc/cloak', { enabled: true, target }, origin);
      if (process.platform === 'win32') {
        if (!target.windowsTimezone) issues.push('当前地区暂无系统时区映射，需手动处理。');
        else try { if (await currentZone() !== target.windowsTimezone) await setZone(target.windowsTimezone); }
        catch (error) { issues.push('系统时区适配失败：' + error.message); }
      } else issues.push('本机系统时区自动适配仅支持 Windows。');
      const report = await browserCloak.sync(origin, { launch: false, force: true });
      for (const result of report.results) if (result.state !== 'verified') issues.push(result.detail);
      if (report.requestProbe?.state !== 'verified') issues.push(report.requestProbe?.detail ?? '浏览器实际请求尚未验证。');
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
        if (baseline.timezone && await currentZone() !== baseline.timezone) await setZone(baseline.timezone);
        await saveFile(timezoneBackup, baseline.timezoneBackup);
      });
      await attempt('网关配置恢复', async () => {
        await saveFile(profileFile, baseline.profile);
        await gateway('/__checkcc/cloak', { enabled: baseline.gatewayEnabled }, origin);
      });
      return issues;
    },
    test: async () => {
      let job = await gateway('/__checkcc/simulation', {});
      const deadline = Date.now() + 120000;
      while (job.running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await gateway('/__checkcc/simulation');
      }
      if (job.running) throw new Error('本轮模拟测试超时。');
      return job;
    },
  });
}
