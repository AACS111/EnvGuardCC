// 显式 --apply 的 macOS 系统测试；需要管理员，短暂重连网络，独立看门狗超时解除本测试规则。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { createFirewallGuard, GUARD_ANCHOR } from "./net-core/firewall.mjs";
import { buildKernelConfig, strictKernelConfig } from "./net-core/config.mjs";
import { createNetCore } from "./net-core.mjs";

const run = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform !== "darwin" || process.getuid?.() !== 0) throw new Error("此测试需要 macOS 管理员权限。");

if (args.includes("--watchdog")) {
  const stateDir = value("--state-dir");
  if (!stateDir || !path.basename(stateDir).startsWith("egcc-pf-live-")) throw new Error("看门狗只处理本测试的私有目录。");
  await writeFile(path.join(stateDir, "watchdog-ready"), String(process.pid), { mode: 0o600 });
  setTimeout(async () => {
    try { await createFirewallGuard({ stateDir }).release(); process.exit(0); }
    catch { process.exit(1); }
  }, 25000);
} else {
  if (!args.includes("--apply")) throw new Error("此测试会短暂中断网络。仅显式传入 --apply 才执行。");
  const existing = await run("/sbin/pfctl", ["-a", GUARD_ANCHOR, "-sr"]);
  if (existing.stdout.trim()) throw new Error("已有 EGCC 系统规则，不覆盖用户当前会话。请先关闭严格模式。");
  const mainBefore = (await run("/sbin/pfctl", ["-sr"])).stdout;
  const infoBefore = (await run("/sbin/pfctl", ["-s", "info"])).stdout;
  const stateDir = await mkdtemp(path.join(tmpdir(), "egcc-pf-live-"));
  const guard = createFirewallGuard({ stateDir });
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const probeUrl = "https://example.com/";
  const probeAddress = (await dns.lookup(new URL(probeUrl).hostname, { family: 4 })).address;
  const get = () => new Promise((resolve, reject) => {
    const request = https.get(probeUrl, { agent, family: 4, lookup: (_, __, callback) => callback(null, probeAddress, 4), headers: { "User-Agent": "EnvGuardCC-local-network-test" } }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode));
    });
    const timer = setTimeout(() => request.destroy(new Error("NETWORK_TEST_TIMEOUT")), 2500);
    request.once("error", error => { clearTimeout(timer); reject(error); });
    request.once("close", () => clearTimeout(timer));
  });
  let watchdog;
  let core, relay;
  let restored = false;
  const result = { platform: "darwin", baselineReachable: false, directBlocked: false, restored: false, mainRulesPreserved: false, enabledStatePreserved: false };
  try {
    await get(); result.baselineReachable = true;
    const childEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/var/root" };
    watchdog = spawn(process.execPath, [script, "--watchdog", "--state-dir", stateDir], { detached: true, stdio: "ignore", env: childEnv });
    watchdog.unref();
    let watchdogReady = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await access(path.join(stateDir, "watchdog-ready")); process.kill(watchdog.pid, 0); watchdogReady = true; break; } catch { await pause(50); }
    }
    if (!watchdogReady) throw new Error("独立超时恢复进程未就绪，未加载 PF 规则。");
    // 不占用其他 VPN 的网卡；本测试只使用自建回环代理和带随机 nonce 的受控响应。
    let occupied = false;
    try { await run("/sbin/ifconfig", ["utun90"]); occupied = true; } catch { /* interface absent */ }
    if (occupied) throw new Error("utun90 已存在，不接管或停止其他 VPN。");
    const nonce = randomUUID();
    const sockets = new Set();
    relay = http.createServer((_, response) => response.end(nonce));
    relay.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
    relay.on("connect", (_, socket, head) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let received = head.toString();
      const respond = chunk => {
        received += chunk.toString();
        if (received.includes("\r\n\r\n")) { socket.removeListener("data", respond); socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(nonce)}\r\nConnection: close\r\n\r\n${nonce}`); }
      };
      socket.on("data", respond); socket.setTimeout(3000, () => socket.destroy()); respond(Buffer.alloc(0));
    });
    relay.destroyConnections = () => { for (const socket of sockets) socket.destroy(); };
    await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
    const free = async () => { const server = http.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
    const apiPort = await free(), mixedPort = await free();
    const secret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const config = strictKernelConfig(buildKernelConfig({ proxies: [{ name: "loopback-test", type: "http", server: "127.0.0.1", port: relay.address().port }], secret, apiPort, mixedPort }));
    await guard.arm(config);
    try { await get(); } catch { result.directBlocked = true; }
    if (!result.directBlocked) throw new Error("既有直连连接没有被阻断。");
    const configPath = path.join(stateDir, "config.yaml");
    const { serializeKernelConfig } = await import("./net-core/config.mjs");
    await writeFile(configPath, serializeKernelConfig(config), { mode: 0o600 });
    const binary = path.resolve(path.dirname(script), "../node_modules/.checkcc-kernel/mihomo");
    core = createNetCore({ binary, configPath, homeDir: stateDir, apiPort, secret });
    await core.start();
    await guard.activate();
    const routed = await new Promise((resolve, reject) => {
      const request = http.get("http://203.0.113.77/egcc-live-check", response => { let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve(body)); });
      request.setTimeout(3000, () => request.destroy(new Error("TUN_TEST_TIMEOUT"))); request.on("error", reject);
    });
    result.tunnelRouted = routed === nonce;
    if (!result.tunnelRouted) throw new Error("系统请求没有经过专属 TUN 和受控代理。");
    process.kill(core.state().pid, "SIGKILL");
    await pause(300);
    try { await get(); result.kernelCrashBlocked = false; } catch { result.kernelCrashBlocked = true; }
    if (!result.kernelCrashBlocked) throw new Error("强杀内核后发现直连。");
  } catch (error) { result.error = error.message; }
  finally {
    agent.destroy();
    if (core) { try { await core.stop(); } catch (error) { result.kernelCleanupError = error.message; } }
    if (relay) { relay.destroyConnections(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
    try {
      await createFirewallGuard({ stateDir }).release();
      await guard.inspect();
      if (guard.status().armed) throw new Error("原控制实例没有尊重独立恢复意愿。");
      result.independentRecovery = true;
      const after = (await run("/sbin/pfctl", ["-a", GUARD_ANCHOR, "-sr"])).stdout;
      if (after.trim()) throw new Error("测试规则仍存在。");
      result.restored = true; restored = true;
    } catch (error) { result.recoveryError = error.message; }
    if (restored && watchdog?.pid) { try { watchdog.kill("SIGTERM"); } catch { /* already exited */ } }
    result.mainRulesPreserved = (await run("/sbin/pfctl", ["-sr"])).stdout === mainBefore;
    const infoAfter = (await run("/sbin/pfctl", ["-s", "info"])).stdout;
    result.enabledStatePreserved = /Status:\s*Enabled/.test(infoAfter) === /Status:\s*Enabled/.test(infoBefore);
    if (restored) await rm(stateDir, { recursive: true, force: true });
  }
  if (result.restored && result.baselineReachable) {
    try { await get(); result.reconnected = true; } catch { result.reconnected = false; }
    agent.destroy();
  }
  result.passed = result.baselineReachable && result.directBlocked && result.tunnelRouted && result.kernelCrashBlocked && result.independentRecovery === true && result.restored && result.mainRulesPreserved && result.enabledStatePreserved && result.reconnected === true;
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
