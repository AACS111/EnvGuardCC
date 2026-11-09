// 第三方订阅的兼容性：同一链接按 UA 返回不同格式、200 错误页、anytls 协议。
import test from "node:test";
import assert from "node:assert/strict";
import { parseSubscription, parseShareLinks, shareLinkToProxy, defaultFetch, looksLikeSubscription } from "./net-core/subscription.mjs";
import { buildKernelConfig, assertKernelConfig, TLS_PROXY_TYPES } from "./net-core/config.mjs";

const ANYTLS = "anytls://3da76b98-ee66-4dbb-8bca-2a7919fb741f@sg-aws-stable.private.example:28997?sni=cache.example.com&insecure=1#Hong%20Kong%2001";

test("anytls 分享链接与 base64 列表可解析", () => {
  const proxy = shareLinkToProxy(ANYTLS, 0);
  assert.equal(proxy.type, "anytls");
  assert.equal(proxy.server, "sg-aws-stable.private.example");
  assert.equal(proxy.port, 28997);
  assert.equal(proxy.password, "3da76b98-ee66-4dbb-8bca-2a7919fb741f");
  assert.equal(proxy.servername, "cache.example.com");
  assert.equal(proxy["skip-cert-verify"], true);
  assert.equal(proxy.name, "Hong Kong 01");
  const list = parseShareLinks(Buffer.from(`${ANYTLS}\n${ANYTLS.replace("28997", "28998")}`).toString("base64"));
  assert.equal(list.proxies.length, 2);
  assert.equal(list.source, "links");
});

test("anytls 节点必须补 TLS 指纹并进入内核配置", () => {
  assert.ok(TLS_PROXY_TYPES.has("anytls"));
  const node = shareLinkToProxy(ANYTLS, 0);
  const config = buildKernelConfig({ proxies: [node], selected: node.name, apiPort: 39090, mixedPort: 39080, egressMode: "rule" });
  assert.equal(config.proxies[0]["client-fingerprint"], "chrome");
  assert.doesNotThrow(() => assertKernelConfig(config, { egressMode: "rule" }));
});

test("订阅内容校验：Clash YAML / base64 分享链接通过，HTML 错误页不通过", () => {
  assert.equal(looksLikeSubscription("proxies:\n  - name: a\n    type: ss\n"), true);
  assert.equal(looksLikeSubscription(Buffer.from(ANYTLS).toString("base64")), true);
  assert.equal(looksLikeSubscription("<html><body>Access denied</body></html>"), false);
  assert.equal(looksLikeSubscription(""), false);
});

test("按 UA 返回错误页时继续尝试下一个 UA，不把 200 错误页当订阅", async () => {
  const yaml = "proxies:\n  - name: a\n    type: ss\n    server: 203.0.113.1\n    port: 443\n    cipher: aes-128-gcm\n    password: x\n";
  const calls = [];
  const fetchImpl = async (_url, { headers }) => {
    calls.push(headers["User-Agent"]);
    if (headers["User-Agent"] === "bad/1") return new Response("Access denied", { status: 200 });
    return new Response(yaml, { status: 200 });
  };
  const text = await defaultFetch("https://sub.example/sub", { fetchImpl, userAgents: ["bad/1", "good/1"], scan: async () => [] });
  assert.equal(text, yaml);
  assert.deepEqual(calls, ["bad/1", "good/1"]);
});

test("单个 UA 连接被重置时继续尝试下一个 UA", async () => {
  const yaml = "proxies:\n  - name: a\n    type: ss\n    server: 203.0.113.1\n    port: 443\n    cipher: aes-128-gcm\n    password: x\n";
  const fetchImpl = async (_url, { headers }) => {
    if (headers["User-Agent"] === "reset/1") throw Object.assign(new Error("socket reset"), { cause: { code: "ECONNRESET" } });
    return new Response(yaml, { status: 200 });
  };
  const text = await defaultFetch("https://sub.example/sub", { fetchImpl, userAgents: ["reset/1", "good/1"], scan: async () => [] });
  assert.equal(text, yaml);
});

test("解析 Clash 配置里的 anytls 节点", () => {
  const yaml = `proxies:
  - name: 🇸🇬Singapore 01
    type: anytls
    server: sg.example.com
    port: 28997
    password: 3da76b98-ee66-4dbb-8bca-2a7919fb741f
    sni: cache.example.com
    skip-cert-verify: true
`;
  const parsed = parseSubscription(yaml);
  assert.equal(parsed.proxies.length, 1);
  assert.equal(parsed.proxies[0].type, "anytls");
});
