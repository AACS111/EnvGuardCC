// 区域锁定端到端：真实 mihomo + 本地假节点，出口从 HK 切到 SG 后自动/手动解除。
// 不依赖任何第三方机场，端口与状态目录都在临时目录。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createKernelRuntime } from "./net-core/runtime.mjs";

const binary = path.resolve(import.meta.dirname, "../node_modules/.checkcc-kernel", process.platform === "win32" ? "mihomo.exe" : "mihomo");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 假机场节点：返回可切换的 IP/国家。HTTP 请求（探测走绝对 URI）直接响应。 */
async function fakeNode() {
  let country = "HK";
  let ip = "203.0.113.9";
  const body = () => JSON.stringify({ ip, country_code: country, country, success: true });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
    response.end(body());
  });
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // 内核把目标交给 http 类型的节点时会先 CONNECT；只处理普通 HTTP 请求会被当成异常断开。
  server.on("connect", (_request, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let received = head.toString();
    const respond = (chunk) => {
      received += chunk.toString();
      if (!received.includes("\r\n\r\n")) return;
      socket.removeListener("data", respond);
      const payload = body();
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
    };
    socket.on("data", respond);
    socket.on("error", () => {});
    respond(Buffer.alloc(0));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    setCountry(next, nextIp = "203.0.113.10") { country = next; ip = nextIp; },
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.closeAllConnections?.(); server.close(resolve); }),
  };
}

async function runLockFlow(t, platform, scenario) {
  try { await fs.access(binary); } catch { t.skip("当前平台未准备内核"); return; }
  const proxy = await fakeNode();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkcc-region-lock-"));
  const apiPort = await freePort(), mixedPort = await freePort();
  const endpoint = "http://203.0.113.77/";
  let scheduled = null;
  const runtime = await createKernelRuntime({
    stateDir: dir,
    platform,
    env: {
      CHECKCC_NET_CORE_BINARY: binary, CHECKCC_NET_CORE_TUN: "0",
      CHECKCC_NET_CORE_DNS: "https://192.0.2.53/dns-query",
      CHECKCC_NET_CORE_API_PORT: String(apiPort), CHECKCC_NET_CORE_MIXED_PORT: String(mixedPort),
      CHECKCC_NET_CORE_EXIT_PROBE_URL: endpoint,
      // 缩短自动复检间隔与抢修窗口，让回归测试不必真的等几分钟。
      CHECKCC_NET_CORE_EXIT_CHECK_MS: "400",
      CHECKCC_NET_CORE_RECOVERY_WINDOW_MS: "0",
    },
    healthScheduler: { every: callback => { scheduled = callback; return { unref() {} }; }, clear: () => { scheduled = null; } },
  });
  const configFile = path.join(dir, "net-core", "config.yaml");
  const hasReject = async () => (await fs.readFile(configFile, "utf8").catch(() => "")).includes("DOMAIN-SUFFIX,claude.ai,REJECT");
  // 阻断改走运行时守卫组：断言它真的切到了 REJECT，而不是靠重载配置。
  const guardBlocked = async () => (await runtime.report()).claudeGuard === "blocked";
  // 等过一个复检周期再触发健康检查，模拟时间推进；并行跑测试时不能只靠固定延时（健康检查可能被上一轮占用）。
  const lockProgress = async () => { const lock = (await runtime.report()).regionLock; return lock?.locked ? (lock.recheckAttempts ?? 0) : -1; };
  const tick = async () => {
    const before = await lockProgress();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await scheduled?.();
      if (await lockProgress() !== before) return;
    }
    throw new Error("自动复检未在 8 秒内产生新证据。");
  };
  try {
    await runtime.importNodes([{ name: "fake-node", type: "http", server: "127.0.0.1", port: proxy.port }], { selected: "fake-node" });
    assert.equal(await runtime.start(), true);
    // 并行跑整套测试时首次出口探测可能超时（内核启动慢）：多复检几轮，直到拿到「网络锁 + 明确出口国家」。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const lock = (await runtime.report()).regionLock;
      if (lock?.locked && lock.countryCode) break;
      await tick();
    }
    assert.equal((await runtime.report()).regionLock?.countryCode, "HK", "测试前置：网络锁必须记录到出口国家");
    await scenario({ runtime, proxy, hasReject, guardBlocked, tick });
  } finally {
    await runtime.stop().catch(() => {});
    await proxy.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const autoRecoverScenario = async ({ runtime, proxy, hasReject, guardBlocked, tick }) => {
  const locked = await runtime.report();
  assert.equal(locked.regionLock?.locked, true, "HK 出口必须锁定");
  // 启动时的一次探测失败/异常只能算是「无法确认出口」，不能一步跳到必须人工解除的地区锁。
  assert.equal(locked.regionLock?.type, "network", "单次异常先按网络锁处理");
  assert.equal(locked.regionLock?.autoRecover, true);
  assert.equal(locked.regionLock?.countryCode, "HK");
  assert.equal(await guardBlocked(), true, "锁定时必须把 Claude 守卫组切到 REJECT");
  assert.equal(await hasReject(), false, "网络锁不得靠重载配置来阻断 Claude");
  // 网络恢复：用户什么都不点，下一次自动复检通过就立即解除。
  proxy.setCountry("SG");
  await tick();
  const after = await runtime.report();
  assert.equal(after.regionLock?.locked, false, "网络一恢复就自动解除，不需要手动复检");
  assert.equal(await guardBlocked(), false, "自动解除后必须把守卫组切回固定出口");
  assert.equal(await hasReject(), false, "网络锁解除同样不重载配置");
};

const escalateScenario = async ({ runtime, proxy, hasReject, guardBlocked, tick }) => {
  // 单次复检不足以升级：第一次仍然是可自动解除的网络锁。
  await tick();
  assert.equal((await runtime.report()).regionLock?.type, "network", "一次确认不得升级为地区锁");
  // 继续确认直到升级（并行负载下每次复检耗时不完全一致，按状态等而不是数次数）。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && (await runtime.report()).regionLock?.type !== "region") await tick();
  const escalated = await runtime.report();
  assert.equal(escalated.regionLock?.locked, true);
  assert.equal(escalated.regionLock?.type, "region", "连续三次探到不支持地区才升级");
  assert.equal(escalated.regionLock?.autoRecover, false);
  assert.equal(await guardBlocked(), true);
  assert.equal(await hasReject(), false, "地区锁同样走守卫组，不重载配置");
  // 地区锁代表出口确实不受支持：网络恢复也不会自动解除，必须人工确认新出口。
  proxy.setCountry("SG");
  await tick();
  await tick();
  assert.equal((await runtime.report()).regionLock?.locked, true, "地区锁不得被自动解除");
  const unlocked = await runtime.unlockRegion();
  assert.equal(unlocked.exit?.countryCode, "SG");
  assert.equal((await runtime.report()).regionLock?.locked, false);
  assert.equal(await hasReject(), false, "解除后不得残留 REJECT");
};

test("网络波动锁定后无需手动复检：出口恢复并连续验证通过就自动解除", { timeout: 60000 }, async (t) => {
  await runLockFlow(t, process.platform, autoRecoverScenario);
});

test("出口连续三次确认不在支持地区才升级地区锁，升级后必须人工解除", { timeout: 60000 }, async (t) => {
  await runLockFlow(t, process.platform, escalateScenario);
});

test("Windows 平台路径：锁定与自动复检不依赖 macOS 专有逻辑", { timeout: 60000, skip: process.platform === "win32" ? "Windows 已在上一用例覆盖" : false }, async (t) => {
  // 在 macOS 上以 platform=win32 运行同一流程，验证锁/解锁没有走 darwin 分支（如 osascript、PF）。
  await runLockFlow(t, "win32", autoRecoverScenario);
});
