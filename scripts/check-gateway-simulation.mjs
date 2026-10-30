// Local protocol simulation only. No real Claude endpoint, API key or account is used.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createGateway, languageHeader } from "./claude-gateway.mjs";
import { simulationCases } from "./simulation-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const nativeResolve = Module._resolveFilename;
const nativeTs = require.extensions[".ts"];
let buildGatewayCheck, verifiedOptimization, signalOptimization;
try {
  Module._resolveFilename = function (id, parent, ...rest) {
    return nativeResolve.call(this, id.startsWith("@/") ? path.join(root, "src", id.slice(2)) : id, parent, ...rest);
  };
  require.extensions[".ts"] = (module, filename) => {
    const source = require("node:fs").readFileSync(filename, "utf8");
    module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  };
  ({ buildGatewayCheck } = require(path.join(root, "src/detection/gateway-check.ts")));
  ({ verifiedOptimization, signalOptimization } = require(path.join(root, "src/detection/environment-evidence.ts")));
} finally {
  Module._resolveFilename = nativeResolve;
  if (nativeTs) require.extensions[".ts"] = nativeTs;
  else delete require.extensions[".ts"];
}

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const ui = { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui" };
const initialTarget = process.env.CHECKCC_SIMULATION_TARGET ? JSON.parse(process.env.CHECKCC_SIMULATION_TARGET) : { language: "ko-KR", locale: "ko-KR", timezone: "Asia/Seoul" };
if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(initialTarget.language) || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(initialTarget.locale)) throw new Error("INVALID_SIMULATION_TARGET");
const initialLanguageHeader = languageHeader(initialTarget.language);
const key = "local-simulation-key-only";
const originalLanguage = "zh-CN,zh;q=0.9";
const chineseBrowser = { id: "language", value: "zh-CN", score: 1, weight: 5, contribution: 5, assessment: "warning", source: "browser", environment: "browser" };

test("local Claude-like receiver verifies actual gateway forwarding and evidence states", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-simulation-"));
  const profileFile = path.join(directory, "profile.json");
  const rows = [];
  const timezoneBefore = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let seen = null;
  let receivedCount = 0;
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen = { headers: request.headers, body, remoteAddress: request.socket.remoteAddress };
    ++receivedCount;
    const url = new URL(request.url, "http://localhost");
    if (url.searchParams.has("disconnect")) { request.socket.destroy(); return; }
    const send = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers["x-api-key"] !== key) return send(401, { type: "error", error: { type: "authentication_error", message: "Local dummy key rejected" } });
    if (url.searchParams.has("rate_limit")) return send(429, { type: "error", error: { type: "rate_limit_error", message: "Local simulated rate limit" } });
    if (url.searchParams.has("slow")) await new Promise((resolve) => setTimeout(resolve, 150));
    let input;
    try { input = JSON.parse(body); } catch { return send(400, { type: "error", error: { type: "invalid_request_error" } }); }
    if (request.method !== "POST" || url.pathname !== "/v1/messages" || !input.model || !Array.isArray(input.messages) || !Number.isInteger(input.max_tokens) || input.max_tokens < 1 || (input.metadata && Object.keys(input.metadata).some((key) => key !== "user_id"))) return send(400, { type: "error", error: { type: "invalid_request_error" } });
    if (input.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [event, data] of [
        ["message_start", { type: "message_start", message: { id: "msg_local_simulation", type: "message", role: "assistant", content: [], model: input.model, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "local simulation response" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ]) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      response.end();
      return;
    }
    send(200, { id: "msg_local_simulation", type: "message", role: "assistant", model: input.model, content: [{ type: "text", text: "local simulation response" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 3 } });
  });
  let messageProbe = null;
  let gateway;
  let gatewayUrl;
  const scenario = (id, name, run) => t.test(name, async () => {
    const row = { id, scenario: name };
    try { await run(row); row.passed = true; }
    catch (error) { row.passed = false; row.error = error.message; throw error; }
    finally { rows.push(row); process.stdout.write("CHECKCC_SIMULATION_EVENT " + JSON.stringify({ id, passed: row.passed }) + "\n"); }
  });
  const status = async () => {
    const response = await fetch(`${gatewayUrl}/__checkcc/status`, { headers: ui });
    assert.equal(response.status, 200);
    return response.json();
  };
  const configure = async (enabled, language, locale = language, timezone = language === "ja-JP" ? "Asia/Tokyo" : "Asia/Seoul") => {
    const response = await fetch(`${gatewayUrl}/__checkcc/cloak`, { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify({ enabled, ...(language ? { target: { language, locale, timezone } } : {}) }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const sendMessage = async (options = {}) => {
    const body = options.rawBody ?? JSON.stringify({ model: "local-test-model", max_tokens: 16, stream: Boolean(options.stream), messages: [{ role: "user", content: "本地模拟请求；正文保持中文。" }], system: "Local test client remains Windows / Asia/Shanghai", metadata: { user_id: "checkcc-local-simulation" } });
    const response = await fetch(`${gatewayUrl}/v1/messages${options.query ?? ""}`, {
      method: "POST", headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": options.invalidKey ? "invalid-local-dummy-key" : key,
        "accept-language": originalLanguage, "x-checkcc-target-locale": options.locale ?? "zh-CN", "user-agent": "checkcc-local-simulation Windows", "x-stainless-os": "Windows", "x-checkcc-client": "not-for-upstream" }, body, signal: options.signal,
    });
    const text = await response.text();
    return { status: response.status, text, body };
  };
  const evidence = async () => {
    const report = await status();
    const check = buildGatewayCheck(report, "zh");
    const verified = verifiedOptimization(check, report.cloak);
    return { report, check, verified, languageBadge: signalOptimization(chineseBrowser, check.signals.find((signal) => signal.id === "language"), report.cloak.enabled, verified) };
  };
  const record = (row, value, responseStatus) => Object.assign(row, {
    responseStatus, sentLanguage: originalLanguage, receiverLanguage: seen?.headers["accept-language"], receiverLocale: seen?.headers["x-checkcc-target-locale"],
    realRequestVerifiedByProjectRules: value.check.verifiedRequest, optimizationVerifiedByProjectRules: value.verified, languageBadge: value.languageBadge,
  });
  try {
    const upstreamBase = await listen(upstream);
    gateway = createGateway({ upstreamBase, profileFile, collect: async () => ({}) });
    gatewayUrl = await listen(gateway);

    await scenario("passthrough", "No profile: original client declarations pass through", async (row) => {
      const response = await sendMessage();
      assert.equal(response.status, 200);
      assert.equal(seen.headers["accept-language"], originalLanguage);
      assert.equal(seen.headers["x-checkcc-target-locale"], "zh-CN");
      const value = await evidence();
      assert.equal(value.verified, false);
      record(row, value, response.status);
    });

    await scenario("preview", "Configuration preview alone never verifies optimization", async (row) => {
      const before = receivedCount;
      await configure(true, initialTarget.language, initialTarget.locale, initialTarget.timezone);
      const value = await evidence();
      assert.equal(receivedCount, before);
      assert.equal(value.report.previewHeaders["accept-language"], initialLanguageHeader);
      assert.equal(value.check.verifiedRequest, false);
      assert.equal(value.languageBadge, "pending");
      Object.assign(row, { passedRequestCount: 0, languageBadge: value.languageBadge });
    });

    await scenario("headers", "Enabled: receiver observes configured declarations and current request verifies", async (row) => {
      const response = await sendMessage();
      assert.equal(response.status, 200);
      assert.equal(seen.headers["accept-language"], initialLanguageHeader);
      assert.equal(seen.headers["x-checkcc-target-locale"], initialTarget.locale);
      assert.equal(seen.headers["x-api-key"], key);
      assert.equal(seen.headers["x-checkcc-client"], undefined);
      assert.equal(seen.body, response.body);
      const value = await evidence();
      assert.equal(value.languageBadge, value.check.signals.find((signal) => signal.id === "language").contribution === 0 ? "optimized" : "not_improved");
      assert.equal(value.verified, true);
      for (const marker of [key, response.body, "本地模拟请求"]) assert.equal(JSON.stringify(value.report).includes(marker), false);
      record(row, value, response.status);
      Object.assign(row, { requestBodyUnchanged: true, diagnosticSecretsRedacted: true });
      messageProbe = { method: "POST", path: "/v1/messages", status: response.status, sentLanguage: originalLanguage, receivedLanguage: seen.headers["accept-language"], sentLocale: "zh-CN", receivedLocale: seen.headers["x-checkcc-target-locale"], bodyUnchanged: seen.body === response.body };
    });

    await scenario("stream", "Streaming response passes through; SDK platform and body remain unchanged", async (row) => {
      const response = await sendMessage({ stream: true });
      assert.equal(response.status, 200);
      assert.ok(response.text.includes("event: message_start\n"));
      assert.ok(response.text.includes("event: message_stop\n"));
      assert.ok(response.text.includes("local simulation response"));
      assert.equal(seen.body, response.body);
      assert.equal(seen.headers["x-stainless-os"], "Windows");
      assert.equal(seen.headers["user-agent"], "checkcc-local-simulation Windows");
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, timezoneBefore);
      record(row, await evidence(), response.status);
      Object.assign(row, { streamPassedThrough: true, platformHeaderUnchanged: true, chineseBodyUnchanged: true, systemTimezoneUnchanged: true, receiverPeerAddress: seen.remoteAddress });
    });

    await scenario("field", "Unchanged locale cannot borrow the language rewrite's verified label", async (row) => {
      const response = await sendMessage({ locale: initialTarget.locale });
      const value = await evidence();
      const locale = value.check.signals.find((signal) => signal.id === "locale");
      assert.equal(value.languageBadge, value.check.signals.find((signal) => signal.id === "language").contribution === 0 ? "optimized" : "not_improved");
      assert.equal(locale.cloaked, false);
      const localeBadge = signalOptimization({ ...chineseBrowser, id: "locale" }, locale, true, value.verified);
      assert.equal(localeBadge, locale.contribution > 0 ? "not_improved" : "unattributed");
      record(row, value, response.status);
      row.localeBadge = localeBadge;
    });

    await scenario("auth", "401 authentication rejection is propagated and never verifies optimization", async (row) => {
      const response = await sendMessage({ invalidKey: true });
      assert.equal(response.status, 401);
      const value = await evidence();
      assert.equal(value.check.verifiedRequest, false);
      assert.notEqual(value.languageBadge, "optimized");
      record(row, value, response.status);
    });

    await scenario("rate", "429 rate limit is propagated and never verifies optimization", async (row) => {
      const response = await sendMessage({ query: "?rate_limit=1" });
      assert.equal(response.status, 429);
      const value = await evidence();
      assert.equal(value.verified, false);
      record(row, value, response.status);
    });

    await scenario("target", "Changed target: old traffic invalidated, fresh Japanese request verified", async (row) => {
      await sendMessage();
      const previous = await evidence();
      await configure(true, "ja-JP");
      const beforeNewRequest = await evidence();
      assert.equal(beforeNewRequest.check.verifiedRequest, false);
      assert.equal(verifiedOptimization(previous.check, beforeNewRequest.report.cloak), false);
      const response = await sendMessage();
      assert.equal(seen.headers["accept-language"], "ja-JP,ja;q=0.9,en;q=0.5");
      assert.equal(seen.headers["x-checkcc-target-locale"], "ja-JP");
      const value = await evidence();
      assert.equal(value.verified, true);
      record(row, value, response.status);
      row.oldTrafficInvalidated = true;
    });

    await scenario("disabled", "Disabled: Chinese language and locale are restored without claiming optimization", async (row) => {
      await configure(false);
      const response = await sendMessage();
      assert.equal(seen.headers["accept-language"], originalLanguage);
      assert.equal(seen.headers["x-checkcc-target-locale"], "zh-CN");
      const value = await evidence();
      assert.equal(value.verified, false);
      assert.notEqual(value.languageBadge, "optimized");
      record(row, value, response.status);
    });

    await scenario("disconnect", "Connection failure returns 502 and invalidates earlier success evidence", async (row) => {
      await configure(true, initialTarget.language, initialTarget.locale, initialTarget.timezone);
      await sendMessage();
      assert.equal((await evidence()).verified, true);
      const response = await sendMessage({ query: "?disconnect=1" });
      assert.equal(response.status, 502);
      const value = await evidence();
      assert.ok(value.report.lastFailure);
      assert.equal(value.verified, false);
      record(row, value, response.status);
    });
    await scenario("contract", "Message contract rejects invalid metadata and malformed JSON", async (row) => {
      const malformed = await sendMessage({ rawBody: "{" });
      assert.equal(malformed.status, 400);
      const invalid = await sendMessage({ rawBody: JSON.stringify({ model: "local-test-model", max_tokens: 16, messages: [{role:"user",content:"local test"}], metadata: { unsupported: "not-a-supported-metadata-field" } }) });
      assert.equal(invalid.status, 400);
      const value = await evidence();
      assert.equal(value.verified, false);
      record(row, value, invalid.status);
    });
    await scenario("retry", "A new successful retry replaces a rate-limited attempt", async (row) => {
      assert.equal((await sendMessage({query:"?rate_limit=1"})).status, 429);
      assert.equal((await evidence()).verified, false);
      const response = await sendMessage();
      const value = await evidence();
      assert.equal(response.status, 200);
      assert.equal(value.verified, true);
      record(row, value, response.status);
    });
    await scenario("cancel", "Client cancellation does not manufacture a successful response", async (row) => {
      const before = (await status()).lastRequest.startedAt;
      await assert.rejects(sendMessage({query:"?slow=1",signal:AbortSignal.timeout(25)}));
      await new Promise((resolve) => setTimeout(resolve, 175));
      assert.equal((await status()).lastRequest.startedAt, before);
      Object.assign(row,{clientCancelled:true,newSuccessRecord:false});
    });
  } finally {
    if (gateway) await close(gateway);
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
    const output = process.env.CHECKCC_SIMULATION_OUTPUT || path.join(root, "node_modules", ".check-cc-simulation");
    await mkdir(output, { recursive: true });
    const report = { kind: "local-simulation-only", realClaudeContacted: false, liveGatewayModified: false, target: initialTarget, messageProbe, allPassed: rows.length === simulationCases.length && rows.every((row) => row.passed), scenarios: rows,
      limitations: ["Only local HTTP forwarding and project evidence rules were verified.", "No official TLS, browser fingerprint, account, billing or anti-abuse decision was simulated.", "Only Accept-Language and a project-specific locale header are rewritten; body, SDK platform headers and system timezone are unchanged."] };
    await writeFile(path.join(output, "latest.json"), JSON.stringify(report, null, 2));
    const lines = ["# 本地 Claude API 接收端模拟测试", "", `结果：${rows.filter((row) => row.passed).length}/${rows.length} 个场景通过。`, "", "仅使用回环地址、临时配置和虚构测试密钥。未连接真实 Claude，未修改运行中的网关。", "", "| 场景 | 结果 | 接收端语言 | HTTP | 页面语言标识 |", "| --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row.scenario} | ${row.passed ? "通过" : "失败"} | ${row.receiverLanguage ?? "无新请求"} | ${row.responseStatus ?? "—"} | ${row.languageBadge ?? "pending"} |`), "", "边界：只验证请求转发与本项目的标识规则。无法证明官方风控通过、账号可用或充值安全。正文、SDK 系统信息、系统时区不会因语言头改写而隐藏。", ""];
    await writeFile(path.join(output, "latest.md"), lines.join("\n"));
  }
});
