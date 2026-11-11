// fail-closed 守卫的纯函数与生命周期测试。
// 重点不是「命令能跑」，而是：规则可预期、幂等、回读为准、失败必须暴露。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_GUARD_GROUP_PREFIX, claudeGuardSpecs, claudeGuardArmScript, claudeGuardReleaseScript,
  createClaudeGuard, discoverClaudeTargets, guardGroupName, hostsBlockText, hostsBlocked, mergeClaudeGuardTargets, stripHostsBlock,
} from "../scripts/net-core/claude-guard.mjs";

const token = "testtoken01";

test("令牌非法或缺少阻断目标时必须拒绝", () => {
  assert.throws(() => claudeGuardSpecs({ token: "sh!rt", programs: ["C:/Claude.exe"] }), /令牌无效/);
  assert.throws(() => claudeGuardSpecs({ token }), /缺少阻断目标/);
});

test("每个选择器生成 TCP+UDP 的 443 规则，且归属同一分组", () => {
  const specs = claudeGuardSpecs({ token, programs: ["C:/Claude.exe"], packages: ["Anthropic.Claude_1.0_x64__abc"] });
  assert.equal(specs.length, 4);
  assert.ok(specs.every(spec => spec.group === guardGroupName(token)));
  assert.ok(specs.every(spec => spec.port === 443));
  assert.deepEqual([...new Set(specs.map(spec => spec.protocol))].sort(), ["TCP", "UDP"]);
});

test("目标地址只接受 IP，非法值被丢弃；全部非法时按缺少目标处理", () => {
  const specs = claudeGuardSpecs({ token, addresses: ["160.79.104.10", "2600:1f18::1", "anthropic.com", ""] });
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0].addresses, ["160.79.104.10", "2600:1f18::1"]);
  assert.throws(() => claudeGuardSpecs({ token, addresses: ["anthropic.com"] }), /缺少阻断目标/);
});

test("布防脚本先删同组旧规则再重建（幂等），并回读规则数", () => {
  const specs = claudeGuardSpecs({ token, programs: ["C:/Claude.exe"] });
  const script = claudeGuardArmScript(specs);
  const removeAt = script.indexOf("Remove-NetFirewallRule");
  const firstNew = script.indexOf("New-NetFirewallRule");
  assert.ok(removeAt >= 0 && removeAt < firstNew, "必须先清理旧组再创建");
  assert.match(script, /-Direction Outbound/);
  assert.match(script, /-Action Block/);
  assert.match(script, /Get-NetFirewallRule -Group/);
  assert.match(script, /ConvertTo-Json/);
});

test("撤防脚本按分组删除并回读剩余数量", () => {
  const script = claudeGuardReleaseScript(guardGroupName(token));
  assert.match(script, /Remove-NetFirewallRule -Group 'EnvGuardCC-Claude-Guard-testtoken01'/);
  assert.match(script, /Get-NetFirewallRule/);
});

test("arm 以回读数量为准：规则数不足时报错，不能当作已布防", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  let mode = "partial";
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes("New-NetFirewallRule")) {
      return { stdout: JSON.stringify({ count: mode === "partial" ? 1 : 2 }) };
    }
    return { stdout: JSON.stringify({ count: 0 }) };
  };
  const guard = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: null, logger: () => {} });
  await assert.rejects(guard.arm({ token, programs: ["C:/Claude.exe"] }), /未全部生效/);
  mode = "full";
  const armed = await guard.arm({ token, programs: ["C:/Claude.exe"] });
  assert.equal(armed.armed, true);
  assert.equal(armed.count, 2);
});

test("release 回读仍有残留时必须报错", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes("New-NetFirewallRule")) return { stdout: JSON.stringify({ count: 2 }) };
    if (script.includes("Remove-NetFirewallRule")) return { stdout: JSON.stringify({ count: 2 }) };
    return { stdout: JSON.stringify({ count: 2 }) };
  };
  const guard = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: null, logger: () => {} });
  await guard.arm({ token, programs: ["C:/Claude.exe"] });
  await assert.rejects(guard.release(), /未删除/);
});

test("宿主重启后按落盘的 desired 收敛：期望布防但规则丢了会自动重建", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  let present = 0;
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes("New-NetFirewallRule")) { present = 2; return { stdout: JSON.stringify({ count: present }) }; }
    if (script.includes("Remove-NetFirewallRule")) { present = 0; return { stdout: JSON.stringify({ count: 0 }) }; }
    return { stdout: JSON.stringify({ count: present }) };
  };
  const first = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: null });
  await first.arm({ token, programs: ["C:/Claude.exe"] });
  present = 0; // 模拟规则被外部清除
  const restarted = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: null });
  const result = await restarted.reconcile();
  assert.equal(result.armed, true);
  assert.equal(present, 2);
});

test("非 Windows 平台明确不支持，不假装已布防", async () => {
  const guard = createClaudeGuard({ platform: "linux", stateDir: null, hostsPath: null });
  assert.equal(guard.supported, false);
  assert.deepEqual(await guard.status(), { supported: false, armed: false, desired: "released", count: 0, hostsBlocked: false, error: null });
  await assert.rejects(guard.arm({ token, programs: ["/usr/bin/claude"] }), /没有实现系统级 fail-closed/);
});

test("分组名带固定前缀，便于卸载与恢复工具按组清理", () => {
  assert.ok(guardGroupName(token).startsWith(CLAUDE_GUARD_GROUP_PREFIX));
});

test("发现目标：Store 版取包族名，Claude Code CLI 取原生安装路径", async () => {
  const targets = await discoverClaudeTargets({
    platform: "win32",
    home: "C:/Users/x",
    exec: async () => ({ stdout: JSON.stringify({ package: "Anthropic.Claude_1.0_x64__abc", exe: "C:/Program Files/WindowsApps/Claude/app/Claude.exe" }) }),
    exists: async () => {},
  });
  assert.deepEqual(targets.packages, ["Anthropic.Claude_1.0_x64__abc"]);
  assert.equal(targets.programs.length, 2);
  assert.equal(targets.programs[0], "C:/Program Files/WindowsApps/Claude/app/Claude.exe");
  assert.match(targets.programs[1], /[\\/]\.local[\\/]bin[\\/]claude\.exe$/);
});

test("发现目标：未安装时返回空，不抛错（不能让布防因探测失败而静默）", async () => {
  const targets = await discoverClaudeTargets({
    platform: "win32",
    exec: async () => { throw new Error("no appx"); },
    exists: async () => { throw new Error("ENOENT"); },
  });
  assert.deepEqual(targets, { packages: [], programs: [] });
});

test("发现目标：非 Windows 返回空，不冒充支持", async () => {
  assert.deepEqual(await discoverClaudeTargets({ platform: "darwin" }), { packages: [], programs: [] });
});

test("自定义目标合并：去重、过滤空值，文件不存在时用默认值", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-targets-"));
  const base = { packages: ["pkgA"], programs: ["C:/Claude.exe"], addresses: [] };
  assert.deepEqual(await mergeClaudeGuardTargets(base, { stateDir }), base);
  await writeFile(path.join(stateDir, "claude-guard-targets.json"), JSON.stringify({
    packages: ["pkgA", "pkgB"], programs: ["C:/Claude.exe", "  "], addresses: ["203.0.113.9"],
  }));
  const merged = await mergeClaudeGuardTargets(base, { stateDir });
  assert.deepEqual(merged.packages, ["pkgA", "pkgB"]);
  assert.deepEqual(merged.programs, ["C:/Claude.exe"]);
  assert.deepEqual(merged.addresses, ["203.0.113.9"]);
});

test("自定义目标文件损坏时必须报错，不能静默忽略用户配置", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-targets-"));
  await writeFile(path.join(stateDir, "claude-guard-targets.json"), "{broken");
  await assert.rejects(mergeClaudeGuardTargets({ packages: [], programs: [] }, { stateDir }), /无法读取/);
});

test("hosts 段覆盖默认 Anthropic 域名，且不含共享的人机验证通道", () => {
  const text = hostsBlockText();
  for (const domain of ["anthropic.com", "api.anthropic.com", "claude.ai", "claudeusercontent.com"]) {
    assert.match(text, new RegExp(`0\.0\.0\.0 ${domain.replaceAll(".", "\.")}`));
    assert.match(text, new RegExp(`::1 ${domain.replaceAll(".", "\.")}`));
  }
  assert.doesNotMatch(text, /challenges\.cloudflare\.com/, "Cloudflare 共享验证通道不能进默认集合");
  assert.throws(() => hostsBlockText([]), /域名集合为空/);
});

test("hosts 段可重复清理，且不动用户自己的行", () => {
  const original = "127.0.0.1 localhost\r\n10.0.0.5 intranet\r\n";
  const once = original + hostsBlockText(["claude.ai"], "t1");
  assert.equal(hostsBlocked(once), true);
  const cleaned = stripHostsBlock(once);
  assert.equal(hostsBlocked(cleaned), false);
  assert.match(cleaned, /10\.0\.0\.5 intranet/);
  assert.doesNotMatch(cleaned, /claude\.ai/);
  assert.equal(stripHostsBlock(cleaned), cleaned, "重复清理必须幂等");
});

test("布防同时写防火墙规则与 hosts；撤防两者都清干净", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  const hostsFile = path.join(stateDir, "hosts");
  const fs = await import("node:fs/promises");
  await fs.writeFile(hostsFile, "127.0.0.1 localhost\r\n");
  let present = 0;
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes("New-NetFirewallRule")) { present = 4; return { stdout: JSON.stringify({ count: present }) }; }
    if (script.includes("Remove-NetFirewallRule")) { present = 0; return { stdout: JSON.stringify({ count: 0 }) }; }
    return { stdout: JSON.stringify({ count: present }) };
  };
  const guard = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: hostsFile });
  const armed = await guard.arm({ token, programs: ["C:/Claude.exe"], domains: ["claude.ai"] });
  assert.equal(armed.armed, true);
  assert.equal(armed.hostsBlocked, true);
  assert.match(await fs.readFile(hostsFile, "utf8"), /0\.0\.0\.0 claude\.ai/);
  const released = await guard.release();
  assert.equal(released.armed, false);
  const after = await fs.readFile(hostsFile, "utf8");
  assert.doesNotMatch(after, /claude\.ai/);
  assert.match(after, /127\.0\.0\.1 localhost/);
});

test("只有域名也能布防：浏览器入口不依赖进程规则", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  const hostsFile = path.join(stateDir, "hosts");
  const fs = await import("node:fs/promises");
  await fs.writeFile(hostsFile, "");
  const exec = async () => { throw new Error("不应创建防火墙规则"); };
  const guard = createClaudeGuard({ platform: "win32", stateDir, exec, hostsPath: hostsFile });
  const armed = await guard.arm({ token, domains: ["claude.ai"] });
  assert.equal(armed.armed, true);
  assert.equal(armed.count, 0);
  assert.match(await fs.readFile(hostsFile, "utf8"), /claude\.ai/);
});

test("hosts 写不进去时必须报错，不能只布一半还报成功", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-guard-"));
  const exec = async () => ({ stdout: JSON.stringify({ count: 2 }) });
  const guard = createClaudeGuard({
    platform: "win32", stateDir, exec,
    hostsPath: path.join(stateDir, "hosts"),
    readText: async () => "",
    writeText: async () => { throw new Error("EPERM"); },
  });
  await assert.rejects(guard.arm({ token, programs: ["C:/Claude.exe"], domains: ["claude.ai"] }), /hosts：EPERM/);
});
