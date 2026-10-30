import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "./claude-gateway.mjs";

test("simulation API runs once, streams progress and invalidates obsolete results", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "checkcc-runner-"));
  const profileFile = path.join(directory, "profile.json");
  const gateway = createGateway({ profileFile, upstreamBase: "http://127.0.0.1:9", collect: async () => ({}) });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const headers = { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui", "Content-Type": "application/json" };
  const get = async (endpoint) => (await fetch(url + endpoint, { headers })).json();
  try {
    assert.equal((await fetch(url + "/v1/messages", { method: "POST", headers: { "x-checkcc-simulation": "untrusted-token" }, body: "{}" })).status, 403);
    assert.equal((await fetch(url + "/__checkcc/simulation")).status, 403);
    assert.equal((await fetch(url + "/__checkcc/simulation", { method: "POST", headers })).status, 409);
    await fetch(url + "/__checkcc/cloak", { method: "POST", headers, body: JSON.stringify({ enabled: true, target: { language: "ja-JP", locale: "ja-JP", timezone: "Asia/Tokyo" } }) });
    const [first, duplicate] = await Promise.all([1, 2].map(async () => {
      const response = await fetch(url + "/__checkcc/simulation", { method: "POST", headers });
      assert.equal(response.status, 202);
      return response.json();
    }));
    assert.equal(first.runId, duplicate.runId, "Concurrent starts must share one worker");
    assert.equal(first.running, true);
    let job = first;
    let sawProgress = false;
    const deadline = Date.now() + 15000;
    while (job.running && Date.now() < deadline) {
      await delay(75);
      job = await get("/__checkcc/simulation");
      if (job.running && job.completed > 0) sawProgress = true;
    }
    assert.equal(job.state, "passed", JSON.stringify({ state: job.state, error: job.error, cases: job.scenarios }));
    assert.equal(job.total, 13);
    assert.equal(job.passed, 13);
    assert.equal(job.target.language, "ja-JP");
    assert.equal(job.signalResults.language.state, "passed");
    assert.equal(job.messageProbe.viaLiveGateway, true);
    assert.equal((await get("/__checkcc/status")).lastRequest, null);
    assert.equal(job.messageProbe.path, "/v1/messages");
    assert.equal(job.messageProbe.status, 200);
    assert.equal(job.messageProbe.sentLanguage, "zh-CN,zh;q=0.9");
    assert.equal(job.messageProbe.receivedLanguage, "ja-JP,ja;q=0.9,en;q=0.5");
    assert.equal(job.messageProbe.receivedLocale, "ja-JP");
    assert.equal(job.messageProbe.bodyUnchanged, true);
    assert.equal(job.messageProbe.headersIntegrity, true);
    assert.equal(job.messageProbe.receivedHeaders["x-api-key"], undefined);
    const singleResponse = await fetch(url + "/__checkcc/message-probe?signal=requestHeaders", { method: "POST", headers });
    assert.equal(singleResponse.status, 200);
    const single = await singleResponse.json();
    assert.equal(single.state, "passed");
    assert.equal(single.signalResults.requestHeaders.state, "passed");
    assert.equal(single.messageProbe.viaLiveGateway, true);
    const related = await (await fetch(url + "/__checkcc/message-probe?signal=language&related=1", { method: "POST", headers })).json();
    for (const id of ["language", "languageVariant", "locale", "httpLanguage", "requestHeaders", "secFetch", "clientHints", "deviceLineage", "claudeTrigger", "claudeLatency"]) assert.equal(related.signalResults[id]?.state, "passed", id);
    assert.equal(related.signalResults.chineseFonts, undefined, "Message verification cannot measure browser fonts");
    assert.equal((await get("/__checkcc/simulation")).runId, job.runId);
    assert.equal((await get("/__checkcc/status")).lastRequest, null);
    assert.equal((await fetch(url + "/__checkcc/message-probe?signal=country", { method: "POST", headers })).status, 400);
    assert.equal((await fetch(url + "/__checkcc/message-probe?signal=requestHeaders", { headers })).status, 405);
    assert.equal(job.signalResults.requestHeaders.state, "passed", "Request header card must receive its mapped test results");
    assert.equal(job.signalResults.chineseFonts, undefined, "Browser fingerprint must not borrow protocol success");
    assert.equal(sawProgress, true);
    assert.equal((await get("/__checkcc/status")).lastRequest, null, "Simulated traffic must not become real request evidence");
    await writeFile(profileFile, JSON.stringify({ target: { language: "en-GB", locale: "en-GB" }, updatedAt: "new-config-version" }));
    const stale = await get("/__checkcc/simulation");
    assert.equal(stale.state, "stale");
    assert.equal(stale.signalResults.language.state, "stale");
    await fetch(url + "/__checkcc/cloak", { method: "POST", headers, body: JSON.stringify({ enabled: false }) });
    assert.equal((await fetch(url + "/__checkcc/simulation", { method: "POST", headers })).status, 409);
  } finally {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("single native diagnostics passes the selected point to its collector without running a full scan", async () => {
  const selected = [];
  const gateway = createGateway({ upstreamBase: "http://127.0.0.1:9", collect: async (_upstream, options) => { selected.push(options?.signalId); return {}; } });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const headers = { Origin: "http://localhost:3000", "X-CheckCC-Client": "gateway-ui" };
  try {
    assert.equal((await fetch(url + "/__checkcc/diagnostics?signal=country", { headers })).status, 200);
    assert.equal((await fetch(url + "/__checkcc/diagnostics?signal=gatewayProfile", { headers })).status, 200);
    assert.equal((await fetch(url + "/__checkcc/diagnostics?signal=../invalid", { headers })).status, 400);
    assert.deepEqual(selected, ["country", "gatewayProfile"]);
  } finally {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
});
