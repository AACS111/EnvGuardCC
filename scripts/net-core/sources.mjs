// 供应商（配置来源）：把"从哪来的一批节点"保存成可命名、可切换、可编辑的条目。
// 纯函数、不碰文件，importNodes / 网关接口与 node --test 共用同一份规则。
//
// 三条规则：
//   1. 节点快照跟着来源走：切换供应商直接用已保存的快照，不依赖网络；
//   2. 同名来源不许悄悄覆盖：链接相同视为同一供应商（更新），否则新建；
//   3. 来源名必须有可读兜底，界面不能出现"未命名"。

import { randomUUID } from "node:crypto";

export const SOURCE_MODES = ["url", "manual", "content", "local"];
const DEFAULT_INTERVAL_HOURS = 6;

export function newSourceId() {
  return `src_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function defaultSourceName({ mode, url, name } = {}) {
  if (typeof name === "string" && name.trim()) return name.trim().slice(0, 60);
  if (mode === "url" && typeof url === "string") {
    try {
      return new URL(url).hostname.slice(0, 60);
    } catch { /* 非法链接用兜底名，不能把异常抛给界面 */ }
  }
  if (mode === "local") return "本地代理";
  if (mode === "content") return "粘贴的配置";
  return "手动配置";
}

const toIso = (value, fallback) => {
  const at = Date.parse(String(value ?? ""));
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback;
};

const toHours = (value) => {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? Math.min(168, Math.round(hours)) : DEFAULT_INTERVAL_HOURS;
};

const cleanProxies = (proxies) => (Array.isArray(proxies) ? proxies.filter((proxy) => proxy && typeof proxy === "object" && typeof proxy.name === "string" && proxy.name) : []);
const cleanDns = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).slice(0, 8) : [];

/** 单条来源归一化：缺名字、缺时间、缺 id 都能修好；没有节点的来源视为无效。 */
export function normalizeSource(raw, { now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const proxies = cleanProxies(raw.proxies);
  if (!proxies.length) return null;
  const mode = SOURCE_MODES.includes(raw.mode) ? raw.mode : (typeof raw.url === "string" && raw.url ? "url" : "manual");
  const url = mode === "url" && typeof raw.url === "string" && raw.url ? raw.url : null;
  const selected = typeof raw.selected === "string" && proxies.some((proxy) => proxy.name === raw.selected) ? raw.selected : proxies[0].name;
  return {
    id: typeof raw.id === "string" && /^[a-z0-9_]{3,40}$/i.test(raw.id) ? raw.id : newSourceId(),
    name: defaultSourceName({ mode, url, name: raw.name }),
    mode,
    url,
    proxies,
    selected,
    proxyServerDns: cleanDns(raw.proxyServerDns),
    updatedAt: toIso(raw.updatedAt, now),
    intervalHours: toHours(raw.intervalHours),
  };
}

/** 报告里只暴露来源元信息，不下发整份节点快照。 */
export function sourceDescriptor(source) {
  if (!source) return null;
  return { mode: source.mode, url: source.url, updatedAt: source.updatedAt, intervalHours: source.intervalHours };
}

export function publicSources(sources, activeId) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({
    id: source.id,
    name: source.name,
    mode: source.mode,
    url: source.url,
    nodeCount: Array.isArray(source.proxies) ? source.proxies.length : 0,
    selected: source.selected,
    updatedAt: source.updatedAt,
    intervalHours: source.intervalHours,
    active: source.id === activeId,
  }));
}

/**
 * 文件迁移：新版按 sources 读；旧版只有 proxies + source，自动合成一条来源。
 * 返回值就是运行时内存里的节点状态（active 的 proxies 已展开）。
 */
export function migrateStore(raw, { now = new Date().toISOString() } = {}) {
  const sources = [];
  if (Array.isArray(raw?.sources)) {
    for (const item of raw.sources) {
      const source = normalizeSource(item, { now });
      if (source) sources.push(source);
    }
  }
  // 旧版文件：一条隐式来源，名字优先取订阅域名。
  if (!sources.length && Array.isArray(raw?.proxies) && raw.proxies.length) {
    const legacy = normalizeSource({
      id: "src_legacy",
      name: defaultSourceName({ mode: raw?.source?.mode, url: raw?.source?.url }),
      mode: raw?.source?.mode ?? (raw?.source?.url ? "url" : "manual"),
      url: raw?.source?.url ?? null,
      proxies: raw.proxies,
      selected: raw.selected,
      proxyServerDns: raw.proxyServerDns,
      updatedAt: raw?.source?.updatedAt ?? raw?.updatedAt,
      intervalHours: raw?.source?.intervalHours,
    }, { now });
    if (legacy) sources.push(legacy);
  }
  const activeId = sources.some((source) => source.id === raw?.activeId) ? raw.activeId : (sources[0]?.id ?? null);
  const active = sources.find((source) => source.id === activeId) ?? null;
  // 旧 v2 的 DNS 在顶层，只归属当时的 active，绝不能复制到其他来源。
  const original = raw?.sources?.find?.(item => item?.id === activeId);
  if (active && original && !Object.hasOwn(original, "proxyServerDns")) active.proxyServerDns = cleanDns(raw?.proxyServerDns);
  return {
    sources,
    activeId,
    proxies: active?.proxies ?? [],
    selected: active?.selected ?? null,
    source: sourceDescriptor(active),
    proxyServerDns: active?.proxyServerDns ?? [],
  };
}

/**
 * 新增或更新一条来源。传 id 是编辑；链接相同的订阅视为同一条来源（避免重复导入）；
 * 其余情况新建。返回新的来源数组与命中项。
 */
export function upsertSource(sources, input, { now = new Date().toISOString(), id = null } = {}) {
  const list = Array.isArray(sources) ? [...sources] : [];
  const proxies = cleanProxies(input?.proxies);
  if (!proxies.length) throw new Error("没有可用的节点（全部条目缺少必要字段）。");
  const mode = SOURCE_MODES.includes(input?.mode) ? input.mode : "manual";
  const url = mode === "url" && typeof input?.url === "string" && input.url ? input.url : null;
  const index = id
    ? list.findIndex((source) => source.id === id)
    : (mode === "url" && url ? list.findIndex((source) => source.mode === "url" && source.url === url) : -1);
  const current = index >= 0 ? list[index] : null;
  const selected = typeof input?.selected === "string" && proxies.some((proxy) => proxy.name === input.selected)
    ? input.selected
    : (current?.selected && proxies.some((proxy) => proxy.name === current.selected) ? current.selected : proxies[0].name);
  const source = normalizeSource({
    id: current?.id ?? newSourceId(),
    name: input?.name ?? current?.name,
    mode,
    url,
    proxies,
    selected,
    updatedAt: now,
    intervalHours: input?.intervalHours ?? current?.intervalHours,
    proxyServerDns: input?.proxyServerDns ?? current?.proxyServerDns ?? [],
  }, { now });
  if (!source) throw new Error("没有可用的节点（全部条目缺少必要字段）。");
  if (index >= 0) list[index] = source;
  else list.push(source);
  return { sources: list, source };
}

export function renameSource(sources, id, name) {
  const list = Array.isArray(sources) ? sources : [];
  const trimmed = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!trimmed) throw new Error("供应商名称不能为空。");
  let hit = null;
  const next = list.map((source) => {
    if (source.id !== id) return source;
    hit = { ...source, name: trimmed };
    return hit;
  });
  if (!hit) throw new Error("找不到这条配置。");
  return { sources: next, source: hit };
}

export function removeSource(sources, id) {
  const list = Array.isArray(sources) ? sources : [];
  const next = list.filter((source) => source.id !== id);
  if (next.length === list.length) throw new Error("找不到这条配置。");
  return { sources: next };
}

/** 当前来源被删除或切换后，决定新的 activeId 与 active 快照。 */
export function pickActive(sources, wantedId = null) {
  const list = Array.isArray(sources) ? sources : [];
  const active = list.find((source) => source.id === wantedId) ?? list[0] ?? null;
  return {
    activeId: active?.id ?? null,
    active,
    proxies: active?.proxies ?? [],
    selected: active?.selected ?? null,
    source: sourceDescriptor(active),
    proxyServerDns: active?.proxyServerDns ?? [],
  };
}

/** 写盘用的稳定结构：active 快照放回顶层，兼容只读顶层 proxies 的旧代码。 */
export function serializeStore({ sources, activeId, now = new Date().toISOString() }) {
  const active = pickActive(sources, activeId);
  return {
    version: 2,
    sources: sources ?? [],
    activeId: active.activeId,
    proxies: active.proxies,
    selected: active.selected,
    source: active.source,
    proxyServerDns: active.proxyServerDns,
    updatedAt: now,
  };
}
