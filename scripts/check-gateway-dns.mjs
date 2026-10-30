import test from "node:test";
import assert from "node:assert/strict";
import { collectDnsDiagnostics } from "./gateway-diagnostics.mjs";

const upstream = new URL("https://api.anthropic.com/");
const reference = (answers) => ({ status: 200, data: { Status: 0, Answer: answers.map((data) => ({ type: 1, data })) } });

test("proxy DNS diagnostics skip target OS lookup and check CONNECT plus two DoH sources", async () => {
  const visited = [];
  const result = await collectDnsDiagnostics(upstream, {
    inspect: () => ({ mode: "http-connect" }),
    lookupTarget: () => { throw new Error("Target OS lookup must not execute"); },
    requestProbe: async (url, options) => {
      visited.push(url.hostname);
      if (url.hostname === upstream.hostname) return { status: 401 };
      assert.equal(url.searchParams.get("name"), upstream.hostname);
      assert.equal(options.headers.accept, "application/dns-json");
      return reference(["1.1.1.1"]);
    },
  });
  assert.equal(result.localLookupSkipped, true);
  assert.equal(result.error, null);
  assert.equal(result.referenceAgreement, true);
  assert.deepEqual(visited, [upstream.hostname, "cloudflare-dns.com", "dns.google"]);
});

test("failed proxy CONNECT is terminal and never falls back to target OS DNS", async () => {
  const result = await collectDnsDiagnostics(upstream, {
    inspect: () => ({ mode: "http-connect" }),
    lookupTarget: () => { throw new Error("No direct fallback"); },
    requestProbe: async () => ({ status: null, error: "ECONNREFUSED" }),
  });
  assert.equal(result.error, "ECONNREFUSED");
  assert.equal(result.referenceAgreement, null);
});

test("CDN answer differences are reference differences, not proven DNS leakage", async () => {
  const result = await collectDnsDiagnostics(upstream, {
    inspect: () => ({ mode: "http-connect" }),
    requestProbe: async (url) => url.hostname === upstream.hostname ? { status: 200 } : reference([url.hostname === "dns.google" ? "8.8.8.8" : "1.1.1.1"]),
  });
  assert.equal(result.referenceAgreement, false);
  assert.equal(result.error, null);
});

test("fake-IP answers and unavailable DoH data cannot verify DNS consistency", async () => {
  const result = await collectDnsDiagnostics(upstream, {
    inspect: () => ({ mode: "http-connect" }),
    requestProbe: async (url) => url.hostname === upstream.hostname ? { status: 200 } : reference(["198.18.1.2"]),
  });
  assert.equal(result.referenceAgreement, null);
});

test("direct route reports actual system DNS without claiming proxy protection", async () => {
  let lookups = 0;
  const result = await collectDnsDiagnostics(upstream, {
    inspect: () => ({ mode: "direct" }),
    lookupTarget: async (hostname) => { lookups++; return { hostname, addresses: [{ address: "1.1.1.1", family: 4 }], resolvers: ["192.168.1.1"], error: null }; },
    requestProbe: async () => reference(["1.1.1.1"]),
  });
  assert.equal(lookups, 1);
  assert.equal(result.mode, "system");
  assert.equal(result.localLookupSkipped, false);
  assert.equal(result.routeStatus, null);
});
