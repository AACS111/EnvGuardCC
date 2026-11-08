import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildKernelConfig, strictKernelConfig, assertStrictKernelConfig } from "./net-core/config.mjs";
import { createFirewallGuard, firewallEndpoints, firewallRules, assertPfAttachment, GUARD_ANCHOR } from "./net-core/firewall.mjs";

const config = () => strictKernelConfig(buildKernelConfig({ proxies: [
  { name: "node-a", type: "http", server: "node.example.com", port: 443 },
  { name: "node-b", type: "http", server: "203.0.113.2", port: 443 },
], selected: "node-a", secret: "test-controller-secret-".repeat(3), hosts: { "node.example.com": ["203.0.113.1"] }, egressMode: "rule" }));

test("严格配置不继承任何直连例外，只有固定节点可选", () => {
  const strict = config();
  assert.equal(strict.tun.device, "utun90");
  assert.deepEqual(strict.tun["route-exclude-address"], []);
  assert.deepEqual(strict["proxy-groups"][0].proxies, ["node-a"]);
  assert.equal(strict.rules.at(-1), "MATCH,CLAUDE-PIN");
  assert.ok(!JSON.stringify(strict.rules).includes("DIRECT"));
  strict.rules.splice(1, 0, "MATCH,DIRECT");
  assert.throws(() => assertStrictKernelConfig(strict), /直连/);
});

test("严格配置拒绝额外的本机入站，避免把固定出口暴露给任意本机进程", () => {
  const loose = buildKernelConfig({
    proxies: [{ name: "node-a", type: "http", server: "203.0.113.1", port: 443 }],
    selected: "node-a",
    secret: "test-controller-secret-".repeat(3),
    egressMode: "rule",
  });
  loose.listeners = [{ name: "extra", type: "http", port: 39081, listen: "127.0.0.1", proxy: "CLAUDE-PIN" }];
  assert.throws(() => strictKernelConfig(loose), /额外的本机入站/);
});

test("节点放行只接受已缓存的 IP 与端口，不插入域名或规则语法", () => {
  const candidate = config();
  assert.deepEqual(firewallEndpoints(candidate), [{ address: "203.0.113.1", port: 443 }]);
  delete candidate.hosts;
  assert.throws(() => firewallEndpoints(candidate), /缓存/);
  assert.throws(() => firewallRules([{ address: "203.0.113.1\npass all", port: 443 }]), /有效端口|IP/);
  assert.throws(() => firewallRules([{ address: "203.0.113.1", port: -1 }]), /有效端口/);
  const blocked = firewallRules([{ address: "203.0.113.1", port: 443 }]);
  assert.ok(!blocked.includes("on utun90"));
  assert.match(blocked, /user root keep state/);
  assert.match(blocked, /block drop quick all/);
});

test("拒绝会绕过阻断的主规则、前置子 anchor、NAT 与 skip 配置", () => {
  const main = 'anchor "com.apple/*" all\n';
  assert.doesNotThrow(() => assertPfAttachment(main, "000.envguardcc\n100.system", "", "en0\nlo0"));
  assert.doesNotThrow(() => assertPfAttachment('scrub-anchor "com.apple/*" all fragment reassemble\n' + main, "", "", "en0\nlo0"));
  assert.throws(() => assertPfAttachment("pass out quick all\n" + main, "", "", ""), /默认入口/);
  assert.throws(() => assertPfAttachment(main, "000.aaa", "", ""), /优先级/);
  assert.throws(() => assertPfAttachment(main, "", "rdr pass on en0 from any to any -> 127.0.0.1", ""), /转换/);
  assert.throws(() => assertPfAttachment(main, "", "", "en0 (skip)"), /跳过/);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "egcc-pf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rules = "", main = 'anchor "com.apple/*" all\n', route = "interface: utun90\n";
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === "/sbin/ifconfig") throw Object.assign(new Error("absent"), { code: 1, stderr: "interface utun90 does not exist" });
    if (command === "/sbin/route") return { stdout: route };
    if (args.join(" ") === "-sr") return { stdout: main };
    if (args.includes("Anchors")) return { stdout: "000.envguardcc\n100.system\n" };
    if (args.includes("Interfaces")) return { stdout: "en0\nlo0\nutun90\n" };
    if (args.includes("-sn")) return { stdout: "" };
    if (args.includes("-E")) return { stdout: "", stderr: "Token : 42\n" };
    if (args.includes("info")) return { stdout: "Status: Enabled\n" };
    if (args.includes("References")) return { stdout: "Token: 42\n" };
    if (args.includes("-F")) rules = "";
    if (args.includes("-f") && !args.includes("-n")) rules = await readFile(args.at(-1), "utf8");
    if (args.includes("-a") && args.includes("-sr")) return { stdout: rules };
    return { stdout: "", stderr: "" };
  };
  const options = { platform: "darwin", stateDir: path.join(root, "private"), isRoot: () => true, run };
  return { options, calls, rules: () => rules, main: value => { main = value; }, route: value => { route = value; } };
}

test("先阻断再验证网卡；宿主重启恢复阻断而非放行，恢复工具只解除本 anchor", { skip: process.platform === "win32" ? "PF 私有目录集成依赖 POSIX 权限" : false }, async t => {
  const f = await fixture(t);
  const first = createFirewallGuard(f.options);
  await first.arm(config());
  assert.equal(first.status().phase, "blocked");
  assert.ok(!f.rules().includes("on utun90"));
  assert.ok(f.calls.some(call => call.args.join(" ") === "-k ::/0"));
  await first.activate();
  assert.equal(first.status().phase, "active");
  assert.ok(f.rules().includes("on utun90"));
  const recovered = createFirewallGuard(f.options);
  await recovered.restore();
  assert.equal(recovered.status().phase, "blocked");
  assert.ok(!f.rules().includes("on utun90"));
  await recovered.inspect();
  f.main("custom unsupported root rules");
  await createFirewallGuard(f.options).release();
  await first.inspect();
  assert.equal(first.status().armed, false, "后台实例必须尊重独立恢复工具的解除意愿");
  await assert.rejects(first.arm(config(), { expectedReleaseId: null }), /独立恢复/);
  assert.equal(f.rules(), "", "旧会话恢复不能重新加载已解除的系统规则");
  assert.equal(f.rules(), "");
  assert.ok(f.calls.some(call => call.args.join(" ") === `-a ${GUARD_ANCHOR} -F rules`));
  assert.ok(f.calls.some(call => call.args.join(" ") === "-X 42"));
  assert.ok(!f.calls.some(call => call.args.includes("-d") || call.args.includes("/etc/pf.conf") || call.args.join(" ") === "-F all"));
});

test("网卡不归属 EGCC 时保持阻断，未知平台不降级启用", { skip: process.platform === "win32" ? "PF 私有目录集成依赖 POSIX 权限" : false }, async t => {
  const f = await fixture(t);
  const guard = createFirewallGuard(f.options);
  await guard.arm(config());
  f.route("interface: en0\n");
  await assert.rejects(guard.activate(), /专属网卡/);
  assert.equal(guard.status().phase, "blocked");
  assert.ok(!f.rules().includes("on utun90"));
  await assert.rejects(createFirewallGuard({ ...f.options, platform: "win32" }).arm(config()), /尚不支持/);
});

test("macOS PF 解析器接受阻断和隧道放行规则（仅 -n，不加载规则）", async t => {
  if (process.platform !== "darwin") { t.skip("PF 语法检查仅适用于 macOS"); return; }
  const directory = await mkdtemp(path.join(tmpdir(), "egcc-pf-syntax-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const active of [false, true]) {
    const file = path.join(directory, "rules.pf");
    await writeFile(file, firewallRules([{ address: "203.0.113.1", port: 443 }], { active }));
    await promisify(execFile)("/sbin/pfctl", ["-n", "-a", GUARD_ANCHOR, "-f", file]);
  }
});

test("专属网卡已被其他程序占用时，不安装任何系统规则", { skip: process.platform === "win32" ? "PF 私有目录集成依赖 POSIX 权限" : false }, async t => {
  const f = await fixture(t);
  const originalRun = f.options.run;
  const guard = createFirewallGuard({ ...f.options, run: (command, args) => command === "/sbin/ifconfig" ? Promise.resolve({ stdout: "utun90: occupied" }) : originalRun(command, args) });
  await assert.rejects(guard.arm(config()), /已被占用/);
  assert.ok(!f.calls.some(call => call.args.includes("-f") || call.args.includes("-E")));
  assert.equal(guard.status().armed, false);
});
