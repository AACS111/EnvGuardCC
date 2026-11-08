// 出口 IP 历史：判断"出口是否在漂移"。
// 频繁换 IP 本身就是风险画像的一部分，因此这里记录 48h 内的出口变化，而不是只看当前值。
// 只保存 IP 与时间，不保存任何账号信息。

import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";

export const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;
const operations = new Map();
const serialize = (stateDir, action) => {
  const key = path.resolve(stateDir);
  const next = (operations.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  operations.set(key, next);
  void next.finally(() => { if (operations.get(key) === next) operations.delete(key); }).catch(() => {});
  return next;
};

function file(stateDir) {
  return path.join(stateDir, "exit-history.json");
}

function isValidIp(value) {
  const text = String(value ?? "").trim();
  return isIP(text) !== 0;
}

async function write(stateDir, entries) {
  const target = file(stateDir);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function read(stateDir) {
  try {
    const value = JSON.parse(await readFile(file(stateDir), "utf8"));
    return Array.isArray(value?.entries) ? value.entries.filter((entry) => entry && isValidIp(entry.ip) && Number.isFinite(entry.at)) : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [];
  }
}

/** 记录一次出口观测；返回窗口内的变化统计。 */
export function recordExit(stateDir, ip, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  return serialize(stateDir, async () => {
    const entries = (await read(stateDir)).filter((entry) => entry.at <= now && now - entry.at <= windowMs).sort((a, b) => a.at - b.at);
    if (!isValidIp(ip)) return summarize(entries, { windowMs, current: null });
    const last = entries.at(-1);
    if (!last || last.ip !== ip) {
      entries.push({ ip: String(ip).trim(), at: now });
      await write(stateDir, entries);
    }
    return summarize(entries, { windowMs, current: String(ip).trim() });
  });
}

export async function readExitHistory(stateDir, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  await operations.get(path.resolve(stateDir))?.catch(() => {});
  const entries = (await read(stateDir)).filter((entry) => entry.at <= now && now - entry.at <= windowMs).sort((a, b) => a.at - b.at);
  return summarize(entries, { windowMs, current: entries.at(-1)?.ip ?? null });
}

function summarize(entries, { windowMs, current }) {
  const unique = [...new Set(entries.map((entry) => entry.ip))];
  const changes = entries.reduce((count, entry, index) => count + (index > 0 && entry.ip !== entries[index - 1].ip ? 1 : 0), 0);
  return {
    windowHours: Math.round(windowMs / 3600000),
    samples: entries.length,
    changes,
    stable: entries.length > 0 && changes === 0,
    current: current ?? null,
    ips: unique.slice(-8),
    firstAt: entries[0]?.at ? new Date(entries[0].at).toISOString() : null,
    lastAt: entries.at(-1)?.at ? new Date(entries.at(-1).at).toISOString() : null,
  };
}

/** 出口网络类型分类：只做保守判断，未知不硬猜。 */
export function classifyAsn(org) {
  const text = String(org ?? "").toLowerCase();
  if (!text) return { kind: "unknown", label: "未知" };
  const residential = /(comcast|at&t|verizon|spectrum|charter|cox|t-mobile|cable|residential|ntt|kddi|softbank|iij|ocn|so-net|hinet|chunghwa|kbro|fareastone|singtel|starhub|hkt|pccw|hkbn|hgc|bt |sky |virgin|talktalk|vodafone|deutsche telekom|1&1)/;
  const datacenter = /(amazon|aws|google|cloud|microsoft|azure|digitalocean|linode|vultr|ovh|hetzner|alibaba|aliyun|tencent|oracle|contabo|leaseweb|choopa|hosting|server|datacenter|data center|idc)/;
  if (residential.test(text)) return { kind: "residential", label: "住宅/运营商" };
  if (datacenter.test(text)) return { kind: "datacenter", label: "机房/云" };
  return { kind: "unknown", label: "未知（需人工判断）" };
}
