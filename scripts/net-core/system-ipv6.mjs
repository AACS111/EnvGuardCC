// macOS 系统 IPv6 开关：TUN 只接管 IPv4，系统 IPv6 会绕过隧道。
// 保护开启时关闭当前活动网络服务的 IPv6，停止/退出时恢复到之前的设置。
// 只做 macOS；Windows 由宿主/系统策略处理（暂不在本模块内）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const NETWORKSETUP = "/usr/sbin/networksetup";
const ROUTE = "/sbin/route";

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
  if (platform !== "darwin") return { changed: false, reason: "仅 macOS 支持自动关闭 IPv6。" };
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
