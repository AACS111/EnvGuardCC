import { isDeepStrictEqual } from 'node:util';
import { parseDocument, isAlias, isMap, isScalar, isSeq, visit } from 'yaml';
import { buildTrafficConfig } from './traffic-rules.mjs';

const conflict = reason => ({ kind: 'conflict', reason });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function parse(raw) {
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error('配置不是可安全处理的 YAML。');
  return { document, value: document.toJS({ maxAliasCount: 100 }) };
}

export function hasTrafficReferences(value) {
  const seen = new WeakSet();
  const check = item => {
    if (typeof item === 'string') return /EnvGuardCC-|checkcc-return-/.test(item);
    if (!item || typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    return Object.entries(item).some(([key, child]) => check(key) || check(child));
  };
  return check(value);
}

export function hasTrafficEndpoints(value, config) {
  const ports = new Set([config.listenPort, ...config.routes.map(route => Number(new URL(route.upstream).port))].map(Number).filter(port => Number.isInteger(port) && port > 0));
  const seen = new WeakSet();
  const check = item => {
    if (!item || typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const host = String(item.server ?? item.listen ?? item.host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    if (ports.has(Number(item.port)) && (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\./.test(host))) return true;
    return Object.values(item).some(check);
  };
  return check(value);
}

function hasComments(node) {
  let found = false;
  visit(node, (_key, item) => {
    if (item?.comment || item?.commentBefore) found = true;
  });
  return found;
}

function hasAliasesOrAnchors(document) {
  let found = false;
  visit(document, (_key, item) => {
    if (isAlias(item) || item?.anchor || item?.tag) found = true;
  });
  return found;
}

function comments(document) {
  const found = [];
  const add = item => { if (item?.comment) found.push(item.comment); if (item?.commentBefore) found.push(item.commentBefore); };
  add(document);
  visit(document, (_key, item) => add(item));
  return found;
}

// Show paths, not values: profile values can contain node credentials.
export function summarizeTrafficChanges(applied, current) {
  const changes = [];
  const seen = new WeakMap();
  const walk = (before, after, path) => {
    if (isDeepStrictEqual(before, after)) return;
    if (changes.length >= 30) return;
    if (before && after && typeof before === 'object' && typeof after === 'object') {
      if (seen.get(before)?.has(after)) return;
      if (!seen.has(before)) seen.set(before, new WeakSet());
      seen.get(before).add(after);
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walk(before[key], after[key], path ? `${path}.${key}` : key);
    } else if (Array.isArray(before) && Array.isArray(after)) {
      const max = Math.max(before.length, after.length);
      for (let i = 0; i < max && changes.length < 30; i++) walk(before[i], after[i], `${path}[${i + 1}]`);
    } else {
      const change = { path, change: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified' };
      if (/\.port$/.test(path) && (typeof before === 'number' || before === undefined) && (typeof after === 'number' || after === undefined)) {
        if (before !== undefined) change.before = before;
        if (after !== undefined) change.after = after;
      }
      changes.push(change);
    }
  };
  walk(applied, current, '');
  return changes;
}

function removeGeneratedEntries(document, original, generated, routes, key, prefix) {
  const names = new Set(routes.map(route => `${prefix}${route.id}`));
  const expected = new Map((generated[key] ?? []).filter(item => names.has(item?.name)).map(item => [item.name, item]));
  if (expected.size !== names.size || (original[key] ?? []).some(item => names.has(item?.name))) throw new Error('联动备份无法核对。');
  const sequence = document.get(key, true);
  if (sequence === undefined) return;
  if (!isSeq(sequence)) throw new Error(`${key} 的结构发生变化。`);
  const seen = new Set();
  sequence.items = sequence.items.filter(item => {
    const name = isMap(item) ? item.get('name') : undefined;
    if (!names.has(name)) return true;
    if (seen.has(name) || !isDeepStrictEqual(item.toJSON(), expected.get(name)) || hasComments(item)) throw new Error('联动项被修改或添加了注释，无法自动移除。');
    seen.add(name);
    return false;
  });
  if (!sequence.items.length && !own(original, key) && !hasComments(sequence)) document.delete(key);
}

function restoreRules(sequence, original, generated, prefix = []) {
  if (!isSeq(sequence) || !Array.isArray(original) || !Array.isArray(generated)) throw new Error('规则结构发生变化。');
  if (generated.length !== original.length + prefix.length) throw new Error('联动规则备份无法核对。');
  for (let i = 0; i < prefix.length; i++) {
    const item = sequence.items[i];
    if (!isScalar(item) || item.value !== prefix[i] || hasComments(item)) throw new Error('联动规则已被移动或修改。');
  }
  const replacements = new Map();
  for (let i = 0; i < original.length; i++) {
    const from = generated[i + prefix.length], to = original[i];
    if (from === to) continue;
    if (replacements.has(from) && replacements.get(from) !== to) throw new Error('联动规则存在无法区分的重复项。');
    replacements.set(from, to);
  }
  sequence.items.splice(0, prefix.length);
  for (const item of sequence.items) {
    if (isScalar(item) && replacements.has(item.value)) item.value = replacements.get(item.value);
  }
}

/** Prepare a conservative inverse of our own changes, without writing any file. */
export function planTrafficRecovery({ originalRaw, appliedRaw, currentRaw, config }) {
  let original, originalDocument, current, document;
  try {
    ({ value: original, document: originalDocument } = parse(originalRaw));
    ({ value: current, document } = parse(currentRaw));
  } catch {
    return conflict('当前配置或原始备份无法解析，请检查备份后手动处理。');
  }

  let applied;
  try { if (appliedRaw) applied = parse(appliedRaw).value; } catch { /* clean profiles can still be verified */ }
  const changes = applied ? summarizeTrafficChanges(applied, current) : [];
  const markerPresent = hasTrafficReferences(current) || hasTrafficEndpoints(current, config);
  if ((current.rules !== undefined && !Array.isArray(current.rules)) || (original.rules !== undefined && !Array.isArray(original.rules))) return { ...conflict('规则结构无法安全核对，请查看备份后手动处理。'), changes };
  const loopback = ['IP-CIDR,127.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR6,::1/128,DIRECT,no-resolve'];
  const forced = [
    ...(config.sites?.domains ?? []).map(domain => `DOMAIN-SUFFIX,${domain},`),
    ...(config.sites?.cidrs ?? []).map(cidr => `${cidr.includes(':') ? 'IP-CIDR6' : 'IP-CIDR'},${cidr},`),
  ];
  const extra = test => (current.rules ?? []).filter(test).length > (original.rules ?? []).filter(test).length;
  const strayRules = loopback.some(rule => extra(item => item === rule)) || forced.some(prefix => extra(item => typeof item === 'string' && item.startsWith(prefix)));
  if (!markerPresent && !strayRules) return { kind: 'clean', changes };
  if (!applied) return { ...conflict('缺少可核对的联动配置备份，请查看备份后手动处理。'), changes };
  if (hasAliasesOrAnchors(document)) return { ...conflict('配置含锚点、别名或自定义标签，请查看备份后手动处理。'), changes };
  if (hasAliasesOrAnchors(originalDocument)) return { ...conflict('联动前配置含锚点、别名或自定义标签，请查看备份后手动处理。'), changes };
  const currentComments = comments(document);
  for (const comment of comments(originalDocument)) {
    const index = currentComments.indexOf(comment);
    if (index < 0) return { ...conflict('联动前的配置注释未保留在当前文件中，请查看备份后手动处理。'), changes };
    currentComments.splice(index, 1);
  }

  try {
    const first = config.routes[0];
    if (!first) throw new Error('缺少联动路径。');
    const built = buildTrafficConfig(original, {
      secret: config.secret, listenPort: config.listenPort,
      upstreamBasePort: Number(new URL(first.upstream).port),
      defaultPolicy: config.defaultPolicy, sites: config.sites,
    });
    if (!isDeepStrictEqual(built.config, applied) || !isDeepStrictEqual(built.routes, config.routes)) throw new Error('联动配置备份与原始配置不匹配。');

    removeGeneratedEntries(document, original, applied, config.routes, 'proxies', 'EnvGuardCC-');
    removeGeneratedEntries(document, original, applied, config.routes, 'listeners', 'checkcc-return-');
    const oldRules = original.rules ?? [];
    const generatedRules = applied.rules ?? [];
    const prefixLength = generatedRules.length - oldRules.length;
    if (prefixLength < 2) throw new Error('联动规则备份不完整。');
    restoreRules(document.get('rules', true), oldRules, generatedRules, generatedRules.slice(0, prefixLength));
    if (!own(original, 'rules') && !document.get('rules', true).items.length && !hasComments(document.get('rules', true))) document.delete('rules');
    const subrules = document.get('sub-rules', true);
    if (subrules !== undefined) {
      if (!isMap(subrules)) throw new Error('子规则结构发生变化。');
      for (const [name, oldRulesForName] of Object.entries(original['sub-rules'] ?? {})) {
        const currentRules = subrules.get(name, true);
        if (currentRules !== undefined) restoreRules(currentRules, oldRulesForName, applied['sub-rules'][name]);
      }
    }
    if (!isDeepStrictEqual(original.mode, applied.mode) && isDeepStrictEqual(current.mode, applied.mode)) {
      if (own(original, 'mode')) document.set('mode', original.mode);
      else document.delete('mode');
    }
    const restored = document.toJS({ maxAliasCount: 100 });
    if (hasTrafficReferences(restored) || hasTrafficEndpoints(restored, config)) throw new Error('仍有无法自动还原的联动引用或本机入口。');
    const candidate = document.toString({ lineWidth: 0 });
    if (!isDeepStrictEqual(parse(candidate).value, restored)) throw new Error('恢复候选无法完整保留配置。');
    return { kind: 'merge', changes, candidate };
  } catch (error) {
    return { ...conflict(error.message), changes };
  }
}
