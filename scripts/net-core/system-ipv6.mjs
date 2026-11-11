// 节点不支持 IPv6 时关闭系统 IPv6，避免绕过 IPv4 隧道。
// 保护开启时关闭当前活动网络服务的 IPv6，停止/退出时恢复到之前的设置。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsSystemExecutable } from '../windows-timezone.mjs';

const run = promisify(execFile);
const NETWORKSETUP = "/usr/sbin/networksetup";
const ROUTE = "/sbin/route";

const windowsOptions = { windowsHide: true, timeout: 30000 };
const powershell = windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe');
const windowsArgs = script => ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`];

const jsonScript = body => `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${body}`;

/** 列出「IPv6 仍启用」的网卡，并标记它是否正在承载流量（Status = Up）。 */
const LIST_SCRIPT = jsonScript("ConvertTo-Json -Compress -InputObject @(Get-NetAdapterBinding -ComponentID ms_tcpip6 | Where-Object Enabled | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Up = ((Get-NetAdapter -Name $_.Name -ErrorAction SilentlyContinue).Status -eq 'Up') } })");

/**
 * 逐块切换 IPv6 绑定并回读校验，结果用 JSON 返回。
 * 逐块而不是一条命令关全部：虚拟网卡（TAP-Windows、SoftEther SVN Adapter、Hyper-V vEthernet）
 * 经常拒绝修改绑定，一条命令会因此整体失败，表现成「开了保护就连不上」。
 */
function switchScript(names, enabled) {
  const verb = enabled ? 'Enable-NetAdapterBinding' : 'Disable-NetAdapterBinding';
  const list = names.map(name => `'${name.replaceAll("'", "''")}'`).join(',');
  return jsonScript(`
$result = @()
foreach ($name in @(${list})) {
  $up = (Get-NetAdapter -Name $name -ErrorAction SilentlyContinue).Status -eq 'Up'
  $ok = $false
  $errorText = $null
  try {
    ${verb} -Name $name -ComponentID ms_tcpip6 -Confirm:$false -ErrorAction Stop
    if ((Get-NetAdapterBinding -Name $name -ComponentID ms_tcpip6 -ErrorAction Stop).Enabled -ne $${enabled}) { $errorText = '绑定状态未变成预期值' }
    else { $ok = $true }
  } catch { $errorText = $_.Exception.Message }
  $result += [pscustomobject]@{ name = $name; up = $up; ok = $ok; error = $errorText }
}
ConvertTo-Json -Compress -InputObject @($result)`);
}

function rowsOf(stdout) {
  const parsed = JSON.parse(String(stdout ?? '').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listWindowsAdapters(exec) {
  const { stdout } = await exec(powershell, windowsArgs(LIST_SCRIPT), windowsOptions);
  const rows = rowsOf(stdout);
  if (rows.some(item => typeof item?.Name !== 'string' || !item.Name)) throw new Error('无法读取 Windows IPv6 网卡状态。');
  return rows.map(item => ({ name: item.Name, up: item.Up === true }));
}

async function switchWindowsAdapters(adapters, enabled, exec) {
  if (!adapters.length) return [];
  const { stdout } = await exec(powershell, windowsArgs(switchScript(adapters, enabled)), windowsOptions);
  return rowsOf(stdout).map(row => ({ name: String(row?.name ?? ''), up: row?.up === true, ok: row?.ok === true, error: row?.error ?? null }));
}

const describe = rows => rows.map(row => `${row.name}（${row.error || '未知原因'}）`).join('；');

/**
 * 虚拟网卡即使 Status=Up 也不承载公网流量：Hyper-V/WSL 的 vEthernet、TAP、Docker 等。
 * 它们拒绝修改 IPv6 绑定时不能判定为「正在使用的网卡关不掉」，否则装了 WSL 的机器
 * 每次网络波动都会卡在重试数分钟，期间系统 IPv6 保持开启、Claude 会绕过 IPv4 隧道（实测事故）。
 */
const VIRTUAL_ADAPTER = /(?:^|[\s(])(?:vEthernet|Hyper-?V|WSL|Default Switch|Loopback|TAP|TUN|WireGuard|VMware|VirtualBox|vboxnet|Docker|Npcap|Bluetooth)/i;
const internetCarrier = row => row.up === true && !VIRTUAL_ADAPTER.test(String(row.name ?? ''));

async function disableWindowsIpv6(exec) {
  const adapters = await listWindowsAdapters(exec);
  if (!adapters.length) return { platform: 'win32', changed: false, previous: 'Off', adapters: [] };
  // 没有任何网卡在承载流量（全部拔出/停用，或只剩虚拟网卡）：没有可泄漏的 IPv6，也不算失败。
  if (!adapters.some(internetCarrier)) {
    return {
      platform: 'win32', changed: false, previous: 'Enabled', adapters: [], idle: true,
      skipped: adapters.map(item => ({ name: item.name, up: item.up, error: '非公网网卡，未修改' })),
    };
  }
  const rows = await switchWindowsAdapters(adapters.map(item => item.name), false, exec);
  const disabled = rows.filter(row => row.ok).map(row => row.name);
  const failed = rows.filter(row => !row.ok);
  // 只有「正在承载公网流量」的网卡关不掉才算保护失败；虚拟网卡一律按跳过记录。
  const active = failed.filter(internetCarrier);
  const state = {
    platform: 'win32', previous: 'Enabled', adapters: disabled, changed: disabled.length > 0,
    // 非活动/虚拟网卡（拔出、未连接、WSL vEthernet）拒绝修改不影响保护：它们不承载公网流量。
    skipped: failed.map(row => ({ name: row.name, up: row.up, error: row.error ?? null, virtual: !internetCarrier(row) })),
  };
  if (!active.length) return state;
  // 正在使用的网卡没关掉：必须回滚，不能留下「部分关、部分开」的半成品状态。
  let rollbackError = null;
  if (disabled.length) {
    try { await switchWindowsAdapters(disabled, true, exec); }
    catch (error) { rollbackError = error.message; state.rollbackFailed = true; }
  }
  const error = new Error(`无法关闭这些正在使用的网卡的 IPv6：${describe(active)}`);
  // 回滚失败时把原记录带上，调用方可据 adapters 重新尝试恢复。
  if (rollbackError) error.ipv6State = state;
  throw error;
}

export function parseDefaultInterface(output) {
  return String(output ?? "").match(/interface:\s*(\S+)/)?.[1] ?? null;
}

export function parseServiceOrder(output) {
  const services = [];
  for (const block of String(output ?? "").split(/\n\s*\n/)) {
    const name = block.match(/^\(\d+\)\s+(.+?)\s*$/m)?.[1];
    const device = block.match(/Device:\s*([^\s)]+)/)?.[1];
    if (name && device) services.push({ name, device });
  }
  return services;
}

export function parseIpv6Setting(output) {
  return String(output ?? "").match(/^IPv6:\s*(.+?)\s*$/m)?.[1] ?? null;
}

/** 默认路由所在网卡对应的网络服务名（macOS 可能同时有 Wi-Fi/USB 网卡）。 */
export async function activeService({ exec = run } = {}) {
  const route = await exec(ROUTE, ["-n", "get", "default"]);
  const iface = parseDefaultInterface(route?.stdout ?? route);
  if (!iface) return null;
  const order = await exec(NETWORKSETUP, ["-listnetworkserviceorder"]);
  return parseServiceOrder(order?.stdout ?? order).find((service) => service.device === iface) ?? null;
}

/**
 * 关闭活动服务的 IPv6；返回用于恢复的状态。
 * 已经是 Off 时 changed=false，调用方不要误恢复成 Automatic。
 */
export async function disableSystemIpv6({ platform = process.platform, exec = run } = {}) {
  if (platform === 'win32') return disableWindowsIpv6(exec);
  if (platform !== "darwin") return { changed: false, reason: "当前平台不支持自动关闭 IPv6。" };
  const service = await activeService({ exec });
  if (!service) return { changed: false, reason: "未找到默认路由对应的网络服务。" };
  const info = await exec(NETWORKSETUP, ["-getinfo", service.name]);
  const previous = parseIpv6Setting(info?.stdout ?? info) ?? "Automatic";
  if (/^off$/i.test(previous)) return { changed: false, service: service.name, previous };
  await exec(NETWORKSETUP, ["-setv6off", service.name]);
  return { changed: true, service: service.name, previous };
}

/** 把 IPv6 恢复成关闭前的设置；Manual 无法只靠 service 名恢复，返回 false 让调用方记录。 */
export async function restoreSystemIpv6(state, { exec = run, platform = process.platform } = {}) {
  if (platform === 'win32') {
    if (!state?.changed || state.platform !== 'win32' || !state.adapters?.length) return false;
    const rows = await switchWindowsAdapters(state.adapters, true, exec);
    const failed = rows.filter(row => !row.ok);
    if (failed.length) throw new Error(`恢复这些网卡的 IPv6 失败：${describe(failed)}`);
    return true;
  }
  if (platform !== "darwin") return false;
  if (!state?.changed || !state.service) return false;
  const command = /^automatic$/i.test(state.previous)
    ? "-setv6automatic"
    : /^link[- ]?local/i.test(state.previous)
      ? "-setv6linklocal"
      : /^off$/i.test(state.previous)
        ? "-setv6off"
        : null;
  if (!command) return false;
  await exec(NETWORKSETUP, [command, state.service]);
  return true;
}
