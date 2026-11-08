// 供应商持久化：导入 → 保存 → 切换 → 重命名 → 删除 → 重新加载。
// 用 CHECKCC_NET_CORE=0 关掉内核启动，只验证状态机与落盘，不碰真实网络。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelRuntime } from "./net-core/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = (name) => ({ name, type: "ss", server: `${name}.example.com`, port: 443, cipher: "aes-128-gcm", password: "p" });
const create = (stateDir) => createKernelRuntime({ stateDir, env: { CHECKCC_NET_CORE: "0" }, root, logger: () => {} });

test("多供应商：保存、切换、重命名、删除与重新加载", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "checkcc-sources-"));
  try {
    const runtime = await create(stateDir);
    await runtime.importNodes([node("a1"), node("a2")], {
      source: { mode: "url", url: "https://a.example.com/s.yaml" },
      sourceName: "A 机场",
    });
    await runtime.importNodes([node("b1")], {
      source: { mode: "url", url: "https://b.example.com/s.yaml" },
      sourceName: "B 机场",
    });

    let report = await runtime.report();
    assert.equal(report.sources.length, 2);
    assert.deepEqual(report.sources.map((item) => item.name), ["A 机场", "B 机场"]);
    assert.equal(report.sources.find((item) => item.active).name, "B 机场");
    assert.deepEqual(report.nodes, ["b1"]);

    const a = report.sources.find((item) => item.name === "A 机场");
    await runtime.activateSource(a.id);
    report = await runtime.report();
    assert.equal(report.sources.find((item) => item.active).name, "A 机场");
    assert.deepEqual(report.nodes, ["a1", "a2"]);

    await runtime.renameSource(a.id, "A 二号");
    report = await runtime.report();
    assert.equal(report.sources.find((item) => item.active).name, "A 二号");

    // 落盘格式：v2，active 快照写回顶层，供应商各自带节点。
    const saved = JSON.parse(await readFile(path.join(stateDir, "net-nodes.json"), "utf8"));
    assert.equal(saved.version, 2);
    assert.equal(saved.activeId, a.id);
    assert.equal(saved.proxies.length, 2);
    assert.equal(saved.sources.length, 2);

    // 重新加载：切换过的当前供应商与名字都要保留，旧文件不能覆盖新格式。
    const reloaded = await create(stateDir);
    const second = await reloaded.report();
    assert.equal(second.sources.find((item) => item.active).name, "A 二号");
    assert.deepEqual(second.nodes, ["a1", "a2"]);

    const b = second.sources.find((item) => item.name === "B 机场");
    await reloaded.deleteSource(b.id);
    const after = await reloaded.report();
    assert.equal(after.sources.length, 1);
    assert.equal(after.sources[0].name, "A 二号");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("删除当前供应商后自动切到下一条；删空后回到未配置", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "checkcc-sources-"));
  try {
    const runtime = await create(stateDir);
    await runtime.importNodes([node("a1")], { source: { mode: "url", url: "https://a.example.com/s.yaml" }, sourceName: "A" });
    await runtime.importNodes([node("b1")], { source: { mode: "url", url: "https://b.example.com/s.yaml" }, sourceName: "B" });
    let report = await runtime.report();
    const b = report.sources.find((item) => item.active);
    await runtime.deleteSource(b.id);
    report = await runtime.report();
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].name, "A");
    assert.equal(report.sources[0].active, true);
    assert.deepEqual(report.nodes, ["a1"]);

    await runtime.deleteSource(report.sources[0].id);
    report = await runtime.report();
    assert.deepEqual(report.sources, []);
    assert.equal(report.state, "disabled");
    assert.deepEqual(report.nodes, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("编辑订阅只改这一条，不新增重复供应商", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "checkcc-sources-"));
  try {
    const runtime = await create(stateDir);
    await runtime.importNodes([node("a1")], { source: { mode: "url", url: "https://a.example.com/s.yaml" }, sourceName: "A" });
    const before = (await runtime.report()).sources[0];
    await runtime.importNodes([node("a2"), node("a3")], {
      source: { mode: "url", url: "https://a.example.com/s.yaml" },
      sourceId: before.id,
    });
    const report = await runtime.report();
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].id, before.id);
    assert.equal(report.sources[0].name, "A");
    assert.equal(report.sources[0].nodeCount, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
