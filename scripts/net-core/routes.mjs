// 从内核 /connections 快照提取 Claude 路由证据。
// 这是本产品与"靠 dig 或 STUN 推测"的关键差异：内核直接告诉我们每条连接的真实代理链，
// 因此可以断言"零直连"，而不是给一个概率分数。

import { CLAUDE_DOMAINS, DEFAULT_GROUP } from "./config.mjs";

const DIRECT_CHAINS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS"]);

export function normalizeHost(host) {
  return String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
}

/** 后缀匹配必须带点边界，避免 notanthropic.com 被当成 anthropic.com。 */
export function matchesDomain(host, domain) {
  const target = normalizeHost(host);
  const suffix = normalizeHost(domain);
  if (!target || !suffix) return false;
  return target === suffix || target.endsWith(`.${suffix}`);
}

export function isClaudeHost(host, { domains = CLAUDE_DOMAINS } = {}) {
  return domains.some((domain) => matchesDomain(host, domain));
}

function chainOf(connection) {
  const chains = Array.isArray(connection?.chains) ? connection.chains.filter((item) => typeof item === "string" && item) : [];
  return chains;
}

function hostOf(connection) {
  const metadata = connection?.metadata ?? {};
  // 域名连接用 host；纯 IP 连接用 destinationIP，仍然可以判断是否走了代理。
  return normalizeHost(metadata.host ?? metadata.destinationIP ?? "");
}

/** 归一化 mihomo 的多种返回形态：{connections:[...]} / [...] / {connections:null}。 */
export function listConnections(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === "object");
  const list = payload?.connections;
  return Array.isArray(list) ? list.filter((item) => item && typeof item === "object") : [];
}

/**
 * 计算 Claude 路由证据。
 * state:
 *   verified  —— 有 Claude 连接，且全部命中置顶组，零直连
 *   violation —— 存在直连的 Claude 连接
 *   unknown   —— 没有观察到 Claude 连接（不能当成通过）
 */
export function routingEvidence(payload, { group = DEFAULT_GROUP, domains = CLAUDE_DOMAINS, sampledAt = new Date().toISOString() } = {}) {
  const connections = listConnections(payload);
  const claude = connections.filter((connection) => isClaudeHost(hostOf(connection), { domains }));

  const violations = [];
  const pinnedHosts = new Set();
  const groups = new Set();
  let pinned = 0;
  let direct = 0;

  for (const connection of claude) {
    const host = hostOf(connection);
    const chains = chainOf(connection);
    chains.forEach((name) => groups.add(name));
    const isDirect = chains.length === 0 || chains.some((name) => DIRECT_CHAINS.has(name));
    if (isDirect) {
      direct += 1;
      violations.push({ host, chains, rule: connection?.rule ?? null, rulePayload: connection?.rulePayload ?? null });
      continue;
    }
    if (chains.includes(group)) {
      pinned += 1;
      pinnedHosts.add(host);
      continue;
    }
    // 走了代理但没经过 Claude 专用组：说明置顶规则被其他规则抢先命中，同样算违规。
    violations.push({ host, chains, rule: connection?.rule ?? null, rulePayload: connection?.rulePayload ?? null });
  }

  const state = violations.length || direct > 0 ? "violation" : claude.length ? (pinned === claude.length ? "verified" : "violation") : "unknown";

  return {
    version: 1,
    sampledAt,
    group,
    state,
    total: connections.length,
    claude: claude.length,
    pinned,
    direct,
    violations,
    pinnedHosts: [...pinnedHosts],
    groups: [...groups],
  };
}

/** 供检测引擎使用：把证据转成一句可直接展示的结论。 */
export function routingSummary(evidence, { locale = "zh" } = {}) {
  const zh = String(locale).startsWith("zh");
  if (!evidence || evidence.state === "unknown") {
    return zh ? "未观察到 Claude 连接，无法验证是否走隧道。" : "No Claude connections observed; tunnel routing is unverified.";
  }
  if (evidence.state === "violation") {
    const hosts = evidence.violations.map((item) => item.host).filter(Boolean).slice(0, 3).join(", ");
    return zh
      ? `存在未走 Claude 专用出口的连接：${hosts || "未知主机"}（直连 ${evidence.direct} 条）。`
      : `Connections bypassed the Claude-only exit: ${hosts || "unknown host"} (${evidence.direct} direct).`;
  }
  return zh
    ? `${evidence.claude} 条 Claude 连接全部命中 ${evidence.group}，无直连。`
    : `All ${evidence.claude} Claude connections resolved through ${evidence.group}; no direct connections.`;
}
