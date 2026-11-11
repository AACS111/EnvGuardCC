// 内核缺位期间的系统级 fail-closed：由特权宿主持有，内核不在时阻断 Claude 目标的出站。
//
// 语义：宁可连不上，也不让请求以「直连」的路径到达 Anthropic（那是 403 的来源）。
//
// 两条硬约束：
// 1) 撤防必须晚于隧道验证。WFP 在路由决策之前生效，规则存在时会把隧道流量一起拦掉，
//    所以「撤早了」只是继续连不上（可恢复），「撤晚了」才会让流量裸奔。
// 2) 任何一次命令失败都不能当作已生效。布防与撤防都要回读实际规则数量，
//    由心跳持续收敛（arm/release 幂等），而不是相信单次返回码。
//
// 平台边界：当前只实现 Windows（Windows Filtering Platform / New-NetFirewallRule）。
// macOS 走严格模式的 PF anchor（firewall.mjs），本模块返回 supported=false，不冒充已实现。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { windowsSystemExecutable } from "../windows-timezone.mjs";

const run = promisify(execFile);
const powershell = windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe");
const windowsOptions = { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 };
const jsonScript = (body) => `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${body}`;

export const CLAUDE_GUARD_GROUP_PREFIX = "EnvGuardCC-Claude-Guard";
export const CLAUDE_GUARD_PORTS = [443];
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const isAddress = (value) => typeof value === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(value) && (value.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(value));

export const guardGroupName = (token) => `${CLAUDE_GUARD_GROUP_PREFIX}-${token}`;

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * 生成防火墙规则描述（纯数据，便于单测；不执行任何命令）。
 * 选择器三选一或多选：包族名（MSIX 客户端）、程序路径、目标地址（CLI/浏览器）。
 * 至少要有一个选择器，否则规则会变成「阻断全部出站」，那属于严格模式，不是本模块的职责。
 */
export function claudeGuardSpecs({ token, packages = [], programs = [], addresses = [], ports = CLAUDE_GUARD_PORTS } = {}) {
  if (!TOKEN.test(String(token ?? ""))) throw new Error("fail-closed 令牌无效。");
  const group = guardGroupName(token);
  const protocols = ["TCP", "UDP"];
  const specs = [];
  const push = (selector, label) => {
    for (const port of ports) {
      for (const protocol of protocols) {
        specs.push({
          group,
          name: `${group}-${label}-${protocol.toLowerCase()}-${port}`,
          protocol,
          port: Number(port),
          ...selector,
        });
      }
    }
  };
  (Array.isArray(packages) ? packages : []).filter(Boolean).forEach((name, index) => push({ package: String(name) }, `pkg${index}`));
  (Array.isArray(programs) ? programs : []).filter(Boolean).forEach((program, index) => push({ program: String(program) }, `exe${index}`));
  const valid = (Array.isArray(addresses) ? addresses : []).filter(isAddress);
  if (valid.length) push({ addresses: valid }, "addr");
  if (!specs.length) throw new Error("fail-closed 缺少阻断目标：需要包族名、程序路径或目标地址之一。");
  return specs;
}

/** 由规则描述生成 PowerShell 脚本；先删除同组旧规则再重建，保证幂等。 */
export function claudeGuardArmScript(specs) {
  if (!Array.isArray(specs) || !specs.length) throw new Error("fail-closed 规则为空。");
  const group = specs[0].group;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -Group ${quote(group)} -ErrorAction SilentlyContinue`,
  ];
  for (const spec of specs) {
    const selector = spec.package
      ? `-Package ${quote(spec.package)}`
      : spec.program
        ? `-Program ${quote(spec.program)}`
        : `-RemoteAddress ${spec.addresses.map(quote).join(",")}`;
    lines.push(`New-NetFirewallRule -DisplayName ${quote(spec.name)} -Group ${quote(spec.group)} -Direction Outbound -Action Block -Profile Any -Enabled True -Protocol ${spec.protocol} -RemotePort ${spec.port} ${selector} | Out-Null`);
  }
  lines.push(`$count = @(Get-NetFirewallRule -Group ${quote(group)} -ErrorAction SilentlyContinue).Count`);
  lines.push("ConvertTo-Json -Compress -InputObject @{ count = $count }");
  return lines.join("\n");
}

export function claudeGuardReleaseScript(group) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -Group ${quote(group)} -ErrorAction SilentlyContinue`,
    `$count = @(Get-NetFirewallRule -Group ${quote(group)} -ErrorAction SilentlyContinue).Count`,
    "ConvertTo-Json -Compress -InputObject @{ count = $count }",
  ].join("\n");
}

export function claudeGuardStatusScript(group) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$count = @(Get-NetFirewallRule -Group ${quote(group)} -ErrorAction SilentlyContinue).Count`,
    "ConvertTo-Json -Compress -InputObject @{ count = $count }",
  ].join("\n");
}

/**
 * 发现要阻断的 Claude 客户端。
 * 优先用 MSIX 包族名：Store 应用跑在 AppContainer 里，按程序路径的规则对它们不可靠；
 * 同时带上可执行文件路径作为回退（非打包安装的客户端 / Claude Code CLI）。
 *
 * 不自动推导目标 IP：claude.ai 等域名大量落在 Cloudflare 共享网段，按 IP 阻断会误伤半个互联网。
 * 需要按 IP 阻断的用户通过 claude-guard-targets.json 显式提供（见 mergeClaudeGuardTargets）。
 */
export async function discoverClaudeTargets({ platform = process.platform, env = process.env, home = homedir(), exec = run, exists = access } = {}) {
  if (platform !== "win32") return { packages: [], programs: [] };
  const targets = { packages: [], programs: [] };
  const script = jsonScript([
    "$p = Get-AppxPackage -Name Claude | Select-Object -First 1",
    "if ($p) {",
    "  ConvertTo-Json -Compress -InputObject @{ package = $p.PackageFamilyName; exe = (Join-Path $p.InstallLocation 'app/Claude.exe') }",
    "} else { ConvertTo-Json -Compress -InputObject @{ package = $null; exe = $null } }",
  ].join("\n"));
  try {
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], windowsOptions);
    const value = JSON.parse(String(stdout ?? "").trim() || "{}");
    if (typeof value?.package === "string" && value.package) targets.packages.push(value.package);
    if (typeof value?.exe === "string" && value.exe) targets.programs.push(value.exe);
  } catch { /* 没装 Store 版：继续看 CLI */ }
  // Claude Code CLI：原生安装器落在 ~/.local/bin/claude.exe。
  const cli = path.join(home, ".local", "bin", "claude.exe");
  try { await exists(cli); targets.programs.push(cli); } catch { /* 没装 CLI */ }
  return targets;
}

/**
 * 合并用户自定义目标（claude-guard-targets.json）。
 * 允许补程序路径与目标地址；不允许用自定义值绕过「至少一个选择器」的约束。
 */
export async function mergeClaudeGuardTargets(base, { stateDir, read = readFile } = {}) {
  const merged = { packages: [...(base?.packages ?? [])], programs: [...(base?.programs ?? [])], addresses: [...(base?.addresses ?? [])] };
  if (!stateDir) return merged;
  const file = path.join(stateDir, "claude-guard-targets.json");
  let extra;
  try { extra = JSON.parse(await read(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return merged; throw new Error(`fail-closed 目标配置无法读取：${error.message}`); }
  for (const key of ["packages", "programs", "addresses"]) {
    const values = Array.isArray(extra?.[key]) ? extra[key].filter(value => typeof value === "string" && value.trim()) : [];
    merged[key] = [...new Set([...merged[key], ...values.map(value => value.trim())])];
  }
  return merged;
}

const countOf = (stdout) => {
  const parsed = JSON.parse(String(stdout ?? "").trim() || "{}");
  const value = Number(parsed?.count);
  return Number.isFinite(value) ? value : 0;
};

/**
 * 宿主侧 fail-closed 守卫。desired 状态落盘，宿主重启后能自行收敛。
 * armed 永远来自回读（组内实际规则数），不来自「我调用过布防」。
 */
export function createClaudeGuard({ platform = process.platform, stateDir, exec = run, logger = () => {} } = {}) {
  const supported = platform === "win32";
  const file = stateDir ? path.join(stateDir, "claude-guard.json") : null;
  let state = { token: null, desired: "released", selectors: null, at: null };

  async function load() {
    if (!file) return;
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (typeof saved?.token === "string" && TOKEN.test(saved.token)) state = { ...state, ...saved };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async function save(next) {
    state = { ...state, ...next };
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, file);
  }

  async function expect(action) {
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", action], windowsOptions);
    return countOf(stdout);
  }

  async function status() {
    if (!supported || !state.token) return { supported, armed: false, desired: state.desired, count: 0, error: null };
    try {
      const count = await expect(claudeGuardStatusScript(guardGroupName(state.token)));
      return { supported, armed: count > 0, desired: state.desired, count, error: null };
    } catch (error) {
      return { supported, armed: null, desired: state.desired, count: null, error: error.message };
    }
  }

  async function arm({ token = state.token, packages = [], programs = [], addresses = [] } = {}) {
    if (!supported) throw new Error("当前平台没有实现系统级 fail-closed。");
    const useToken = TOKEN.test(String(token ?? "")) ? token : `g${Date.now().toString(36)}`;
    const specs = claudeGuardSpecs({ token: useToken, packages, programs, addresses });
    await save({ token: useToken, desired: "armed", selectors: { packages, programs, addresses }, at: new Date().toISOString() });
    const count = await expect(claudeGuardArmScript(specs));
    if (count < specs.length) throw new Error(`fail-closed 规则未全部生效：期望 ${specs.length} 条，实际 ${count} 条。`);
    logger(`[claude-guard] 已布防：${specs.length} 条规则（令牌 ${useToken}）。`);
    return { armed: true, count };
  }

  async function release() {
    if (!supported) return { armed: false, count: 0 };
    if (!state.token) {
      await save({ desired: "released" });
      return { armed: false, count: 0 };
    }
    await save({ desired: "released", at: new Date().toISOString() });
    const count = await expect(claudeGuardReleaseScript(guardGroupName(state.token)));
    if (count > 0) throw new Error(`fail-closed 规则未删除：仍有 ${count} 条。`);
    logger("[claude-guard] 已撤防。");
    return { armed: false, count };
  }

  /** 宿主重启/心跳用：按期望状态与实际规则数收敛。desired 可覆盖（心跳带新意图时）。 */
  async function reconcile(selectors = null, { desired = null } = {}) {
    if (!supported) return { armed: false, count: 0 };
    await load();
    if (desired === "armed" || desired === "released") await save({ desired });
    if (state.desired !== "armed") {
      return state.token ? release() : { armed: false, count: 0 };
    }
    const source = selectors ?? state.selectors;
    if (!source) return { armed: false, count: 0 };
    const current = await status();
    if (current.armed === true) return { armed: true, count: current.count };
    return arm({ token: state.token, ...source });
  }

  return { supported, arm, release, status, reconcile, load };
}
