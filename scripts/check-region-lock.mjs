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

async function runLockFlow(t, platform) {
  try { await fs.access(binary); } catch { t.skip("当前平台未准备内核"); return; }
  const proxy = await fakeNode();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkcc-region-lock-"));
  const apiPort = await freePort(), mixedPort = await freePort();
  const endpoint = "http://203.0.113.77/";
  const runtime = await createKernelRuntime({
    stateDir: dir,
    platform,
    env: {
      CHECKCC_NET_CORE_BINARY: binary, CHECKCC_NET_CORE_TUN: "0",
      CHECKCC_NET_CORE_DNS: "https://192.0.2.53/dns-query",
      CHECKCC_NET_CORE_API_PORT: String(apiPort), CHECKCC_NET_CORE_MIXED_PORT: String(mixedPort),
      CHECKCC_NET_CORE_EXIT_PROBE_URL: endpoint,
    },
  });
  const configFile = path.join(dir, "net-core", "config.yaml");
  const hasReject = async () => (await fs.readFile(configFile, "utf8").catch(() => "")).includes("DOMAIN-SUFFIX,claude.ai,REJECT");
  try {
    await runtime.importNodes([{ name: "fake-node", type: "http", server: "127.0.0.1", port: proxy.port }], { selected: "fake-node" });
    assert.equal(await runtime.start(), true);
    const locked = await runtime.report();
    assert.equal(locked.regionLock?.locked, true, "HK 出口必须锁定");
    assert.equal(locked.regionLock?.type, "region");
    assert.equal(locked.regionLock?.countryCode, "HK");
    assert.equal(await hasReject(), true, "锁定时必须写入 Claude REJECT");
    // 切换节点不会自动解除地区锁：必须明确复检。
    proxy.setCountry("SG");
    const stillLocked = await runtime.report();
    assert.equal(stillLocked.regionLock?.locked, true);
    const unlocked = await runtime.unlockRegion();
    assert.equal(unlocked.exit?.countryCode, "SG");
    const after = await runtime.report();
    assert.equal(after.regionLock?.locked, false);
    assert.equal(await hasReject(), false, "解除后不得残留 REJECT");
  } finally {
    await runtime.stop().catch(() => {});
    await proxy.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("固定出口 HK → 区域锁定并拒绝 Claude；切到 SG 后复检解除", { timeout: 60000 }, async (t) => {
  await runLockFlow(t, process.platform);
});

test("Windows 平台路径：区域锁定与解除不依赖 macOS 专有逻辑", { timeout: 60000, skip: process.platform === "win32" ? "Windows 已在上一用例覆盖" : false }, async (t) => {
  // 在 macOS 上以 platform=win32 运行同一流程，验证锁/解锁没有走 darwin 分支（如 osascript、PF）。
  await runLockFlow(t, "win32");
});
