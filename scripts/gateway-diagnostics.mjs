// Diagnostic probes share the gateway's native HTTP transport. No API credentials or request bodies are sampled.
import { proxyRequest, proxyInfo } from "./gateway-proxy.mjs";
import dns from "node:dns";
import { isIP } from "node:net";

export function transportRequest(url, options, onResponse) {
  return proxyRequest(url, options, onResponse);
}

export function publicIp(value) {
  if (typeof value !== "string" || !isIP(value)) return null;
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  } else if (/^(::|::1|::ffff:|f[cd]|fe[89ab]|ff)/i.test(value)) return null;
  return value;
}

export function probe(rawUrl, { method = "HEAD", family, json = false, text = false, timeout = 4500, headers = {} } = {}) {
  const url = new URL(rawUrl);
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ url: url.origin + url.pathname, elapsedMs: Date.now() - start, ...result });
    };
    const request = transportRequest(url, {
      method, family, signal: AbortSignal.timeout(timeout),
      headers: { "user-agent": "EnvGuardCC-Gateway-Diagnostics/1.0", "anthropic-version": "2023-06-01", ...headers },
    }, (response) => {
      const socket = response.socket;
      const result = {
        status: response.statusCode,
        remoteAddress: socket.remoteAddress ?? null,
        tls: url.protocol === "https:" ? { authorized: socket.authorized === true, protocol: socket.getProtocol?.() ?? null } : null,
      };
      if (!json && !text) { response.resume(); finish(result); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) {
          finish({ ...result, error: "RESPONSE_TOO_LARGE" });
          response.destroy();
        }
      });
      response.on("end", () => {
        if (text) { finish({ ...result, data: body }); return; }
        try { finish({ ...result, data: JSON.parse(body) }); }
        catch { finish({ ...result, error: "INVALID_JSON" }); }
      });
      response.on("error", () => finish({ ...result, error: "RESPONSE_INTERRUPTED" }));
    });
    request.on("error", (error) => finish({ status: null, error: error.code ?? "NETWORK_ERROR" }));
    request.end();
  });
}

async function lookup(hostname) {
  let timer;
  try {
    const addresses = await Promise.race([
      dns.promises.lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), 4500); }),
    ]);
    return { hostname, addresses, resolvers: dns.getServers(), error: null };
  } catch (error) {
    return { hostname, addresses: [], resolvers: dns.getServers(), error: error.code ?? "DNS_TIMEOUT" };
  } finally { clearTimeout(timer); }
}

function geoSource(result, provider) {
  const data = result.data;
  if (result.status !== 200 || !data || data.success === false || data.error) return null;
  const ip = publicIp(data.ip);
  const countryCode = data.country_code;
  if (!ip || typeof countryCode !== "string" || !/^[A-Z]{2}$/.test(countryCode)) return null;
  return {
    source: provider, ip, countryCode,
    city: typeof data.city === "string" ? data.city : null,
    regionName: typeof data.region === "string" ? data.region : null,
    timezone: (typeof data.timezone === "string" ? data.timezone : data.timezone?.id) ?? null,
    asn: data.connection?.asn ? `AS${data.connection.asn}` : typeof data.asn === "string" ? data.asn : null,
    org: typeof data.connection?.org === "string" ? data.connection.org : typeof data.org === "string" ? data.org : null,
  };
}

// CONNECT forwards the hostname to the existing proxy. Never resolve the target
// locally merely to run a diagnostic when messages themselves use that proxy.
export async function collectDnsDiagnostics(upstream, { inspect = proxyInfo, requestProbe = probe, lookupTarget = lookup } = {}) {
  const route = inspect(upstream);
  const delegated = route.mode === "http-connect";
  const [local, connectivity, ...references] = await Promise.all([
    delegated ? Promise.resolve({ hostname: upstream.hostname, addresses: [], resolvers: [], error: null }) : lookupTarget(upstream.hostname),
    delegated ? requestProbe(upstream) : Promise.resolve(null),
    ...["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"].map(async (endpoint) => {
      const url = new URL(endpoint);
      url.searchParams.set("name", upstream.hostname); url.searchParams.set("type", "A");
      const response = await requestProbe(url, { method: "GET", json: true, headers: { accept: "application/dns-json" } });
      const answers = response.status === 200 && response.data?.Status === 0 && Array.isArray(response.data?.Answer)
        ? [...new Set(response.data.Answer.filter((entry) => entry.type === 1 && publicIp(entry.data) && !/^198\.(18|19)\./.test(entry.data)).map((entry) => entry.data))] : [];
      return { source: url.hostname, answers, error: answers.length ? null : response.error ?? "DNS_REFERENCE_NO_ANSWER" };
    }),
  ]);
  return { ...local, mode: delegated ? "proxy" : "system", localLookupSkipped: delegated,
    routeStatus: connectivity?.status ?? null,
    error: delegated ? (connectivity?.status ? null : connectivity?.error ?? "PROXY_CONNECT_FAILED") : local.error,
    references, referenceAgreement: references.every((entry) => entry.answers.length)
      ? references[0].answers.some((address) => references[1].answers.includes(address)) : null };
}

export async function collectNetworkDiagnostics(upstream, { signalId } = {}) {
  const networkIds = ["country", "proxyCountry", "ipv4", "browserIpLocation", "browserIpOrg", "edgeAsn", "edgeAsnSecondary", "edgeOrg", "gatewayAsn", "exitType", "multiSourceConsistency", "ipSourceCount", "countrySet", "ipCountryRisk", "claudeAccessRisk"];
  const needsExit = !signalId || networkIds.includes(signalId);
  const selectedProbe = (id, url, options) => !signalId || signalId === id || signalId === "claudeAccessRisk" && id === "claudeReachability" ? probe(url, options) : Promise.resolve(undefined);
  const api = new URL(upstream.href.replace(/\/$/, "") + "/v1/models");
  const [claude, anthropic, apiProbe, resolved, geoA, geoB, ipv4, ipv6] = await Promise.all([
    selectedProbe("claudeReachability", "https://claude.ai/"), selectedProbe("anthropicReachability", "https://www.anthropic.com/"),
    selectedProbe("apiReachability", api, { method: "GET" }), !signalId || signalId.startsWith("dns") ? collectDnsDiagnostics(upstream) : Promise.resolve(undefined),
    needsExit ? probe("https://ipwho.is/", { method: "GET", json: true }) : Promise.resolve({}),
    needsExit ? probe("https://ipapi.co/json/", { method: "GET", json: true }) : Promise.resolve({}),
    !signalId || signalId === "ipv4" ? probe("https://api4.ipify.org/?format=json", { method: "GET", family: 4, json: true }) : Promise.resolve({}),
    !signalId ? probe("https://api6.ipify.org/?format=json", { method: "GET", family: 6, json: true }) : Promise.resolve({}),
  ]);
  const sources = [geoSource(geoA, "ipwho.is"), geoSource(geoB, "ipapi.co")].filter(Boolean);
  const countries = new Set(sources.map((source) => source.countryCode));
  return {
    checkedAt: new Date().toISOString(),
    testedSignals: [...(needsExit ? networkIds.filter((id) => id !== "ipv4" && id !== "claudeAccessRisk") : []),
      ...(!signalId || signalId === "ipv4" ? ["ipv4"] : []),
      ...(!signalId || signalId === "claudeAccessRisk" ? ["claudeAccessRisk"] : []),
      ...[claude && "claudeReachability", anthropic && "anthropicReachability", apiProbe && "apiReachability"].filter(Boolean),
      ...(resolved ? ["dnsMode", "dnsReview", "dnsConsistency"] : [])],
    probes: { claude, anthropic, api: apiProbe }, dns: resolved,
    exit: {
      sources, primary: sources[0] ?? null,
      consistentCountry: sources.length > 1 ? countries.size === 1 : null,
      ipv4: publicIp(ipv4.data?.ip), ipv6: publicIp(ipv6.data?.ip),
      ipv4Error: ipv4.error ?? (ipv4.status === 200 ? null : `HTTP_${ipv4.status}`),
      ipv6Error: ipv6.error ?? (ipv6.status === 200 ? null : `HTTP_${ipv6.status}`),
    },
  };
}

// 客户端线索与边缘观察：只读取本次真实请求的头，以及 Cloudflare 边缘 trace（不携带凭证）。
// 这些项用于判断“Claude 看到的环境是否自洽”，不证明账号可用性。
const CLUE_HEADERS = [
  "accept-language", "x-checkcc-target-locale", "user-agent", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
  "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile", "accept-encoding", "anthropic-version", "anthropic-beta",
  "x-app", "x-stainless-os", "x-stainless-lang", "x-stainless-runtime", "x-stainless-arch", "x-stainless-package-version",
];

export function extractClientClues(headers) {
  const picked = {};
  for (const key of CLUE_HEADERS) if (typeof headers[key] === "string") picked[key] = headers[key].slice(0, 256);
  const ua = picked["user-agent"] ?? "";
  return {
    headers: picked,
    clientHintBrands: picked["sec-ch-ua"] ?? null,
    clientHintPlatform: picked["sec-ch-ua-platform"]?.replace(/"/g, "") ?? null,
    secFetch: picked["sec-fetch-site"] || picked["sec-fetch-mode"] || picked["sec-fetch-dest"]
      ? [picked["sec-fetch-site"], picked["sec-fetch-mode"], picked["sec-fetch-dest"]].filter(Boolean).join(" / ")
      : null,
    sdk: [picked["x-stainless-lang"], picked["x-stainless-os"], picked["x-stainless-runtime"], picked["x-stainless-arch"]].filter(Boolean).join(" / ") || null,
    app: picked["x-app"] ?? null,
    uaLooksBrowser: /Mozilla\/5\.0/.test(ua) && !/node|python|curl|go-http/i.test(ua),
  };
}

// Cloudflare 边缘机房（colo）与边缘所在国家/城市；仅请求 trace，不发送任何用户数据。
export async function collectEdgeTrace(timeout = 4000) {
  const result = await probe("https://www.cloudflare.com/cdn-cgi/trace", { method: "GET", text: true, timeout });
  if (result.status !== 200 || typeof result.data !== "string") {
    return { colo: null, loc: null, city: null, http: result.status, error: result.error ?? (result.status === 200 ? "UNPARSED" : `HTTP_${result.status}`) };
  }
  const fields = Object.fromEntries(result.data.split("\n").map((line) => line.split("=")).filter((pair) => pair.length === 2));
  return { colo: fields.colo ?? null, loc: fields.loc ?? null, city: fields.city ?? null, http: result.status, error: null };
}
