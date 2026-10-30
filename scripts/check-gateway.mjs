import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./claude-gateway.mjs";
import { publicIp, probe } from "./gateway-diagnostics.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
const ui = { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui" };

test("real forwarding, profile reload, CORS, diagnostics isolation and secret redaction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-gateway-test-"));
  const profileFile = path.join(directory, "profile.json");
  let seen = null;
  let calls = 0;
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen = { headers: request.headers, body, url: request.url };
    response.writeHead(request.url.includes("denied") ? 401 : 200, { "Content-Type": "text/event-stream", "Connection": "keep-alive" });
    response.write("data: first\n\n");
    response.end("data: done\n\n");
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ upstreamBase: upstreamUrl, profileFile, collect: async () => { calls += 1; return { checkedAt: new Date().toISOString() }; } });
  const gatewayUrl = await listen(gateway);
  const get = (endpoint, headers = ui) => fetch(gatewayUrl + endpoint, { headers });
  const saveProfile = (language, updatedAt) => writeFile(profileFile, JSON.stringify({ target: {language, locale:language, timezone:"Asia/Seoul", authorization:"profile-secret"}, updatedAt }));
  try {
    assert.equal((await get("/__checkcc/status", {})).status, 403);
    assert.equal((await get("/__checkcc/status", {...ui, Origin:"https://evil.example"})).status, 403);
    const browserProbe = await get("/__checkcc/browser-probe", { ...ui, "Accept-Language": "ko-KR,ko;q=0.9", Authorization: "private-key", Cookie: "private-cookie" });
    assert.equal(browserProbe.status, 200);
    const browserSample = await browserProbe.json();
    assert.equal(browserSample.kind, "browser-headers-probe");
    assert.equal(browserSample.receivedLanguage, "ko-KR,ko;q=0.9");
    assert.doesNotMatch(JSON.stringify(browserSample), /private-key|private-cookie/);
    assert.equal((await get("/__checkcc/status").then(response=>response.json())).lastRequest, null);
    assert.equal((await fetch(gatewayUrl + "/__checkcc/browser-probe", { method: "POST", headers: ui })).status, 405);
    const reboundStatus = await new Promise((resolve, reject) => {
      http.get(gatewayUrl + "/__checkcc/status", {headers: {...ui, Host:"evil.example"}}, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(reboundStatus, 403);
    const cors = await fetch(gatewayUrl + "/__checkcc/diagnostics", {method:"OPTIONS",headers:{Origin:ui.Origin,"Access-Control-Request-Method":"GET"}});
    assert.equal(cors.status, 204);
    assert.equal(cors.headers.get("Access-Control-Allow-Origin"), ui.Origin);
    assert.equal(cors.headers.get("Access-Control-Allow-Private-Network"), "true");
    assert.equal((await fetch(gatewayUrl + "/__checkcc/status", {method:"POST",headers:ui})).status, 405);
    await saveProfile("ko-KR", "one");
    const before = await (await get("/__checkcc/status")).json();
    assert.equal(before.lastRequest, null, "A profile must not manufacture traffic evidence");
    assert.equal(before.previewHeaders["accept-language"], "ko-KR,ko;q=0.9,en;q=0.5");
    const result = await fetch(gatewayUrl + "/v1/messages?private=secret", {
      method:"POST",headers:{"content-type":"application/json", "x-api-key":"secret-key",authorization:"Bearer secret-auth", "accept-language":"zh-CN", "x-checkcc-client":"do-not-forward"},body:'{"messages":["private-prompt"]}',
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "data: first\n\ndata: done\n\n");
    assert.equal(seen.headers["x-api-key"], "secret-key");
    assert.equal(seen.headers.authorization, "Bearer secret-auth");
    assert.equal(seen.headers["accept-language"], before.previewHeaders["accept-language"]);
    assert.equal(seen.headers["x-checkcc-client"], undefined);
    assert.equal(seen.body, '{"messages":["private-prompt"]}');
    const after = await (await get("/__checkcc/diagnostics")).json();
    assert.equal(after.lastRequest.status, 200);
    assert.equal(after.lastRequest.profileUpdatedAt, "one");
    const serialized = JSON.stringify(after);
    for (const secret of ["secret-key", "secret-auth", "private-prompt", "private=secret", "profile-secret"]) assert.ok(!serialized.includes(secret), "Must not disclose " + secret);
    await Promise.all([get("/__checkcc/diagnostics"),get("/__checkcc/diagnostics")]);
    assert.equal(calls, 1, "Network probes should be cached");
    await saveProfile("en-GB", "two");
    const reloaded = await (await get("/__checkcc/status")).json();
    assert.equal(reloaded.previewHeaders["accept-language"], "en-GB,en;q=0.9");
    assert.equal(reloaded.lastRequest.profileUpdatedAt, "one", "Old traffic cannot verify a changed profile");
    const unrelated = await fetch(gatewayUrl + "/");
    await unrelated.text();
    assert.equal((await (await get("/__checkcc/status")).json()).lastRequest.profileUpdatedAt, "one", "A non-Claude request must not verify client integration");
    const denied = await fetch(gatewayUrl + "/v1/messages?denied=true", {method:"POST"});
    assert.equal(denied.status, 401);
    await denied.text();
    assert.equal((await (await get("/__checkcc/status")).json()).lastRequest.status, 401);
    await writeFile(profileFile, "invalid");
    assert.equal((await (await get("/__checkcc/status")).json()).profileError, "INVALID_PROFILE");
    assert.equal((await fetch(gatewayUrl + "/v1/messages")).status, 503);
  } finally { await close(gateway); await close(upstream); await rm(directory, {recursive:true,force:true}); }
});

test("probes distinguish HTTP authorization failures, malformed responses and timeouts", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/timeout") return;
    response.writeHead(request.url === "/auth" ? 401 : 200);
    response.end("invalid json");
  });
  const url = await listen(server);
  try {
    assert.equal((await probe(url + "/auth")).status, 401);
    assert.equal((await probe(url, {method:"GET",json:true})).error, "INVALID_JSON");
    assert.equal((await probe(url + "/timeout", {timeout:40})).status, null);
    for (const invalid of ["999.1.2.3", "127.0.0.1", "192.168.1.2", "100.64.1.2", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(publicIp(invalid), null);
    assert.equal(publicIp("8.8.8.8"), "8.8.8.8");
    assert.equal(publicIp("2606:4700:4700::1111"), "2606:4700:4700::1111");
  } finally { await close(server); }
});

test("optimization configures the gateway without the timezone helper and switches real forwarding", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-toggle-test-"));
  const profileFile = path.join(directory, "nested", "profile.json");
  let seen;
  const upstream = http.createServer((request, response) => {
    seen = request.headers;
    request.resume();
    response.end("ok");
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ upstreamBase: upstreamUrl, profileFile });
  const url = await listen(gateway);
  const toggle = (value) => fetch(url + "/__checkcc/cloak", { method: "POST", headers: { ...ui, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const status = async () => (await fetch(url + "/__checkcc/status", { headers: ui })).json();
  const forward = async () => { const result = await fetch(url + "/v1/messages", { method: "POST", headers: { "accept-language": "zh-CN", "x-checkcc-target-locale": "zh-CN" } }); await result.text(); assert.equal(result.status, 200); };
  try {
    assert.equal((await status()).cloak.enabled, false, "No profile is not an active optimization");
    assert.equal((await toggle({ enabled: true })).status, 409);
    assert.equal((await toggle({ enabled: "yes" })).status, 400);
    assert.equal((await toggle({ enabled: true, target: { language: "bad\nvalue", locale: "ko-KR" } })).status, 400);
    const off = await toggle({ enabled: false });
    assert.equal((await off.json()).cloak.enabled, false, "Disabling must not require a profile or helper");
    const on = await toggle({ enabled: true, target: { language: "ko-KR", locale: "ko-KR", timezone: "Asia/Seoul", authorization: "do-not-store" } });
    assert.equal(on.status, 200);
    const saved = await on.json();
    assert.equal(saved.cloak.enabled, true);
    assert.equal(saved.cloak.target.language, "ko-KR");
    assert.equal(saved.cloak.target.authorization, undefined);
    await forward();
    assert.equal(seen["accept-language"], "ko-KR,ko;q=0.9,en;q=0.5");
    assert.equal(seen["x-checkcc-target-locale"], "ko-KR");
    assert.equal((await toggle({ enabled: true, target: { language: "invalid", locale: "ko-KR" } })).status, 400);
    assert.equal((await status()).cloak.enabled, true, "A rejected request must preserve the confirmed state");
    assert.equal((await toggle({ enabled: false })).status, 200);
    assert.equal((await status()).cloak.enabled, false, "Reload reads the actual disabled state");
    await forward();
    assert.equal(seen["accept-language"], "zh-CN");
    assert.equal(seen["x-checkcc-target-locale"], "zh-CN");
    assert.equal((await toggle({ enabled: true })).status, 200, "Saved target may be reused");
    await writeFile(profileFile, "broken");
    assert.equal((await toggle({ enabled: false })).status, 200, "A damaged profile must not block disabling");
  } finally {
    await toggle({ enabled: true, target: { language: "en-US", locale: "en-US" } });
    await close(gateway); await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});
