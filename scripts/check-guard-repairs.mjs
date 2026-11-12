import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { FIREWALL_RULE_CHECK } from './net-core/firewall-rule-check.mjs';
import { cleanupClaudeGuard, uninstallHost } from './net-core/cleanup-claude-guard.mjs';
import { hostsBlockText } from './net-core/claude-guard.mjs';

test('原生 PowerShell 校验过滤条件，地址规范化后等价才通过；不修改系统规则', { skip: process.platform !== 'win32' }, () => {
  const fixture = String.raw`
$ErrorActionPreference = 'Stop'
function Get-NetFirewallApplicationFilter { process { [pscustomobject]@{ Program = 'C:\Claude.exe'; Package = $null } } }
function Get-NetFirewallAddressFilter { process { [pscustomobject]@{ RemoteAddress = $script:remote; LocalAddress = 'Any' } } }
function Get-NetFirewallPortFilter { process { [pscustomobject]@{ Protocol = '256'; RemotePort = 'Any'; LocalPort = 'Any' } } }
function Get-NetFirewallServiceFilter { process { [pscustomobject]@{ Service = 'Any' } } }
function Get-NetFirewallInterfaceTypeFilter { process { [pscustomobject]@{ InterfaceType = 'Any' } } }
function Get-NetFirewallInterfaceFilter { process { [pscustomobject]@{ InterfaceAlias = 'Any' } } }
$rule = [pscustomobject]@{ Enabled = 'True'; Action = 'Block'; Direction = 'Outbound'; Profile = 'Any' }
$script:remote = @('0:0:0:0:0:0:0:0','128.0.0.0/1')
if (!(Test-GuardRule $rule 'C:/Claude.exe' 'Any' 'Any' 'Any' @('::/128','128.0.0.0-255.255.255.255'))) { throw 'valid rule rejected' }
$script:remote = @('1.1.1.1')
if (Test-GuardRule $rule 'C:/Claude.exe' 'Any' 'Any' 'Any' @('::/128')) { throw 'wrong address accepted' }
$script:remote = @('::')
if (Test-GuardRule $rule 'C:/different.exe' 'Any' 'Any' 'Any' @('::/128')) { throw 'wrong program accepted' }
if (Test-GuardRule $rule 'C:/Claude.exe' 'Any' 'TCP' '443' @('::/128')) { throw 'wrong protocol accepted' }
$rule.Direction = 'Inbound'
if (Test-GuardRule $rule 'C:/Claude.exe' 'Any' 'Any' 'Any' @('::/128')) { throw 'wrong direction accepted' }
'verified'
`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_RULE_CHECK + fixture], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.match(result, /verified/);
});

test('卸载在停止宿主后清理，清理失败不删除任务，允许重试', async () => {
  const events = [];
  const plan = { uninstallCommands: [{ cmd: 'stop', args: [] }, { cmd: 'delete', args: [] }] };
  const run = async cmd => { events.push(cmd); };
  await assert.rejects(uninstallHost(plan, { platform: 'win32', run, cleanup: async () => { events.push('cleanup'); throw new Error('permission'); } }), /permission/);
  assert.deepEqual(events, ['stop', 'cleanup']);
  events.length = 0;
  await uninstallHost(plan, { platform: 'win32', run, cleanup: async () => { events.push('cleanup'); } });
  assert.deepEqual(events, ['stop', 'cleanup', 'delete']);
});

test('卸载清理孤立规则与 hosts，删除旧意图；错误不能冒充成功', async () => {
  let content = '127.0.0.1 localhost\r\n' + hostsBlockText();
  let removed = false;
  const options = { stateDir: 'state', hostsPath: 'hosts', run: async (_, args) => {
    assert.match(args.at(-1), /Group -like 'EnvGuardCC-Claude-Guard-\*'/);
    return { stdout: '{"count":0}' };
  }, read: async () => content, write: async (_, text) => { content = text; }, remove: async () => { removed = true; } };
  await cleanupClaudeGuard(options);
  assert.equal(content, '127.0.0.1 localhost\r\n'); assert.equal(removed, true);
  removed = false;
  await assert.rejects(cleanupClaudeGuard({ ...options, run: async () => ({ stdout: '{"count":1}' }) }), /未完成/);
  assert.equal(removed, false);
});
