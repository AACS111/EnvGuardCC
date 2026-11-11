// 特权助手「一次性授权」：旧宿主必须判定为过旧并触发应用内授权安装，
// 不能静默降级成非提权的本机命令（Windows 会报 System Error 5，用户看不懂）。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHostHealth, hostInstallDecision, HOST_CAPABILITIES, HOST_PROTOCOL } from "./net-core/host-protocol.mjs";
import { HOST_BUNDLE_FILES, stageHostBundle } from "./net-core/host-bundle.mjs";
import { createKernelRuntime } from "./net-core/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startFakeHost(payload) {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") return response.end(JSON.stringify(payload));
    response.statusCode = 400;
    response.end(JSON.stringify({ error: "未知动作。" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function createRuntime(port) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-host-upgrade-"));
  await writeFile(path.join(stateDir, "host-token"), "token-token-token-token\n");
  const logs = [];
  const runtime = await createKernelRuntime({
    stateDir,
    root,
    env: { CHECKCC_NET_CORE: "0", CHECKCC_NET_CORE_HOST_PORT: String(port) },
    logger: (message) => logs.push(message),
  });
  return { runtime, logs, cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}

test("健康检查：认不出版本字段的宿主一律算过旧", () => {
  const legacy = checkHostHealth({ ok: true, running: false, apiPort: 39090, requiresAdmin: true });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.protocol, 0);
  assert.deepEqual(legacy.missing, HOST_CAPABILITIES);

  assert.equal(checkHostHealth({ hostProtocol: 1, capabilities: [...HOST_CAPABILITIES] }).ok, false);
  const partial = checkHostHealth({ hostProtocol: HOST_PROTOCOL, capabilities: [] });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, HOST_CAPABILITIES);

  const current = checkHostHealth({ hostProtocol: HOST_PROTOCOL, capabilities: [...HOST_CAPABILITIES] });
  assert.equal(current.ok, true);
  assert.equal(current.required, HOST_PROTOCOL);
});

test("授权决策：只在缺权限且没有可用宿主时弹一次系统授权", () => {
  const base = { hostMode: false, platform: "win32", elevated: false };
  assert.equal(hostInstallDecision(base).action, "install");
  assert.equal(hostInstallDecision({ ...base, hostMode: true }).action, "none");
  assert.equal(hostInstallDecision({ ...base, elevated: true }).action, "none");
  assert.equal(hostInstallDecision({ ...base, platform: "linux" }).action, "none");
  assert.equal(hostInstallDecision({ ...base, disabled: true }).action, "none");
  assert.equal(hostInstallDecision({ ...base, failure: "上次装完仍不可用" }).action, "fail");
});

test("旧宿主在线时按本机模式运行，并留下过旧标记", async () => {
  const host = await startFakeHost({ ok: true, running: false, apiPort: 39090, requiresAdmin: true });
  const { runtime, logs, cleanup } = await createRuntime(host.port);
  try {
    const report = await runtime.report();
    assert.equal(report.hostMode, false);
    assert.ok(report.hostStale, "旧宿主必须被标记为过旧");
    assert.equal(report.hostStale.protocol, 0);
    assert.equal(report.hostStale.required, HOST_PROTOCOL);
    assert.deepEqual(report.hostStale.missing, HOST_CAPABILITIES);
    assert.ok(logs.some((line) => /版本过旧/.test(line)), "要写一条宿主过旧的日志");
  } finally {
    await cleanup();
    await host.close();
  }
});

test("新宿主被正常识别，不带过旧标记", async () => {
  const host = await startFakeHost({ ok: true, running: false, requiresAdmin: true, hostProtocol: HOST_PROTOCOL, capabilities: [...HOST_CAPABILITIES] });
  const { runtime, cleanup } = await createRuntime(host.port);
  try {
    const report = await runtime.report();
    assert.equal(report.hostMode, true);
    assert.equal(report.hostStale, null);
    assert.equal(report.hostProtocol, HOST_PROTOCOL);
  } finally {
    await cleanup();
    await host.close();
  }
});

test("宿主运行包自包含：被 import 的脚本必须在打包清单里", async () => {
  const staged = new Set(HOST_BUNDLE_FILES);
  const missing = [];
  for (const relative of HOST_BUNDLE_FILES) {
    const source = await readFile(path.join(root, relative), "utf8");
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.relative(root, path.resolve(root, path.dirname(relative), match[1])).split(path.sep).join("/");
      if (!staged.has(target) && !missing.includes(`${relative} → ${target}`)) missing.push(`${relative} → ${target}`);
    }
  }
  assert.deepEqual(missing, [], "打包清单缺少被 import 的脚本，装好的宿主会起不来");
});

test("Windows 宿主文件显式授权，目录继承权限单独设置", async t => {
  // macOS exposes /var and /tmp through symlinks; this fixture needs a real
  // directory so the production symlink rejection remains exercised faithfully.
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "checkcc-host-acl-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "executable");
  await writeFile(executable, "fixture");
  const calls = [];
  await stageHostBundle({
    nodePath: executable,
    hostScript: path.join(root, "scripts/net-core/host.mjs"),
    binary: executable,
    destination: path.join(directory, "installed"),
    platform: "win32",
    run: async (command, args) => { calls.push({ command, args }); },
  });
  const grants = calls.filter(call => call.args.includes("/grant:r"));
  const recursive = grants.filter(call => call.args.includes("/T"));
  assert.equal(recursive.length, 2, "安装根目录与暂存运行包都要保护");
  for (const { args } of recursive) {
    assert.ok(args.includes("*S-1-5-18:F"), "SYSTEM 必须获得文件的显式访问权限");
    assert.ok(args.includes("*S-1-5-32-544:F"), "Administrators 必须获得文件的显式访问权限");
    assert.ok(!args.some(arg => arg.includes("(OI)")), "文件授权不能使用目录继承标志");
    const inherited = calls.find(call => call.args[0] === args[0] && call.args.includes("/grant"));
    assert.ok(inherited?.args.includes("*S-1-5-18:(OI)(CI)F"));
    assert.ok(inherited?.args.includes("*S-1-5-32-544:(OI)(CI)F"));
    assert.ok(inherited?.args.includes("/T"), "子目录也要为后续创建的文件提供继承权限");
  }
});
