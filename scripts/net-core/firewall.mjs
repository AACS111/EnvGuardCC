// macOS 会话断流保护。规则在 PF 中独立存活；宿主失联不解除阻断。
// 不加载 /etc/pf.conf、不清空主规则、不调用 pfctl -d。只管理一个固定子 anchor。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, rm, lstat, open } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
export const GUARD_ANCHOR = "com.apple/000.envguardcc";
export const GUARD_INTERFACE = "utun90";
const ROOT = "/Library/PrivilegedHelperTools/com.envguardcc.kernelhost.state";
const safePort = value => Number.isInteger(value) && value > 0 && value <= 65535;

export function firewallEndpoints(config) {
  const group = config?.["proxy-groups"]?.find(item => item?.name === "CLAUDE-PIN" && item.type === "select");
  const node = config?.proxies?.find(item => item?.name === group?.proxies?.[0]);
  if (!node || !safePort(node.port) || node["dialer-proxy"]) throw new Error("严格模式需要一个可直接连接、端口有效的固定节点。");
  const addresses = isIP(node.server) ? [node.server] : config.hosts?.[node.server];
  const list = Array.isArray(addresses) ? addresses : typeof addresses === "string" ? [addresses] : [];
  if (!list.length || list.some(address => !isIP(address))) throw new Error("严格模式需要先验证并缓存节点服务器的 IP，不能放开通用 DNS 作为降级。");
  return [...new Set(list)].map(address => ({ address, port: node.port }));
}

export function firewallRules(endpoints, { active = false } = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 32) throw new Error("断流保护的节点端点无效。");
  const lines = ["# EnvGuardCC session guard", 'pass quick on lo0 all no state'];
  if (active) lines.push(`pass quick on ${GUARD_INTERFACE} all no state`);
  for (const { address, port } of endpoints) {
    const family = isIP(address);
    if (!family || !safePort(port)) throw new Error("断流保护只接受 IP 和有效端口。");
    lines.push(`pass out quick ${family === 4 ? "inet" : "inet6"} proto { tcp udp } from any to ${address} port ${port} user root keep state`);
  }
  // 只保留 IPv4 DHCP，防止切换 Wi-Fi 后无法获取地址；不放行普通公网 DNS。
  lines.push("pass out quick inet proto udp from any port 68 to 255.255.255.255 port 67 no state");
  lines.push("pass in quick inet proto udp from any port 67 to any port 68 no state");
  lines.push("pass out quick inet6 proto ipv6-icmp from any to { fe80::/10 ff02::/16 } icmp6-type { 133 135 136 } no state");
  lines.push("pass in quick inet6 proto ipv6-icmp from fe80::/10 to any icmp6-type { 134 135 136 } no state");
  lines.push('block drop quick all label "envguardcc-session-guard"');
  return lines.join("\n") + "\n";
}

export function assertPfAttachment(mainRules, anchors, translations, interfaces) {
  // 限定已知的系统默认入口，拒绝会抢先 pass/quick 或绕过过滤的自定义配置。
  const rules = String(mainRules).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    .filter(line => !/^scrub-anchor "com\.apple\/\*" all(?: fragment reassemble)?$/.test(line));
  if (rules.length !== 1 || !/^anchor "com\.apple\/\*"(?: all)?$/.test(rules[0])) throw new Error("当前 PF 主规则不是受支持的 Apple 默认入口；为保留其他防火墙，严格模式拒绝接管。");
  const children = String(anchors).split(/\r?\n/).map(line => line.trim().replace(/^com\.apple\//, "")).filter(Boolean);
  if (children.some(name => name !== "000.envguardcc" && name < "000.envguardcc")) throw new Error("PF 存在早于 EGCC 的子规则，无法证明阻断优先级。");
  if (/^\s*(?:no\s+)?(?:nat|rdr|binat)\s/m.test(String(translations))) throw new Error("当前 PF 存在地址转换规则，严格模式尚未支持该网络布局。");
  if (/\bskip\b/i.test(String(interfaces))) throw new Error("PF 存在跳过过滤的网卡，无法启用严格模式。");
}

export function createFirewallGuard({ platform = process.platform, stateDir = ROOT, run = execute, isRoot = () => process.getuid?.() === 0 } = {}) {
  const provider = platform === "darwin" ? "macos-pf" : null;
  let state = { armed: false, phase: "off", endpoints: [], token: null, checkedAt: null, reason: null, releaseId: null };
  let pending = Promise.resolve();
  async function withLock(action) {
    if (!provider || !isRoot()) return action();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(stateDir);
    if (directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error("断流保护状态目录必须是私有普通目录。");
    const lock = path.join(stateDir, "guard.lock");
    const deadline = Date.now() + 15000;
    let handle;
    while (!handle) {
      try {
        handle = await open(lock, "wx", 0o600);
        try { await handle.writeFile(String(process.pid)); }
        catch (error) { await handle.close(); await rm(lock, { force: true }); throw error; }
      }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const pid = Number(await readFile(lock, "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (failure) { if (failure.code === "ESRCH") { await rm(lock, { force: true }); continue; } }
          } else if (Date.now() - (await lstat(lock)).mtimeMs > 5000) { await rm(lock, { force: true }); continue; }
        } catch (failure) { if (failure.code === "ENOENT") continue; throw failure; }
        if (Date.now() > deadline) throw new Error("已有系统断流操作尚未完成，请稍后重试。");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try {
      try {
        const saved = JSON.parse(await readFile(path.join(stateDir, "guard.json"), "utf8"));
        if (typeof saved.armed === "boolean") state = { ...state, ...saved };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      return await action();
    } finally { await handle.close(); await rm(lock, { force: true }); }
  }
  const serialized = action => (...args) => {
    const next = pending.then(() => withLock(() => action(...args))); pending = next.catch(() => {}); return next;
  };
  const call = async args => {
    if (!provider || !isRoot()) throw new Error("系统断流保护需要 macOS 特权宿主；其他平台尚不支持。");
    return run("/sbin/pfctl", args, { timeout: 10000, maxBuffer: 1024 * 1024 });
  };
  const file = path.join(stateDir, "guard.json");
  const rulesFile = path.join(stateDir, "guard.pf");
  async function save() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const info = await lstat(stateDir);
    if (info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("断流保护状态目录必须是私有普通目录。");
    const temporary = `${file}.${process.pid}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  async function attachment() {
    const [main, anchors, translations, interfaces] = await Promise.all([
      call(["-sr"]), call(["-a", "com.apple", "-s", "Anchors"]), call(["-a", "*", "-sn"]), call(["-s", "Interfaces", "-v"]),
    ]);
    assertPfAttachment(main.stdout, anchors.stdout, translations.stdout, interfaces.stdout);
  }
  async function load(active) {
    await writeFile(rulesFile, firewallRules(state.endpoints, { active }), { mode: 0o600 });
    await call(["-n", "-a", GUARD_ANCHOR, "-f", rulesFile]);
    await call(["-a", GUARD_ANCHOR, "-f", rulesFile]);
    const actual = await call(["-a", GUARD_ANCHOR, "-sr"]);
    if (!actual.stdout.includes("envguardcc-session-guard")) throw new Error("PF 未返回已安装的 EGCC 阻断规则。");
  }
  async function arm(config, { expectedReleaseId = state.releaseId } = {}) {
    if (!provider || !isRoot()) throw new Error("系统断流保护需要 macOS 特权宿主；其他平台尚不支持。");
    if (expectedReleaseId !== state.releaseId) throw new Error("独立恢复工具已解除旧会话，请明确重新开启严格模式。");
    if (state.phase === "releasing") await release();
    const endpoints = firewallEndpoints(config);
    let occupied = false;
    try { await run("/sbin/ifconfig", [GUARD_INTERFACE], { timeout: 5000 }); occupied = true; }
    catch (error) { if (error.code !== 1 || !/does not exist|no such interface/i.test(error.stderr ?? "")) throw new Error("无法核验专属网卡归属，未启用系统阻断。", { cause: error }); }
    if (occupied) throw new Error("utun90 已被占用，不能把其他 VPN 的网卡当作 EGCC 隧道。");
    await attachment();
    state = { ...state, armed: true, phase: "blocked", endpoints, reason: null, checkedAt: null };
    // 先持久化阻断意愿；任何后续失败都保留可恢复状态，绝不自动解除。
    await save();
    try {
      await load(false);
      if (!state.token) {
        const enabled = await call(["-E"]);
        const token = `${enabled.stdout ?? ""}\n${enabled.stderr ?? ""}`.match(/Token\s*:\s*(\d+)/i)?.[1];
        if (!token) throw new Error("PF 没有返回可恢复的启用引用令牌。");
        state.token = token;
        await save();
      }
      // 严格模式启动是显式的网络重连操作；清理旧 IPv4/IPv6 状态避免既有直连绕过新规则。
      await call(["-k", "0.0.0.0/0"]);
      await call(["-k", "::/0"]);
      state.checkedAt = new Date().toISOString(); await save();
    } catch (error) { state.reason = error.message; await save(); throw error; }
    return status();
  }
  async function activate() {
    if (state.phase === "releasing") { await release(); throw new Error("独立恢复操作已解除保护，不能继续放行旧会话。"); }
    if (!state.armed) throw new Error("系统阻断尚未建立。");
    const route = await run("/sbin/route", ["-n", "get", "198.18.0.1"], { timeout: 5000 });
    if (!new RegExp(`interface:\\s*${GUARD_INTERFACE}\\b`).test(route.stdout)) throw new Error("Fake-IP 路由没有指向 EGCC 专属网卡，保持阻断。");
    await attachment();
    await load(true);
    state.phase = "active"; state.reason = null; state.checkedAt = new Date().toISOString();
    await save(); return status();
  }
  async function block(reason = "连接尚未重新验证。") {
    if (state.phase === "releasing") return release();
    if (!state.armed) return status();
    state.phase = "blocked"; state.reason = reason; state.checkedAt = null;
    await save(); await load(false); return status();
  }
  async function inspect() {
    if (state.phase === "releasing") return release();
    if (!state.armed) return status();
    try {
      await attachment();
      const [info, rules] = await Promise.all([call(["-s", "info"]), call(["-a", GUARD_ANCHOR, "-sr"])]);
      if (!/Status:\s*Enabled/i.test(info.stdout) || !rules.stdout.includes("envguardcc-session-guard")) throw new Error("PF 阻断状态丢失。");
      state.checkedAt = new Date().toISOString();
    } catch (error) { await block(error.message); throw error; }
    return status();
  }
  async function restore() {
    if (!provider || !isRoot()) return status();
    let saved;
    try { saved = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return status(); throw error; }
    if (!saved.armed) return status();
    if (saved.phase === "releasing") { state = { ...state, ...saved }; return release(); }
    firewallRules(saved.endpoints);
    if (saved.token !== null && !/^\d+$/.test(String(saved.token))) throw new Error("保存的 PF 引用令牌无效。");
    state = { ...state, ...saved, phase: "blocked", checkedAt: null };
    await attachment(); await load(false); await save(); return status();
  }
  async function release() {
    if (!state.armed) {
      // 紧急恢复不依赖当前主规则是否兼容，也不先重新安装阻断规则。
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (saved.armed) state = { ...state, ...saved };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (!state.armed) return status();
    if (state.token !== null && !/^\d+$/.test(String(state.token))) throw new Error("保存的 PF 引用令牌无效。");
    // 外部恢复意愿先落盘；宿主或本进程中途退出后也不能重新安装阻断。
    state.phase = "releasing"; state.checkedAt = null; state.releaseId = randomUUID();
    await save();
    await call(["-a", GUARD_ANCHOR, "-F", "rules"]);
    const remaining = await call(["-a", GUARD_ANCHOR, "-sr"]);
    if (remaining.stdout.trim()) throw new Error("EGCC 阻断规则尚未确认移除。");
    if (state.token) {
      const references = await call(["-s", "References"]);
      if (new RegExp(`\\b${state.token}\\b`).test(references.stdout)) await call(["-X", state.token]);
    }
    state = { armed: false, phase: "off", endpoints: [], token: null, checkedAt: new Date().toISOString(), reason: null, releaseId: state.releaseId };
    await save(); return status();
  }
  function status() {
    return { provider, supported: Boolean(provider && isRoot()), armed: state.armed, phase: state.phase, checkedAt: state.checkedAt, reason: state.reason, releaseId: state.releaseId };
  }
  return { status, arm: serialized(arm), activate: serialized(activate), block: serialized(block), inspect: serialized(inspect), restore: serialized(restore), release: serialized(release) };
}
