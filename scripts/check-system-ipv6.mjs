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
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Automatic" }, { exec, platform: 'darwin' }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Off" }, { exec, platform: 'darwin' }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Link-Local Only" }, { exec, platform: 'darwin' }), true);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Manually" }, { exec, platform: 'darwin' }), false);
  assert.deepEqual(calls.map(([, flag]) => flag), ["-setv6automatic", "-setv6off", "-setv6linklocal"]);
});

test("非支持平台不执行任何系统命令", async () => {
  const exec = async () => { throw new Error("should not run"); };
  assert.equal((await disableSystemIpv6({ platform: "linux", exec })).changed, false);
  assert.equal(await restoreSystemIpv6({ changed: true, service: "Wi-Fi", previous: "Automatic" }, { exec, platform: "linux" }), false);
});

test('Windows 仅关闭原本启用 IPv6 的网卡，恢复时使用原记录', async () => {
  const calls = [];
  const exec = async (_file, args) => {
    const script = args.at(-1); calls.push(script);
    if (script.includes('Where-Object Enabled')) return { stdout: '[{"Name":"Wi-Fi","Up":true},{"Name":"以太网","Up":true}]' };
    if (script.includes('Disable-NetAdapterBinding')) return { stdout: '[{"name":"Wi-Fi","up":true,"ok":true},{"name":"以太网","up":true,"ok":true}]' };
    if (script.includes('Enable-NetAdapterBinding')) return { stdout: '[{"name":"Wi-Fi","up":true,"ok":true},{"name":"以太网","up":true,"ok":true}]' };
    return { stdout: '' };
  };
  const state = await disableSystemIpv6({ platform: 'win32', exec });
  assert.equal(state.changed, true);
  assert.deepEqual(state.adapters, ['Wi-Fi', '以太网']);
  assert.ok(calls.some(script => script.includes('Disable-NetAdapterBinding')));
  assert.equal(await restoreSystemIpv6(state, { platform: 'win32', exec }), true);
  assert.ok(calls.at(-1).includes('Enable-NetAdapterBinding'));
});

test('Windows 未连接 / 虚拟网卡拒绝修改 IPv6 时不影响保护，只记录跳过项', async () => {
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes('Where-Object Enabled')) return { stdout: '[{"Name":"以太网","Up":true},{"Name":"cfw-tap","Up":false},{"Name":"vEthernet (WSL)","Up":false}]' };
    return { stdout: JSON.stringify([
      { name: '以太网', up: true, ok: true },
      { name: 'cfw-tap', up: false, ok: false, error: '拒绝访问' },
      { name: 'vEthernet (WSL)', up: false, ok: false, error: '不支持' },
    ]) };
  };
  const state = await disableSystemIpv6({ platform: 'win32', exec });
  // 只有真正关掉的网卡才进恢复列表：否则恢复时会擅自打开本来没动过的绑定。
  assert.deepEqual(state.adapters, ['以太网']);
  assert.equal(state.changed, true);
  assert.deepEqual(state.skipped.map(item => item.name), ['cfw-tap', 'vEthernet (WSL)']);
});

test('Windows 正在使用的网卡关不掉时回滚，回滚也失败则携带原记录供重试', async () => {
  for (const rollbackFails of [false, true]) {
    const calls = [];
    const exec = async (_file, args) => {
      const script = args.at(-1); calls.push(script);
      if (script.includes('Where-Object Enabled')) return { stdout: '[{"Name":"Wi-Fi","Up":true},{"Name":"以太网","Up":true}]' };
      if (script.includes('Disable-NetAdapterBinding')) return { stdout: '[{"name":"Wi-Fi","up":true,"ok":false,"error":"disable failed"},{"name":"以太网","up":true,"ok":true}]' };
      if (rollbackFails) throw new Error('restore failed');
      return { stdout: '[{"name":"以太网","up":true,"ok":true}]' };
    };
    await assert.rejects(disableSystemIpv6({ platform: 'win32', exec }), error => {
      assert.match(error.message, /disable failed/);
      assert.equal(Boolean(error.ipv6State), rollbackFails);
      if (rollbackFails) assert.deepEqual(error.ipv6State.adapters, ['以太网']);
      return true;
    });
    // 只回滚真正关掉的那块，不去动本来就关不掉的。
    assert.ok(calls.at(-1).includes('Enable-NetAdapterBinding'));
  }
});

test('Windows 恢复失败必须报错，不能静默当作已恢复', async () => {
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes('Enable-NetAdapterBinding')) return { stdout: '[{"name":"Wi-Fi","up":true,"ok":false,"error":"拒绝访问"}]' };
    throw new Error('must not run');
  };
  await assert.rejects(restoreSystemIpv6({ changed: true, platform: 'win32', adapters: ['Wi-Fi'] }, { platform: 'win32', exec }), /恢复这些网卡的 IPv6 失败/);
});

test('Windows 没有任何在用网卡时不报错，也不去改绑定', async () => {
  const calls = [];
  const exec = async (_file, args) => {
    const script = args.at(-1); calls.push(script);
    return { stdout: '[{"Name":"cfw-tap","Up":false},{"Name":"WLAN","Up":false}]' };
  };
  const state = await disableSystemIpv6({ platform: 'win32', exec });
  assert.equal(state.idle, true);
  assert.equal(state.changed, false);
  assert.deepEqual(state.adapters, []);
  assert.equal(calls.length, 1, '没有在用网卡时不应执行切换命令');
});

test('Windows 所有网卡已关闭 IPv6 时记录已关闭，恢复不擅自启用', async () => {
  const exec = async () => ({ stdout: '[]' });
  const state = await disableSystemIpv6({ platform: 'win32', exec });
  assert.equal(state.changed, false);
  assert.equal(state.previous, 'Off');
  assert.equal(await restoreSystemIpv6(state, { platform: 'win32', exec: async () => { throw new Error('must not run'); } }), false);
});

test('Windows 输出为单个对象（非数组）时也能解析', async () => {
  const exec = async (_file, args) => {
    const script = args.at(-1);
    if (script.includes('Where-Object Enabled')) return { stdout: ' {"Name":"Wi-Fi","Up":true} ' };
    return { stdout: '{"name":"Wi-Fi","up":true,"ok":true}' };
  };
  const state = await disableSystemIpv6({ platform: 'win32', exec });
  assert.deepEqual(state.adapters, ['Wi-Fi']);
});

