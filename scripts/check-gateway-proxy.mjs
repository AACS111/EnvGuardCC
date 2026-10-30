import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { proxyRequest, resolveProxy, selectedProxy } from "./gateway-proxy.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server, sockets = []) => new Promise((resolve) => {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  server.close(resolve);
});
const request = (url, options, proxy) => new Promise((resolve, reject) => {
  const req = proxyRequest(new URL(url), options, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body }));
  }, proxy);
  req.on("error", reject);
  req.end(options.body);
});

test("Windows system proxy, explicit override and direct mode resolve without exposing credentials", () => {
  const system = resolveProxy({}, "http://127.0.0.1:7890");
  assert.equal(system.source, "system");
  assert.equal(system.url.origin, "http://127.0.0.1:7890");
  const explicit = resolveProxy({ CHECKCC_PROXY: "http://user:secret@127.0.0.1:7891" }, "http://127.0.0.1:7890");
  assert.equal(explicit.url.origin, "http://127.0.0.1:7891");
  assert.equal(resolveProxy({ CHECKCC_PROXY: "direct" }, "http://127.0.0.1:7890"), null);
  assert.throws(() => resolveProxy({ CHECKCC_PROXY: "socks5://127.0.0.1:7890" }, null), /HTTP/);
});

test('运行中切换代理地址或直连时使用最新设置', t => {
  const previous = process.env.CHECKCC_PROXY;
  t.after(() => { if (previous === undefined) delete process.env.CHECKCC_PROXY; else process.env.CHECKCC_PROXY = previous; });
  process.env.CHECKCC_PROXY = 'http://127.0.0.1:18080';
  assert.equal(selectedProxy().url.port, '18080');
  process.env.CHECKCC_PROXY = 'http://127.0.0.1:18081';
  assert.equal(selectedProxy().url.port, '18081');
  process.env.CHECKCC_PROXY = 'direct'; assert.equal(selectedProxy(), null);
});

test("message body and private headers travel inside CONNECT; destination DNS is delegated to proxy", async () => {
  const sockets = [];
  let upstreamHeaders;
  const upstream = http.createServer(async (req, res) => {
    upstreamHeaders = req.headers;
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(body);
  });
  const targetPort = await listen(upstream);
  let connectHeaders;
  let destination;
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    connectHeaders = req.headers;
    destination = req.url;
    const target = net.connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    sockets.push(socket, target);
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  const proxyPort = await listen(proxy);
  try {
    const body = JSON.stringify({ messages: [{ role: "user", content: "local simulation" }] });
    const result = await request("http://claude-target.invalid/v1/messages", { method: "POST", headers: { "x-api-key": "private-local-key", "Content-Type": "application/json" }, body }, resolveProxy({ CHECKCC_PROXY: `http://user:secret@127.0.0.1:${proxyPort}` }, null));
    assert.equal(result.status, 200);
    assert.equal(result.body, body);
    assert.equal(destination, "claude-target.invalid:80");
    assert.equal(connectHeaders["x-api-key"], undefined);
    assert.ok(connectHeaders["proxy-authorization"]);
    assert.equal(upstreamHeaders["proxy-authorization"], undefined);
    assert.equal(upstreamHeaders["x-api-key"], "private-local-key");
  } finally { await close(proxy, sockets); await close(upstream); }
});

test("proxy failure is reported, without silently falling back to direct", async () => {
  const proxy = http.createServer();
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  const port = await listen(proxy);
  try {
    await assert.rejects(request("https://claude-target.invalid/v1/messages", {}, resolveProxy({ CHECKCC_PROXY: `http://127.0.0.1:${port}` }, null)), { code: "PROXY_CONNECT_FAILED" });
  } finally { await close(proxy); }
});

test("cancelling while CONNECT is pending closes the proxy socket", async () => {
  const sockets = [];
  const proxy = http.createServer();
  proxy.on("connect", (_req, socket) => { sockets.push(socket); });
  const port = await listen(proxy);
  try {
    const controller = new AbortController();
    const pending = request("https://claude-target.invalid/", { signal: controller.signal }, resolveProxy({ CHECKCC_PROXY: `http://127.0.0.1:${port}` }, null));
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, /abort/i);
  } finally { await close(proxy, sockets); }
});

test("destroying the outer request cancels an independent pending CONNECT", { timeout: 3000 }, async () => {
  const sockets = [];
  const proxy = http.createServer();
  let connected;
  const ready = new Promise((resolve) => { connected = resolve; });
  proxy.on("connect", (_req, socket) => { sockets.push(socket); connected(socket); });
  const port = await listen(proxy);
  try {
    const req = proxyRequest(new URL("https://claude-target.invalid/"), {}, () => {}, resolveProxy({ CHECKCC_PROXY: `http://127.0.0.1:${port}` }, null));
    req.on("error", () => {});
    req.end();
    const socket = await ready;
    socket.resume();
    const closed = new Promise((resolve) => socket.once("end", resolve));
    req.destroy();
    await closed;
  } finally { await close(proxy, sockets); }
});

test("HTTPS uses TLS inside CONNECT rather than sending message credentials in plaintext", async () => {
  let record;
  const proxy = http.createServer();
  const sockets = [];
  proxy.on("connect", (_req, socket) => {
    sockets.push(socket);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", (chunk) => {
      record = chunk;
      socket.end("HTTP/1.1 400 TLS required\r\n\r\n");
    });
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(request("https://claude-target.invalid/v1/messages", { headers: { "x-api-key": "private-local-key" } }, resolveProxy({ CHECKCC_PROXY: `http://127.0.0.1:${port}` }, null)));
    assert.equal(record[0], 0x16);
    assert.equal(record.includes(Buffer.from("private-local-key")), false);
  } finally { await close(proxy, sockets); }
});
