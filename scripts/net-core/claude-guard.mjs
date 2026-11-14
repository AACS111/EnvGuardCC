// 内核缺位期间的系统级 fail-closed：由特权宿主持有，内核不在时阻断 Claude 目标的出站。
//
// 语义：宁可连不上，也不让请求以「直连」的路径到达 Anthropic（那是 403 的来源）。
//
// 两条硬约束：
// 1) 撤防必须晚于隧道验证。WFP 在路由决策之前生效，规则存在时会把隧道流量一起拦掉，
//    全阻断撤早会泄漏，撤晚会继续断网；正常运行仍保留只拒绝真实地址的桌面规则。
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
import { createHash } from "node:crypto";
import { windowsSystemExecutable } from "../windows-timezone.mjs";
import { windowsClaudeTargets } from '../windows-claude-targets.mjs';
import { FIREWALL_RULE_CHECK } from './firewall-rule-check.mjs';

const run = promisify(execFile);
const powershell = windowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe");
const windowsOptions = { windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024 };
const jsonScript = (body) => `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${body}`;

export const CLAUDE_GUARD_GROUP_PREFIX = "EnvGuardCC-Claude-Guard";
export const CLAUDE_GUARD_PORTS = [443];
// 与 config.mjs 的 198.18.0.1/16 对齐。只允许 loopback / fake-IP；
// 即使 TUN 消失，Claude 也无法连接真实外网地址（包括缓存 IP 和 IPv6）。
export const CLAUDE_DIRECT_BLOCK_ADDRESSES = [
  '0.0.0.0-126.255.255.255', '128.0.0.0-198.17.255.255',
  '198.19.0.0-255.255.255.255', '::/128', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
];

// New-NetFirewallRule -Package 接受 SID，不接受 Get-AppxPackage 的 PackageFamilyName。
export const PACKAGE_SID_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class EnvGuardPackageSid {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  public static string Resolve(string name) {
    if (name.StartsWith("S-1-15-2-", StringComparison.OrdinalIgnoreCase)) return new SecurityIdentifier(name).Value;
    IntPtr sid;
    int result = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (result != 0) Marshal.ThrowExceptionForHR(result);
    try { return new SecurityIdentifier(sid).Value; } finally { FreeSid(sid); }
  }
}
'@
`;

// 默认的 Anthropic/Claude 域名集合（浏览器等不按进程拦的入口靠 hosts 层覆盖）。
// 刻意不包含 challenges.cloudflare.com：那是 Cloudflare 共享的人机验证通道，
// 屏蔽它会连带打断其它站点的验证码登录，而 Claude 自己的登录页仍会经过它。
// hosts 不支持通配符，所以按实际会用到的主机名逐个列出。
export const CLAUDE_GUARD_DOMAINS = [
  "anthropic.com",
  "www.anthropic.com",
  "api.anthropic.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  "claude.ai",
  "www.claude.ai",
  "claude.com",
  "www.claude.com",
  "claudeusercontent.com",
];

const HOSTS_MARKER_START = "# >>> EnvGuardCC fail-closed";
const HOSTS_MARKER_END = "# <<< EnvGuardCC fail-closed";
const DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const isAddress = (value) => typeof value === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(value) && (value.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(value));

export const guardGroupName = (token) => `${CLAUDE_GUARD_GROUP_PREFIX}-${token}`;

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ruleName = spec => `${spec.group}-${createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24)}`;
export const FIREWALL_CHECK_SCRIPT = `
$service = Get-Service -Name MpsSvc -ErrorAction Stop
$profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
if ($service.Status -ne 'Running' -or $profiles.Count -ne 3 -or @($profiles | Where-Object { $_.Enabled -ne 'True' }).Count) { throw '[FIREWALL_DISABLED] Windows 防火墙未开启，需要确认开启后才能阻止 Claude 直连。' }
if (@($profiles | Where-Object { $_.AllowLocalFirewallRules -eq 'False' }).Count) { throw '组策略禁止本地防火墙规则，请联系管理员；无法确认 Claude 直连阻断生效。' }
`;

export function enableFirewallScript(confirmed) {
  if (confirmed !== true) throw new Error('开启 Windows 防火墙需要用户明确确认。');
  return `$ErrorActionPreference = 'Stop'\nStart-Service -Name MpsSvc -ErrorAction Stop\nSet-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -ErrorAction Stop\n${FIREWALL_CHECK_SCRIPT}\nConvertTo-Json -Compress -InputObject @{ count = 3 }`;
}

/**
 * 生成 hosts 阻断段。域名解析到 0.0.0.0 / ::1 后，任何走系统解析的入口（浏览器、CLI）
 * 都拿不到真实地址；不碰 Cloudflare 共享 IP，因此不会误伤其它网站。
 */
export function hostsBlockText(domains = CLAUDE_GUARD_DOMAINS, token = "default", { eol = "\r\n" } = {}) {
  const valid = (Array.isArray(domains) ? domains : []).filter(domain => DOMAIN.test(String(domain ?? "")));
  if (!valid.length) throw new Error("fail-closed 域名集合为空。");
  const lines = [`${HOSTS_MARKER_START} (${token}) >>>`];
  for (const domain of valid) {
    lines.push(`0.0.0.0 ${domain}`);
    lines.push(`::1 ${domain}`);
  }
  lines.push(`# <<< EnvGuardCC fail-closed (${token}) <<<`);
  return lines.join(eol) + eol;
}

/** 删除所有 fail-closed 段（不依赖 token，恢复工具也能用），其余行原样保留。 */
export function stripHostsBlock(content) {
  const text = String(content ?? "");
  const kept = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(HOSTS_MARKER_START)) { inside = true; continue; }
    if (inside) { if (line.startsWith(HOSTS_MARKER_END)) inside = false; continue; }
    kept.push(line);
  }
  return kept.join("\r\n");
}

export const hostsBlocked = (content) => String(content ?? "").includes(HOSTS_MARKER_START);

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

export function claudeDirectSpecs(selectors) {
  if (!selectors?.packages?.length && !selectors?.programs?.length) return [];
  return claudeGuardSpecs({ ...selectors, addresses: [], ports: [443] })
    .filter(spec => spec.protocol === 'TCP')
    .map(spec => ({ ...spec, group: `${spec.group}-Direct`, name: `${spec.name}-Direct`, protocol: 'Any', port: 'Any', addresses: CLAUDE_DIRECT_BLOCK_ADDRESSES }));
}

/** 按稳定 Name 更新，不先删旧规则；重试和补齐部分失败不会制造新的直连窗口。 */
export function claudeGuardArmScript(specs) {
  if (!Array.isArray(specs) || !specs.length) throw new Error("fail-closed 规则为空。");
  const groups = [...new Set(specs.map(spec => spec.group))];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    FIREWALL_CHECK_SCRIPT,
    `$existing = @(Get-NetFirewallRule -Group ${groups.map(quote).join(',')} -PolicyStore PersistentStore -ErrorAction SilentlyContinue)`,
  ];
  if (specs.some(spec => spec.package)) lines.push(PACKAGE_SID_SCRIPT);
  for (const spec of specs) {
    const selector = spec.package
      ? `-Program Any -Package ([EnvGuardPackageSid]::Resolve(${quote(spec.package)}))`
      : spec.program
        ? `-Program ${quote(spec.program)} -Package $null`
        : '-Program Any -Package $null';
    const remote = spec.addresses ? `-RemoteAddress ${spec.addresses.map(quote).join(',')}` : '-RemoteAddress Any';
    const name = ruleName(spec);
    const settings = `-Direction Outbound -Action Block -Profile Any -Enabled True -Service Any -InterfaceType Any -InterfaceAlias Any -LocalAddress Any -LocalPort Any -Protocol ${spec.protocol} -RemotePort ${spec.port} ${selector} ${remote}`;
    lines.push(`if (${quote(name)} -in $existing.Name) { Set-NetFirewallRule -PolicyStore PersistentStore -Name ${quote(name)} ${settings} } else { New-NetFirewallRule -PolicyStore PersistentStore -Name ${quote(name)} -DisplayName ${quote(spec.name)} -Group ${quote(spec.group)} ${settings} | Out-Null }`);
  }
  lines.push(guardVerifiedCount(groups, specs));
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

export function claudeGuardStatusScript(group, specs = null) {
  return [
    "$ErrorActionPreference = 'Stop'",
    FIREWALL_CHECK_SCRIPT,
    ...(specs?.some(spec => spec.package) ? [PACKAGE_SID_SCRIPT] : []),
    guardVerifiedCount(group, specs),
    "ConvertTo-Json -Compress -InputObject @{ count = $count }",
  ].join("\n");
}

function guardVerifiedCount(group, specs) {
  const groups = (Array.isArray(group) ? group : [group]).map(quote).join(',');
  if (!specs?.length) return `$count = @(Get-NetFirewallRule -Group ${groups} -PolicyStore ActiveStore -ErrorAction SilentlyContinue).Count`;
  return [FIREWALL_RULE_CHECK,
    `$rules = @(Get-NetFirewallRule -Group ${groups} -PolicyStore ActiveStore -ErrorAction SilentlyContinue)`, '$count = 0',
    ...specs.map(spec => `if (Test-GuardRule ($rules | Where-Object { $_.Name -eq ${quote(ruleName(spec))} } | Select-Object -First 1) ${quote(spec.program || 'Any')} ${spec.package ? `([EnvGuardPackageSid]::Resolve(${quote(spec.package)}))` : "'Any'"} ${quote(spec.protocol)} ${quote(spec.port)} @(${(spec.addresses || ['Any']).map(quote).join(',')})) { $count++ }`),
  ].join('\n');
}

/**
 * 发现要阻断的 Claude 客户端。
 * 优先用 MSIX 包族名：Store 应用跑在 AppContainer 里，按程序路径的规则对它们不可靠；
 * 同时带上可执行文件路径作为回退（非打包安装的客户端 / Claude Code CLI）。
 *
 * 不自动推导目标 IP：claude.ai 等域名大量落在 Cloudflare 共享网段，按 IP 阻断会误伤半个互联网。
 * 需要按 IP 阻断的用户通过 claude-guard-targets.json 显式提供（见 mergeClaudeGuardTargets）。
 */
export async function discoverClaudeTargets({ platform = process.platform, home = homedir(), env = process.env, exec = run, exists = access, list } = {}) {
  if (platform !== "win32") return { packages: [], programs: [] };
  const targets = await windowsClaudeTargets({ home, env, exec, exists, list });
  // Claude Code CLI：原生安装器落在 ~/.local/bin/claude.exe。
  const cli = path.join(home, ".local", "bin", "claude.exe");
  try { await exists(cli); targets.programs.push(cli); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return targets;
}

/**
 * 合并用户自定义目标（claude-guard-targets.json）。
 * 允许补程序路径与目标地址；不允许用自定义值绕过「至少一个选择器」的约束。
 */
export async function mergeClaudeGuardTargets(base, { stateDir, read = readFile } = {}) {
  const merged = { packages: [...(base?.packages ?? [])], programs: [...(base?.programs ?? [])], addresses: [...(base?.addresses ?? [])], domains: [...(base?.domains ?? CLAUDE_GUARD_DOMAINS)] };
  if (!stateDir) return merged;
  const file = path.join(stateDir, "claude-guard-targets.json");
  let extra;
  try { extra = JSON.parse(await read(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return merged; throw new Error(`fail-closed 目标配置无法读取：${error.message}`); }
  for (const key of ["packages", "programs", "addresses", "domains"]) {
    const values = Array.isArray(extra?.[key]) ? extra[key].filter(value => typeof value === "string" && value.trim()) : [];
    merged[key] = [...new Set([...merged[key], ...values.map(value => value.trim())])];
  }
  return merged;
}

const countOf = (stdout) => {
  const parsed = JSON.parse(String(stdout ?? "").trim() || "{}");
  const value = parsed?.count;
  if (!Number.isInteger(value) || value < 0) throw new Error('防火墙未返回有效规则数量。');
  return value;
};

/** Windows hosts 路径；非 Windows 或读不到 SystemRoot 时返回 null（不碰系统文件）。 */
export function defaultHostsPath(env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return path.join(root, "System32", "drivers", "etc", "hosts");
}

/**
 * 宿主侧 fail-closed 守卫。desired 状态落盘，宿主重启后能自行收敛。
 * armed 永远来自回读（组内实际规则数），不来自「我调用过布防」。
 */
export function createClaudeGuard({ platform = process.platform, stateDir, exec = run, logger = () => {}, hostsPath = defaultHostsPath(), readText = readFile, writeText = writeFile } = {}) {
  const supported = platform === "win32";
  const file = stateDir ? path.join(stateDir, "claude-guard.json") : null;
  let state = { token: null, desired: "released", selectors: null, at: null };
  let cached = { supported, armed: null, directProtected: null, desired: 'released', count: 0, hostsBlocked: null, error: null };
  const snapshot = () => ({ ...cached });

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
    try {
      const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", jsonScript(action)], windowsOptions);
      return countOf(stdout);
    } catch (error) {
      const detail = String(error.stderr || error.message);
      if (detail.includes('[FIREWALL_DISABLED]')) throw new Error('Windows 防火墙未开启，需要确认开启后才能阻止 Claude 直连。', { cause: error });
      throw error;
    }
  }

  async function armHosts(domains, useToken) {
    if (!hostsPath) return false;
    const current = await readText(hostsPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const cleaned = stripHostsBlock(current);
    const next = (cleaned.trimEnd() ? cleaned.trimEnd() + "\r\n" : "") + hostsBlockText(domains, useToken);
    await writeText(hostsPath, next, "utf8");
    if (!hostsBlocked(await readText(hostsPath, "utf8"))) throw new Error("hosts 段未写入。");
    return true;
  }

  async function releaseHosts() {
    if (!hostsPath) return false;
    const current = await readText(hostsPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (!hostsBlocked(current)) return false;
    await writeText(hostsPath, stripHostsBlock(current), "utf8");
    if (hostsBlocked(await readText(hostsPath, "utf8"))) throw new Error("hosts 段未清除。");
    return true;
  }

  async function status() {
    let hosts = false;
    try { hosts = hostsPath ? hostsBlocked(await readText(hostsPath, "utf8")) : false; }
    catch { hosts = null; }
    if (!supported || !state.token) return (cached = { supported, armed: false, directProtected: false, desired: state.desired, count: 0, hostsBlocked: hosts, error: null });
    try {
      const selectors = { ...state.selectors, token: state.token };
      const fullSpecs = selectors.packages?.length || selectors.programs?.length || selectors.addresses?.length ? claudeGuardSpecs(selectors) : [];
      const directSpecs = claudeDirectSpecs(selectors);
      const [count, directCount] = await Promise.all([
        expect(claudeGuardStatusScript(guardGroupName(state.token), state.desired === 'armed' ? fullSpecs : null)),
        expect(claudeGuardStatusScript(`${guardGroupName(state.token)}-Direct`, directSpecs)),
      ]);
      const fullCount = fullSpecs.length;
      const hostsReady = !hostsPath || !(selectors.domains?.length) || hosts === true;
      return (cached = { supported, armed: state.desired === 'armed' && count >= fullCount && hostsReady,
        directProtected: directSpecs.length > 0 && directCount >= directSpecs.length,
        directCount, desired: state.desired, count, hostsBlocked: hosts, error: null });
    } catch (error) {
      return (cached = { supported, armed: null, directProtected: null, desired: state.desired, count: null, hostsBlocked: hosts, error: error.message });
    }
  }

  /**
   * 布防：防火墙规则（按进程/包/地址）+ hosts 段（按域名，覆盖浏览器）。
   * 两部分各自回读；任一部分失败就报错，交给心跳与恢复工具收敛，不能当作已保护。
   */
  async function arm({ token = state.token, packages = [], programs = [], addresses = [], domains = CLAUDE_GUARD_DOMAINS } = {}) {
    if (!supported) throw new Error("当前平台没有实现系统级 fail-closed。");
    // 复用落盘 token，避免重开应用后遗留上一组无法释放的持久规则。
    const useToken = state.token ?? (TOKEN.test(String(token ?? "")) ? token : `g${Date.now().toString(36)}`);
    const hasRules = packages.length || programs.length || addresses.length;
    const specs = hasRules ? claudeGuardSpecs({ token: useToken, packages, programs, addresses }) : [];
    if (!specs.length && !(domains?.length)) throw new Error("fail-closed 缺少阻断目标：需要程序/包/地址或域名之一。");
    await save({ token: useToken, desired: "armed", selectors: { packages, programs, addresses, domains }, at: new Date().toISOString() });
    const directSpecs = claudeDirectSpecs({ token: useToken, packages, programs });
    const errors = [];
    let count = 0;
    if (specs.length) {
      try {
        // Both groups share one PowerShell process and one effective-store scan.
        // Direct rules are installed first; every expected rule is still verified.
        const allSpecs = [...directSpecs, ...specs];
        const script = claudeGuardArmScript(allSpecs);
        // Windows has a command-line length limit. Multiple installed versions
        // may exceed it when combined; retain the separate-group path then.
        if (script.length > 24000 && directSpecs.length) {
          if (await expect(claudeGuardArmScript(directSpecs)) < directSpecs.length) throw new Error('桌面直连阻断规则未全部生效。');
          count = await expect(claudeGuardArmScript(specs));
          if (count < specs.length) errors.push(`规则未全部生效：期望 ${specs.length} 条，实际 ${count} 条`);
        } else {
          const verified = await expect(script);
          if (verified !== allSpecs.length) errors.push(`规则未全部生效：期望 ${allSpecs.length} 条，实际 ${verified} 条`);
          count = Math.max(0, verified - directSpecs.length);
        }
      } catch (error) { errors.push(`规则：${error.message}`); }
    }
    let hosts = false;
    try { hosts = await armHosts(domains, useToken); }
    catch (error) { errors.push(`hosts：${error.message}`); }
    if (errors.length) throw new Error(`fail-closed 布防未全部生效：${errors.join("；")}`);
    logger(`[claude-guard] 已布防：${specs.length} 条规则、hosts ${hosts ? "已写入" : "未启用"}（令牌 ${useToken}）。`);
    return (cached = { supported, desired: 'armed', armed: true, directProtected: directSpecs.length > 0, count, hostsBlocked: hosts, error: null });
  }

  async function release({ keepDirect = false } = {}) {
    if (!supported) return { armed: false, count: 0 };
    // 允许隧道时只移除临时全阻断，桌面直连规则一直存在，覆盖无法预知的内核崩溃。
    const directSpecs = state.token ? claudeDirectSpecs({ ...state.selectors, token: state.token }) : [];
    if (keepDirect && directSpecs.length) {
      // Read effective filters before releasing. Correct persistent rules need
      // no rewrite; repair missing/altered rules before removing full blocking.
      const directCount = await expect(claudeGuardStatusScript(`${guardGroupName(state.token)}-Direct`, directSpecs));
      if (directCount < directSpecs.length && await expect(claudeGuardArmScript(directSpecs)) < directSpecs.length) throw new Error('桌面直连阻断未确认，拒绝放行。');
    }
    await save({ desired: keepDirect ? 'protected' : 'released', at: new Date().toISOString() });
    const errors = [];
    let count = 0;
    if (state.token) {
      try {
        count = await expect(claudeGuardReleaseScript(guardGroupName(state.token)));
        if (count > 0) errors.push(`规则未删除：仍有 ${count} 条`);
        if (!keepDirect && await expect(claudeGuardReleaseScript(`${guardGroupName(state.token)}-Direct`)) > 0) errors.push('桌面直连规则未删除');
      } catch (error) { errors.push(`规则：${error.message}`); }
    }
    let hosts = false;
    try { hosts = await releaseHosts(); }
    catch (error) { errors.push(`hosts：${error.message}`); }
    if (errors.length) throw new Error(`fail-closed 撤防未完成：${errors.join("；")}`);
    logger("[claude-guard] 已撤防。");
    return (cached = { supported, desired: state.desired, armed: false, directProtected: keepDirect && directSpecs.length > 0, count, hostsBlocked: false, hostsCleared: hosts, error: null });
  }

  /** 宿主启动/后台核验：按落盘意图收敛；心跳只能读缓存，不得覆盖意图。 */
  async function reconcile(selectors = null, { desired = null } = {}) {
    if (!supported) return { armed: false, count: 0 };
    await load();
    if (['armed', 'protected', 'released'].includes(desired)) await save({ desired });
    if (state.desired === 'protected') {
      const current = await status();
      const hasDirect = claudeDirectSpecs({ ...state.selectors, token: state.token }).length > 0;
      if ((!hasDirect || current.directProtected) && current.count === 0 && current.hostsBlocked === false) return current;
      return release({ keepDirect: true });
    }
    if (state.desired !== "armed") {
      const current = await status();
      return current.error || current.count || current.directCount || current.hostsBlocked ? release() : current;
    }
    const source = selectors ?? state.selectors;
    if (!source) return { armed: false, count: 0 };
    const current = await status();
    const hasDirect = claudeDirectSpecs({ ...source, token: state.token }).length > 0;
    if (current.armed && (!hasDirect || current.directProtected)) return current;
    return arm({ token: state.token, ...source });
  }

  const tracked = action => async (...args) => {
    try { return await action(...args); }
    catch (error) { cached = { ...cached, desired: state.desired, armed: null, directProtected: null, error: error.message }; throw error; }
  };
  // 宿主串行执行变更；慢速 PowerShell 运行期间 /health 仍可立即读取缓存。
  return { supported, arm: tracked(arm), release: tracked(release), status, snapshot, reconcile: tracked(reconcile), load,
    enableFirewall: async confirmed => {
      if (!supported) throw new Error('仅 Windows 支持此操作。');
      if (await expect(enableFirewallScript(confirmed)) !== 3) throw new Error('Windows 防火墙开启后核验失败。');
      return { enabled: true };
    },
  };
}
