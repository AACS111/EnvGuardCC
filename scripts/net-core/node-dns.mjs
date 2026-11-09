// 节点服务器地址解析：订阅常用服务商私有域名，公共 DNS 解析出的地址连不上（实测事故）。
//
// 只把「解析结果」交给内核不够稳：服务商 DoH 本身会挂（实测 TCP 超时），一旦它不可用，
// 全部节点瞬间变超时。这里做的是：解析 → TCP 验证 → 把可用 IP 写成内核 hosts，
// 让节点拨号完全不依赖 DNS 实时可用；拿不到可用 IP 时不写，交给内核自己解析。

import net from "node:net";
import dns from "node:dns";

const PUBLIC_DOH = ["https://223.5.5.5/dns-query", "https://1.1.1.1/dns-query"];
const HOST_CACHE_TTL_MS = 10 * 60 * 1000;

function encodeDnsQuery(name, type = 1) {
  const parts = String(name).split(".").filter(Boolean);
  return Buffer.concat([
    Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    Buffer.concat(parts.map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]))),
    Buffer.from([0, 0, type, 0, 1]),
  ]);
}

/** 从 DNS 响应里取出 A/AAAA 记录（不完整解压指针，只认最常见的 0xC0 指针形式）。 */
export function readAddressRecords(buffer) {
  const addresses = [];
  const total = buffer.readUInt16BE(6);
  if (!total) return addresses;
  let offset = 12;
  const skipName = (start) => {
    let index = start;
    while (index < buffer.length) {
      const length = buffer[index];
      if (length === 0) return index + 1;
      if ((length & 0xc0) === 0xc0) return index + 2;
      index += length + 1;
    }
    return buffer.length;
  };
  const questionCount = buffer.readUInt16BE(4);
  for (let i = 0; i < questionCount; i += 1) {
    offset = skipName(offset);
    offset += 4;
  }
  for (let i = 0; i < total && offset < buffer.length; i += 1) {
    offset = skipName(offset);
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 8);
    const dataStart = offset + 10;
    if (type === 1 && length === 4) addresses.push([...buffer.subarray(dataStart, dataStart + 4)].join("."));
    if (type === 28 && length === 16) {
      const groups = [];
      for (let g = 0; g < 16; g += 2) groups.push(buffer.readUInt16BE(dataStart + g).toString(16));
      addresses.push(groups.join(":"));
    }
    offset = dataStart + length;
  }
  return addresses;
}

async function queryDoh(endpoint, name, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = String(endpoint).replace(/#.*$/, "");
  const response = await fetchImpl(base, {
    method: "POST",
    headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
    body: encodeDnsQuery(name),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`DoH ${response.status}`);
  return readAddressRecords(Buffer.from(await response.arrayBuffer()));
}

function querySystem(name, { lookup = dns.promises.lookup } = {}) {
  return lookup(name, { all: true, verbatim: true }).then((rows) => rows.map((row) => row.address));
}

function probeTcp(address, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * 解析节点服务器域名 → 可用 IP。
 * @param {Array<{name?: string, server?: string, port?: number}>} nodes
 * @param {{dnsServers?: string[], fetchImpl?: Function, lookup?: Function, probe?: Function, ports?: Map<string, number>}} [options]
 * @returns {Promise<Record<string, string[]>>} 域名 → 已验证可达的 IP
 */
export async function resolveNodeHosts(nodes, { dnsServers = [], fetchImpl, lookup, probe = probeTcp } = {}) {
  const targets = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const server = typeof node?.server === "string" ? node.server.trim() : "";
    if (!server || net.isIP(server)) continue;
    if (!targets.has(server)) targets.set(server, Number(node?.port) || 443);
  }
  const endpoints = [...dnsServers.map((entry) => String(entry).replace(/#.*$/, "")).filter((entry) => /^https?:\/\//.test(entry)), ...PUBLIC_DOH];
  const hosts = {};
  await Promise.all([...targets].map(async ([server, port]) => {
    const candidates = [];
    for (const endpoint of endpoints) {
      try { candidates.push(...await queryDoh(endpoint, server, { fetchImpl })); } catch { /* 服务商 DoH 经常不可用：继续试下一个 */ }
      if (candidates.length) break;
    }
    if (!candidates.length) {
      try { candidates.push(...await querySystem(server, { lookup })); } catch { /* 解析不出来就不写 hosts */ }
    }
    const verified = [];
    for (const address of [...new Set(candidates)].slice(0, 6)) {
      if (await probe(address, port).catch(() => false)) verified.push(address);
    }
    if (verified.length) hosts[server] = verified;
  }));
  return hosts;
}

/** 进程内缓存：同一次运行里不要每次都重新解析+探测。 */
export function createNodeHostResolver(options = {}) {
  let cache = { hosts: {}, at: 0 };
  return async function getNodeHosts(nodes, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - cache.at < HOST_CACHE_TTL_MS && Object.keys(cache.hosts).length) return cache.hosts;
    try {
      cache = { hosts: await resolveNodeHosts(nodes, options), at: now };
    } catch {
      cache = { hosts: {}, at: now };
    }
    return cache.hosts;
  };
}

/**
 * 带持久化的解析：先读上次确认过的 hosts（并逐个 TCP 复验），复验通过就直接用；
 * 同时后台刷新，避免服务商 DoH 抖动一次就让全部节点变超时（实测事故）。
 * @param {{cacheFile: string, resolve?: Function, writeFile?: Function, readFile?: Function}} options
 */
export async function loadVerifiedNodeHosts(nodes, { cacheFile, resolve = resolveNodeHosts, probe = probeTcp, readFile, writeFile, force = false } = {}) {
  const fs = await import("node:fs/promises");
  const read = readFile ?? fs.readFile;
  const write = writeFile ?? fs.writeFile;
  let cached = { hosts: {}, updatedAt: null };
  try { cached = JSON.parse(await read(cacheFile, "utf8")) ?? cached; } catch { /* 首次运行没有缓存 */ }
  const cachedHosts = cached?.hosts && typeof cached.hosts === "object" ? cached.hosts : {};

  // 复验缓存：只有 IP 真的还能连上才继续用，避免把过期/错误地址钉死。
  const verified = {};
  const ports = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (typeof node?.server === "string" && !net.isIP(node.server)) ports.set(node.server, Number(node.port) || 443);
  }
  await Promise.all([...ports].map(async ([server, port]) => {
    const addresses = Array.isArray(cachedHosts[server]) ? cachedHosts[server] : [];
    for (const address of addresses.slice(0, 4)) {
      if (await probe(address, port).catch(() => false)) { verified[server] = [...(verified[server] ?? []), address]; }
    }
  }));

  if (!force && Object.keys(verified).length === ports.size) return verified;
  try {
    const fresh = await resolve(nodes);
    const merged = { ...verified, ...fresh };
    if (Object.keys(merged).length) {
      await write(cacheFile, `${JSON.stringify({ hosts: merged, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
      return merged;
    }
  } catch { /* 解析失败：退回已验证的缓存 */ }
  return verified;
}
