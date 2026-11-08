// macOS 系统 IPv6 开关的纯函数测试：不执行 networksetup，不修改本机网络。
import test from "node:test";
import assert from "node:assert/strict";
import { parseDefaultInterface, parseServiceOrder, parseIpv6Setting, activeService, disableSystemIpv6, restoreSystemIpv6 } from "./net-core/system-ipv6.mjs";

const ROUTE_OUT = "   route to: default\ndestination: default\n       gateway: 192.168.0.1\n  interface: en0\n";
const ORDER_OUT = `An asterisk (*) denotes that a network service is disabled.
(1) AX88179A
(Hardware Port: AX88179A, Device: en5)

(2) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)

(3) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
`;

test("解析默认网卡与网络服务", async () => {
  assert.equal(parseDefaultInterface(ROUTE_OUT), "en0");
  assert.equal(parseIpv6Setting("IPv6: Automatic\n"), "Automatic");
  assert.deepEqual(parseServiceOrder(ORDER_OUT), [
    { name: "AX88179A", device: "en5" },
    { name: "Wi-Fi", device: "en0" },
    { name: "Thunderbolt Bridge", device: "bridge0" },
  ]);
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith("route")) return { stdout: ROUTE_OUT };
    if (args[0] === "-listnetworkserviceorder") return { stdout: ORDER_OUT };
    throw new Error("unexpected");
  };
  assert.deepEqual(await activeService({ exec }), { name: "Wi-Fi", device: "en0" });
});

test("IPv6 为 Automatic 时关闭并记录原值", async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith("route")) return { stdout: ROUTE_OUT };
    if (args[0] === "-listnetworkserviceorder") return { stdout: ORDER_OUT };
    if (args[0] === "-getinfo") return { stdout: "DHCP Configuration\nIP address: 192.168.0.143\nIPv6: Automatic\n" };
    if (args[0] === "-setv6off") return { stdout: "" };
    throw new Error("unexpected");
  };
  const state = await disableSystemIpv6({ platform: "darwin", exec });
  assert.deepEqual(state, { changed: true, service: "Wi-Fi", previous: "Automatic" });
  assert.ok(calls.some(([file, flag, service]) => file.endsWith("networksetup") && flag === "-setv6off" && service === "Wi-Fi"));
});

test("已经是 Off 时不重复关闭，也不会误恢复成 Automatic", async () => {
  const exec = async (file, args) => {
    if (file.endsWith("route")) return { stdout: ROUTE_OUT };
    if (args[0] === "-listnetworkserviceorder") return { stdout: ORDER_OUT };
    if (args[0] === "-getinfo") return { stdout: "IPv6: Off\n" };
    throw new Error("unexpected");
  };
  const state = await disableSystemIpv6({ platform: "darwin", exec });
  assert.equal(state.changed, false);
  assert.equal(await restoreSystemIpv6(state, { exec }), false);
});

test("恢复 Automatic / Off / Link-Local，未知 Manual 不猜", async () => {
  const calls = [];
  const exec = async (file, args) => { calls.push([file, ...args]); return { stdout: "" }; };
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Automatic" }, { exec }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Off" }, { exec }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Link-Local Only" }, { exec }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Manually" }, { exec }), false);
  assert.deepEqual(calls.map(([, flag]) => flag), ["-setv6automatic", "-setv6off", "-setv6linklocal"]);
});

test("非 macOS 不执行任何系统命令", async () => {
  const exec = async () => { throw new Error("should not run"); };
  assert.equal((await disableSystemIpv6({ platform: "win32", exec })).changed, false);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Automatic" }, { exec: async () => { throw new Error("should not run"); }, platform: "win32" }), false);
});
