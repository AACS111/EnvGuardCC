// fail-closed 守卫的纯函数与生命周期测试。
// 重点不是「命令能跑」，而是：规则可预期、幂等、回读为准、失败必须暴露。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from 'node:child_process';
import {
  CLAUDE_GUARD_GROUP_PREFIX, claudeGuardSpecs, claudeGuardArmScript, claudeGuardReleaseScript,
  createClaudeGuard, discoverClaudeTargets, guardGroupName, hostsBlockText, hostsBlocked, mergeClaudeGuardTargets, stripHostsBlock,
  CLAUDE_GUARD_DOMAINS, CLAUDE_DIRECT_BLOCK_ADDRESSES, claudeDirectSpecs, PACKAGE_SID_SCRIPT, enableFirewallScript,
} from "../scripts/net-core/claude-guard.mjs";

const token = "testtoken01";

test('常驻桌面规则覆盖全部端口和 IPv6，IPv4 仅放行 loopback 与配置的 fake-IP', () => {
  const specs = claudeDirectSpecs({ token, programs: ['C:/Claude.exe'], packages: ['Claude_family'] });
  assert.equal(specs.length, 2);
  assert.ok(specs.every(spec => spec.port === 'Any' && spec.protocol === 'Any' && spec.group.endsWith('-Direct')));
  const address = ip => ip.split('.').reduce((value, part) => value * 256 + Number(part), 0);
  const blocked = ip => CLAUDE_DIRECT_BLOCK_ADDRESSES.filter(range => range.includes('.')).some(range => {
    const [start, end] = range.split('-').map(address);
    return address(ip) >= start && address(ip) <= end;
  });
  for (const ip of ['1.1.1.1', '192.168.1.1', '198.17.255.255', '198.19.0.0', '255.255.255.255']) assert.ok(blocked(ip), ip);
  for (const ip of ['127.0.0.1', '127.255.255.255', '198.18.0.0', '198.18.255.255']) assert.equal(blocked(ip), false, ip);
  assert.ok(CLAUDE_DIRECT_BLOCK_ADDRESSES.includes('::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'));
  assert.match(claudeGuardArmScript(specs), /-Package \(\[EnvGuardPackageSid\]::Resolve/);
});

test('Windows 原生 API 将包族名转换为 WFP 需要的 SID；仅调用转换，不改防火墙', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PACKAGE_SID_SCRIPT + "\n[EnvGuardPackageSid]::Resolve('Claude_testfamily')"], { windowsHide: true, timeout: 20000, encoding: 'utf8' }).trim();
  assert.match(output, /^S-1-15-2-(?:\d+-){6}\d+$/);
});

test('允许隧道后仍保留常驻规则，宿主重启恢复规则，明确停止才全部删除', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'egcc-direct-guard-'));
  const groups = new Map();
  const exec = async (_file, args) => {
    const script = args.at(-1);
    const group = script.match(/-Group '([^']+)'/)[1];
    if (script.includes('New-NetFirewallRule')) groups.set(group, (script.match(/New-NetFirewallRule -PolicyStore/g) ?? []).length);
    else if (script.includes('Remove-NetFirewallRule')) groups.delete(group);
    return { stdout: JSON.stringify({ count: groups.get(group) ?? 0 }) };
  };
  const options = { platform: 'win32', stateDir, hostsPath: null, exec };
  const guard = createClaudeGuard(options);
  await guard.arm({ token, programs: ['C:/Claude.exe'] });
  await guard.release({ keepDirect: true });
  assert.equal(groups.has(guardGroupName(token)), false);
  assert.equal(groups.get(`${guardGroupName(token)}-Direct`), 1);
  assert.equal(guard.snapshot().desired, 'protected');
  const restarted = createClaudeGuard(options);
  groups.clear();
  await restarted.reconcile();
  assert.equal(groups.get(`${guardGroupName(token)}-Direct`), 1);
  await restarted.arm({ token: 'differenttoken', programs: ['C:/Claude.exe'] });
  assert.ok(groups.has(guardGroupName(token)), '重开应用复用原 token');
  await restarted.release();
  assert.equal(groups.size, 0);
});

test('目标合并保留默认域名，不能把 hosts 防护字段丢掉', async () => {
  const merged = await mergeClaudeGuardTargets({ packages: [], programs: [], domains: CLAUDE_GUARD_DOMAINS });
  assert.deepEqual(merged.domains, CLAUDE_GUARD_DOMAINS);
});

test('防火墙回读缺失 count 时拒绝把未知当作零条规则', async () => {
  const guard = createClaudeGuard({ platform: 'win32', hostsPath: null, exec: async () => ({ stdout: '{}' }) });
  await assert.rejects(guard.arm({ token, programs: ['C:/Claude.exe'] }), /有效规则数量/);
  assert.equal(guard.snapshot().armed, null);
});

test('防火墙关闭时布防报错，不会自动开启；只有明确确认才能执行开启命令', async () => {
  const calls = [];
  const guard = createClaudeGuard({ platform: 'win32', hostsPath: null, exec: async (_file, args) => {
    const script = args.at(-1); calls.push(script);
    if (script.includes('Set-NetFirewallProfile')) return { stdout: '{"count":3}' };
    throw Object.assign(new Error('PowerShell failed'), { stderr: '[FIREWALL_DISABLED] disabled' });
  } });
  await assert.rejects(guard.arm({ token, programs: ['C:/Claude.exe'] }), /Windows 防火墙未开启/);
  assert.equal(calls.some(script => script.includes('Set-NetFirewallProfile') || script.includes('Start-Service')), false);
  await assert.rejects(guard.enableFirewall(false), /明确确认/);
  await assert.rejects(guard.enableFirewall(undefined), /明确确认/);
  assert.equal(calls.length, 1);
  assert.deepEqual(await guard.enableFirewall(true), { enabled: true });
  const script = enableFirewallScript(true);
  assert.match(script, /Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True/);
  assert.doesNotMatch(script, /-AllowLocalFirewallRules True|Set-Service/);
});

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

test("重复布防更新稳定 Name，不先删除已有阻断", () => {
  const specs = claudeGuardSpecs({ token, programs: ["C:/Claude.exe"] });
  const script = claudeGuardArmScript(specs);
  assert.doesNotMatch(script, /Remove-NetFirewallRule/);
  assert.match(script, /Set-NetFirewallRule/);
  assert.match(script, /PolicyStore PersistentStore/);
  assert.match(script, /PolicyStore ActiveStore/);
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
  assert.deepEqual(await guard.status(), { supported: false, armed: false, directProtected: false, desired: "released", count: 0, hostsBlocked: false, error: null });
  await assert.rejects(guard.arm({ token, programs: ["/usr/bin/claude"] }), /没有实现系统级 fail-closed/);
});

test("分组名带固定前缀，便于卸载与恢复工具按组清理", () => {
  assert.ok(guardGroupName(token).startsWith(CLAUDE_GUARD_GROUP_PREFIX));
});

test("发现目标：Store 版取包族名，Claude Code CLI 取原生安装路径", async () => {
  const targets = await discoverClaudeTargets({
    platform: "win32", list: async () => [],
    home: "C:/Users/x",
    exec: async () => ({ stdout: JSON.stringify({ package: "Anthropic.Claude_1.0_x64__abc", exe: "C:/Program Files/WindowsApps/Claude/app/Claude.exe" }) }),
    exists: async file => { if (!file.endsWith('claude.exe')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(targets.packages, ["Anthropic.Claude_1.0_x64__abc"]);
  assert.equal(targets.programs.length, 2);
  assert.equal(targets.programs[0], "C:/Program Files/WindowsApps/Claude/app/Claude.exe");
  assert.match(targets.programs[1], /[\\/]\.local[\\/]bin[\\/]claude\.exe$/);
});

test("发现目标：明确未安装时返回空；与探测失败区分", async () => {
  const targets = await discoverClaudeTargets({
    platform: "win32", list: async () => [],
    exec: async () => ({ stdout: '[]' }),
    exists: async () => { throw Object.assign(new Error("ENOENT"), { code: 'ENOENT' }); },
  });
  assert.deepEqual(targets, { packages: [], programs: [] });
});

test('安装探测超时、权限错误或损坏 JSON 不得降级为空目标', async () => {
  for (const exec of [async () => { throw new Error('timeout'); }, async () => ({ stdout: '{}' }), async () => ({ stdout: 'bad json' })]) {
    await assert.rejects(discoverClaudeTargets({ platform: 'win32', exec }), /无法识别 Claude/);
  }
});

test('防护发现覆盖自定义桌面路径及多个 Store 版本，使用系统 PowerShell', async () => {
  const targets = await discoverClaudeTargets({ platform: 'win32', list: async () => [], env: { CHECKCC_DESKTOP_PATH: 'C:/custom/Claude.exe' }, exec: async (file, args) => {
    assert.match(file, /powershell\.exe$/i); assert.doesNotMatch(file, /pwsh/i);
    assert.match(args.at(-1), /ErrorActionPreference = 'Stop'/);
    return { stdout: JSON.stringify([{ package: 'one', exe: 'C:/one.exe' }, { package: 'two', exe: 'C:/two.exe' }]) };
  }, exists: async file => { if (file !== 'C:/custom/Claude.exe') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.deepEqual(targets.packages, ['one', 'two']);
  assert.deepEqual(targets.programs, ['C:/one.exe', 'C:/two.exe', 'C:/custom/Claude.exe']);
});

test('普通桌面版本目录全部受保护，较新版本优先供启动器选择', async () => {
  const targets = await discoverClaudeTargets({ platform: 'win32', env: { LOCALAPPDATA: 'C:/local' },
    exec: async () => ({ stdout: '[]' }),
    list: async () => ['app-1.9', 'app-1.10', 'logs'].map(name => ({ name, isDirectory: () => true })),
    exists: async file => { if (!file.includes('app-')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(targets.programs.length, 2);
  assert.match(targets.programs[0], /app-1\.10/);
  assert.match(targets.programs[1], /app-1\.9/);
});

test("发现目标：非 Windows 返回空，不冒充支持", async () => {
  assert.deepEqual(await discoverClaudeTargets({ platform: "darwin" }), { packages: [], programs: [] });
});

test("自定义目标合并：去重、过滤空值，文件不存在时用默认值", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "checkcc-claude-targets-"));
  const base = { packages: ["pkgA"], programs: ["C:/Claude.exe"], addresses: [] };
  assert.deepEqual(await mergeClaudeGuardTargets(base, { stateDir }), { ...base, domains: CLAUDE_GUARD_DOMAINS });
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
