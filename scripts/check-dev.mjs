import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startGateway } from "./dev.mjs";

const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});

test("开发启动器启动网关，页面来源可读取状态，退出后释放端口", async () => {
  const { server, url } = await startGateway(0);
  try {
    const response = await fetch(`${url}/__checkcc/status`, {
      headers: { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const report = await response.json();
    assert.equal(report.version, 1);
    assert.ok(["node-native-direct", "node-native-proxy"].includes(report.transport));
  } finally { await close(server); }
  await assert.rejects(fetch(`${url}/__checkcc/status`));
});

test("重复启动复用已有网关，不取得已有网关的关闭权", async () => {
  const first = await startGateway(0);
  try {
    const second = await startGateway(first.server.address().port);
    assert.equal(second.server, null);
    assert.equal(second.url, first.url);
    assert.equal(first.server.listening, true);
  } finally { await close(first.server); }
});

test("端口被其他服务占用时拒绝启动，保留原服务", async () => {
  const other = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"service":"other"}');
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(startGateway(other.address().port), /不是可用的 EnvGuardCC 网关/);
    assert.equal(other.listening, true);
  } finally { await close(other); }
});
