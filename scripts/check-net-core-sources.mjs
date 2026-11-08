// 供应商（配置来源）规则：迁移、去重、切换、删除。
// 这些规则直接决定「用户保存的多个机场会不会互相覆盖」，用 node --test 固定住。

import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSourceName,
  migrateStore,
  normalizeSource,
  pickActive,
  publicSources,
  removeSource,
  renameSource,
  serializeStore,
  upsertSource,
} from "./net-core/sources.mjs";

const node = (name) => ({ name, type: "ss", server: `${name}.example.com`, port: 443, cipher: "aes-128-gcm", password: "p" });

test("旧版单订阅文件迁移成一条命名的供应商", () => {
  const store = migrateStore({
    proxies: [node("首尔-1"), node("东京-2")],
    selected: "东京-2",
    source: { mode: "url", url: "https://sub.example.com/a.yaml", updatedAt: "2026-11-01T10:00:00.000Z" },
    proxyServerDns: ["1.1.1.1"],
  });
  assert.equal(store.sources.length, 1);
  assert.equal(store.sources[0].name, "sub.example.com");
  assert.equal(store.sources[0].id, "src_legacy");
  assert.equal(store.activeId, "src_legacy");
  assert.equal(store.proxies.length, 2);
  assert.equal(store.selected, "东京-2");
  assert.equal(store.source.mode, "url");
  assert.deepEqual(store.proxyServerDns, ["1.1.1.1"]);
});

test("多供应商文件按 activeId 取快照，activeId 失效时回退第一条", () => {
  const raw = {
    sources: [
      { id: "src_a", name: "A 机场", mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")], selected: "a1", updatedAt: "2026-11-01T10:00:00.000Z" },
      { id: "src_b", name: "B 机场", mode: "url", url: "https://b.example.com/s.yaml", proxies: [node("b1"), node("b2")], selected: "b2", updatedAt: "2026-11-02T10:00:00.000Z" },
    ],
    activeId: "src_b",
  };
  const store = migrateStore(raw);
  assert.equal(store.activeId, "src_b");
  assert.deepEqual(store.proxies.map((item) => item.name), ["b1", "b2"]);
  assert.equal(store.selected, "b2");
  assert.equal(store.source.url, "https://b.example.com/s.yaml");

  const fallback = migrateStore({ ...raw, activeId: "src_missing" });
  assert.equal(fallback.activeId, "src_a");
  assert.equal(fallback.proxies[0].name, "a1");
});

test("没有节点的来源不会被当成供应商", () => {
  assert.equal(normalizeSource({ name: "空", proxies: [] }), null);
  assert.equal(normalizeSource({ name: "坏", proxies: "nope" }), null);
  assert.equal(normalizeSource(null), null);
});

test("缺少名字与时间时给出可读兜底，不显示未命名", () => {
  assert.equal(defaultSourceName({ mode: "url", url: "https://vendor.example.com/sub" }), "vendor.example.com");
  assert.equal(defaultSourceName({ mode: "url", url: "not a url" }), "手动配置");
  assert.equal(defaultSourceName({ mode: "local" }), "本地代理");
  const source = normalizeSource({ proxies: [node("n1")] }, { now: "2026-11-05T00:00:00.000Z" });
  assert.equal(source.name, "手动配置");
  assert.equal(source.updatedAt, "2026-11-05T00:00:00.000Z");
  assert.ok(source.id.startsWith("src_"));
});

test("同一订阅地址重复导入是更新，不是新增一条重复供应商", () => {
  const first = upsertSource([], { mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")] }, { now: "2026-11-01T00:00:00.000Z" });
  assert.equal(first.sources.length, 1);
  const second = upsertSource(first.sources, { mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a2"), node("a3")] }, { now: "2026-11-02T00:00:00.000Z" });
  assert.equal(second.sources.length, 1);
  assert.equal(second.source.id, first.source.id);
  assert.equal(second.source.proxies.length, 2);
  assert.equal(second.source.updatedAt, "2026-11-02T00:00:00.000Z");
});

test("编辑不传名字时保留原名字，传了才改名", () => {
  const added = upsertSource([], { name: "首尔机场", mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")] });
  const edited = upsertSource(added.sources, { mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")] }, { id: added.source.id });
  assert.equal(edited.source.name, "首尔机场");
  const renamed = upsertSource(edited.sources, { name: "备用机场", mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")] }, { id: added.source.id });
  assert.equal(renamed.source.name, "备用机场");
});

test("两条不同的订阅可以并存，切换只换当前快照", () => {
  const a = upsertSource([], { name: "A", mode: "url", url: "https://a.example.com/s.yaml", proxies: [node("a1")] });
  const b = upsertSource(a.sources, { name: "B", mode: "url", url: "https://b.example.com/s.yaml", proxies: [node("b1")] });
  assert.equal(b.sources.length, 2);
  const back = pickActive(b.sources, a.source.id);
  assert.equal(back.activeId, a.source.id);
  assert.equal(back.proxies[0].name, "a1");
  const listed = publicSources(b.sources, b.source.id);
  assert.deepEqual(listed.map((item) => [item.name, item.nodeCount, item.active]), [["A", 1, false], ["B", 1, true]]);
  // 列表不携带节点快照，避免把整份订阅塞进接口响应。
  assert.equal(listed[0].proxies, undefined);
});

test("重命名、删除与序列化", () => {
  const a = upsertSource([], { name: "A", mode: "manual", proxies: [node("a1")], proxyServerDns: ["9.9.9.9"] });
  const b = upsertSource(a.sources, { name: "B", mode: "manual", proxies: [node("b1")] });
  const renamed = renameSource(b.sources, b.source.id, "  B 二号  ");
  assert.equal(renamed.source.name, "B 二号");
  assert.throws(() => renameSource(b.sources, b.source.id, "   "), /不能为空/);
  assert.throws(() => renameSource(b.sources, "src_nope", "x"), /找不到/);
  assert.throws(() => removeSource(b.sources, "src_nope"), /找不到/);

  const removed = removeSource(b.sources, b.source.id);
  assert.equal(removed.sources.length, 1);
  const store = serializeStore({ sources: removed.sources, activeId: a.source.id });
  assert.equal(store.version, 2);
  assert.equal(store.activeId, a.source.id);
  assert.equal(store.proxies[0].name, "a1");
  assert.equal(store.selected, "a1");
  assert.deepEqual(store.proxyServerDns, ["9.9.9.9"]);
  assert.equal(store.sources.length, 1);
});

test("空供应商列表序列化成空快照而不是崩溃", () => {
  const store = serializeStore({ sources: [], activeId: null });
  assert.deepEqual(store.proxies, []);
  assert.equal(store.activeId, null);
  assert.equal(store.source, null);
});
