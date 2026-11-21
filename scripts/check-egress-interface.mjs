// 出口网卡探测：系统里残留指向已断开网卡的默认路由时，不能把这张网卡交给内核。
// 只用注入的假命令输出，不依赖真实系统状态与 PowerShell。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEgressInterfaceAsync, createEgressInterfaceResolver } from './net-core/egress-interface.mjs';

const windowsExec = (rows) => (file, args) => {
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  return { stdout: JSON.stringify(rows) };
};

test('Windows：跳过已断开的默认路由网卡，选下一张 Up 的物理网卡', async () => {
  const exec = windowsExec([
    { name: '以太网', metric: 5, status: 'Disconnected', link: 'Disconnected' },
    { name: 'WLAN', metric: 45, status: 'Up', link: 'Connected' },
  ]);
  assert.deepEqual(await detectEgressInterfaceAsync({ platform: 'win32', exec }), { name: 'WLAN', metric: 45 });
});

test('Windows：全部网卡断开或只剩虚拟网卡时返回 null（保持内核自动探测）', async () => {
  const offline = windowsExec([
    { name: '以太网', metric: 5, status: 'Disconnected', link: 'Disconnected' },
  ]);
  assert.equal(await detectEgressInterfaceAsync({ platform: 'win32', exec: offline }), null);

  const virtualOnly = windowsExec([
    { name: 'Meta Tunnel', metric: 0, status: 'Up', link: 'Connected' },
    { name: 'cfw-tap', metric: 10, status: 'Up', link: 'Connected' },
  ]);
  assert.equal(await detectEgressInterfaceAsync({ platform: 'win32', exec: virtualOnly }), null);
});

test('Windows：PowerShell 失败或返回脏数据时安全降级为 null', async () => {
  assert.equal(await detectEgressInterfaceAsync({ platform: 'win32', exec: async () => { throw new Error('powershell 不可用'); } }), null);
  assert.equal(await detectEgressInterfaceAsync({ platform: 'win32', exec: () => ({ stdout: 'not json' }) }), null);
  assert.equal(await detectEgressInterfaceAsync({ platform: 'win32', exec: windowsExec([]) }), null);
});

test('macOS：status 为 active 才采用默认路由接口', async () => {
  const exec = (file, args) => {
    if (file === 'route') return { stdout: '   route to: default\ninterface: en0\n' };
    if (file === 'ifconfig') {
      assert.deepEqual(args, ['en0']);
      return { stdout: 'en0: flags=8863<UP>\n\tstatus: active\n' };
    }
    throw new Error(`unexpected ${file}`);
  };
  assert.deepEqual(await detectEgressInterfaceAsync({ platform: 'darwin', exec }), { name: 'en0', metric: null });
});

test('macOS：默认路由接口是 TUN 或链路 inactive 时返回 null', async () => {
  const tun = file => ({ stdout: file === 'route' ? 'interface: utun90\n' : 'status: active\n' });
  assert.equal(await detectEgressInterfaceAsync({ platform: 'darwin', exec: tun }), null);

  const down = file => ({ stdout: file === 'route' ? 'interface: en0\n' : 'status: inactive\n' });
  assert.equal(await detectEgressInterfaceAsync({ platform: 'darwin', exec: down }), null);
});

test('Linux：按 metric 挑第一张 operstate=up 的默认路由网卡', async () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    'wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  ].join('\n');
  const read = (file) => {
    if (file === '/proc/net/route') return table;
    if (file === '/sys/class/net/eth0/operstate') return 'down';
    if (file === '/sys/class/net/wlan0/operstate') return 'up';
    throw new Error(`unexpected ${file}`);
  };
  assert.deepEqual(await detectEgressInterfaceAsync({ platform: 'linux', read }), { name: 'wlan0', metric: 600 });
});

test('网络变化立即使出口网卡的缓存失效', async () => {
  let now = 1000;
  let calls = 0;
  const resolver = createEgressInterfaceResolver({
    ttlMs: 30_000,
    now: () => now,
    detectAsync: async () => { calls += 1; return { name: calls === 1 ? 'WLAN' : '以太网 2' }; },
  });
  assert.equal((await resolver.warm()).name, 'WLAN');
  now += 10_000;
  assert.equal((await resolver.warm()).name, 'WLAN');
  assert.equal(calls, 1);
  resolver.invalidate();
  assert.equal(resolver.peek(), null);
  assert.equal((await resolver.warm()).name, '以太网 2');
  assert.equal(calls, 2);
});

test('peek 不触发系统探测；warm 异步填充缓存且并发合并', async () => {
  let now = 1000;
  let detected = 0;
  let release = () => {};
  const resolver = createEgressInterfaceResolver({
    ttlMs: 30_000,
    now: () => now,
    detectAsync: async () => { detected += 1; await new Promise(resolve => { release = resolve; }); return { name: 'WLAN', metric: 45 }; },
  });

  // 冷缓存：peek 立即返回 null，不发起探测。
  assert.equal(resolver.peek(), null);
  assert.equal(detected, 0);

  // 并发 warm 合并成一次探测。
  const first = resolver.warm();
  const second = resolver.warm();
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { name: 'WLAN', metric: 45 });
  assert.equal(detected, 1);
  assert.deepEqual(resolver.peek(), { name: 'WLAN', metric: 45 });

  // 缓存过期后 warm 会重新探测。
  now += 31_000;
  assert.equal(resolver.peek(), null);
  const third = resolver.warm();
  release();
  await third;
  assert.equal(detected, 2);
});
