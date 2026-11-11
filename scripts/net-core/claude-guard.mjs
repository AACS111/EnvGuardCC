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
export async function discoverClaudeTargets({ platform = process.platform, home = homedir(), exec = run, exists = access } = {}) {
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
    if (!supported || !state.token) return { supported, armed: false, desired: state.desired, count: 0, hostsBlocked: hosts, error: null };
    try {
      const count = await expect(claudeGuardStatusScript(guardGroupName(state.token)));
      return { supported, armed: count > 0 || hosts === true, desired: state.desired, count, hostsBlocked: hosts, error: null };
    } catch (error) {
      return { supported, armed: hosts === true ? true : null, desired: state.desired, count: null, hostsBlocked: hosts, error: error.message };
    }
  }

  /**
   * 布防：防火墙规则（按进程/包/地址）+ hosts 段（按域名，覆盖浏览器）。
   * 两部分各自回读；任一部分失败就报错，交给心跳与恢复工具收敛，不能当作已保护。
   */
  async function arm({ token = state.token, packages = [], programs = [], addresses = [], domains = CLAUDE_GUARD_DOMAINS } = {}) {
    if (!supported) throw new Error("当前平台没有实现系统级 fail-closed。");
    const useToken = TOKEN.test(String(token ?? "")) ? token : `g${Date.now().toString(36)}`;
    const hasRules = packages.length || programs.length || addresses.length;
    const specs = hasRules ? claudeGuardSpecs({ token: useToken, packages, programs, addresses }) : [];
    if (!specs.length && !(domains?.length)) throw new Error("fail-closed 缺少阻断目标：需要程序/包/地址或域名之一。");
    await save({ token: useToken, desired: "armed", selectors: { packages, programs, addresses, domains }, at: new Date().toISOString() });
    const errors = [];
    let count = 0;
    if (specs.length) {
      try {
        count = await expect(claudeGuardArmScript(specs));
        if (count < specs.length) errors.push(`规则未全部生效：期望 ${specs.length} 条，实际 ${count} 条`);
      } catch (error) { errors.push(`规则：${error.message}`); }
    }
    let hosts = false;
    try { hosts = await armHosts(domains, useToken); }
    catch (error) { errors.push(`hosts：${error.message}`); }
    if (errors.length) throw new Error(`fail-closed 布防未全部生效：${errors.join("；")}`);
    logger(`[claude-guard] 已布防：${specs.length} 条规则、hosts ${hosts ? "已写入" : "未启用"}（令牌 ${useToken}）。`);
    return { armed: true, count, hostsBlocked: hosts };
  }

  async function release() {
    if (!supported) return { armed: false, count: 0 };
    await save({ desired: "released", at: new Date().toISOString() });
    const errors = [];
    let count = 0;
    if (state.token) {
      try {
        count = await expect(claudeGuardReleaseScript(guardGroupName(state.token)));
        if (count > 0) errors.push(`规则未删除：仍有 ${count} 条`);
      } catch (error) { errors.push(`规则：${error.message}`); }
    }
    let hosts = false;
    try { hosts = await releaseHosts(); }
    catch (error) { errors.push(`hosts：${error.message}`); }
    if (errors.length) throw new Error(`fail-closed 撤防未完成：${errors.join("；")}`);
    logger("[claude-guard] 已撤防。");
    return { armed: false, count, hostsBlocked: false, hostsCleared: hosts };
  }

  /** 宿主重启/心跳用：按期望状态与实际规则数收敛。desired 可覆盖（心跳带新意图时）。 */
  async function reconcile(selectors = null, { desired = null } = {}) {
    if (!supported) return { armed: false, count: 0 };
    await load();
    if (desired === "armed" || desired === "released") await save({ desired });
    if (state.desired !== "armed") {
      return state.token || hostsPath ? release() : { armed: false, count: 0 };
    }
    const source = selectors ?? state.selectors;
    if (!source) return { armed: false, count: 0 };
    const current = await status();
    const rulesReady = current.count === null ? false : (current.count > 0 || !(source.packages?.length || source.programs?.length || source.addresses?.length));
    if (rulesReady && current.hostsBlocked === true) return { armed: true, count: current.count };
    return arm({ token: state.token, ...source });
  }

  return { supported, arm, release, status, reconcile, load };
}
