import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchProtectionConnection } from '../src/detection/protection-connection.mjs';
import { watchDesktopPower } from './desktop-power.mjs';

function timers() {
  const timeouts = new Map(), intervals = new Map();
  let id = 0;
  return {
    timeouts, intervals,
    later: fn => { timeouts.set(++id, fn); return id; }, cancel: id => timeouts.delete(id),
    every: fn => { intervals.set(++id, fn); return id; }, stop: id => intervals.delete(id),
    flush: () => { const tasks = [...timeouts.values()]; timeouts.clear(); for (const fn of tasks) fn(); },
  };
}

test('唤醒、解锁通知、网络和页面恢复合并为一次重连，销毁后取消监听', () => {
  const target = new EventTarget(), page = new EventTarget(), clock = timers();
  let wakes = 0;
  page.visibilityState = 'hidden';
  const close = watchProtectionConnection(() => wakes++, { target, page, ...clock });
  page.dispatchEvent(new Event('visibilitychange')); assert.equal(clock.timeouts.size, 0);
  for (const name of ['online', 'focus', 'pageshow', 'checkcc:resume']) target.dispatchEvent(new Event(name));
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(clock.timeouts.size, 1); clock.flush(); assert.equal(wakes, 1);
  target.dispatchEvent(new Event('checkcc:resume')); close(); clock.flush();
  target.dispatchEvent(new Event('online'));
  assert.equal(wakes, 1); assert.equal(clock.intervals.size, 0); assert.equal(clock.timeouts.size, 0);
});

test('浏览器睡眠期间错过事件，计时器恢复后仍触发重连', () => {
  const target = new EventTarget(), page = new EventTarget(), clock = timers();
  let now = 0, wakes = 0;
  const close = watchProtectionConnection(() => wakes++, { target, page, now: () => now, ...clock });
  const tick = [...clock.intervals.values()][0];
  now = 5000; tick(); clock.flush(); assert.equal(wakes, 0);
  now = 65000; tick(); clock.flush(); assert.equal(wakes, 1);
  close();
});

test('仅在用户开启保护时防止空闲睡眠，断线不释放，关闭或退出后释放', async () => {
  const monitor = new EventEmitter(), clock = timers();
  let enabled = false, desiredEnabled = false, offline = false, notifications = 0;
  const starts = [], stops = [];
  const close = watchDesktopPower({ powerMonitor: monitor, ...clock,
    powerSaveBlocker: { start: type => { starts.push(type); return 7; }, stop: id => stops.push(id) },
    readReport: async () => { if (offline) throw new Error('offline'); return { enabled, desiredEnabled }; },
    notify: () => notifications++,
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const tick = [...clock.intervals.values()][0];
  await flush(); assert.equal(starts.length, 0);
  desiredEnabled = true; tick(); await flush();
  assert.deepEqual(starts, ['prevent-app-suspension']);
  enabled = true; tick(); await flush(); assert.equal(starts.length, 1);
  offline = true; monitor.emit('resume'); monitor.emit('unlock-screen'); await flush();
  assert.equal(notifications, 2); assert.equal(stops.length, 0);
  offline = false; enabled = false; desiredEnabled = false; tick(); await flush();
  assert.deepEqual(stops, [7]);
  enabled = true; tick(); await flush(); close();
  assert.deepEqual(stops, [7, 7]); assert.equal(clock.intervals.size, 0);
  monitor.emit('resume'); assert.equal(notifications, 2);
});

test('退出时不允许仍在等待的状态请求重新建立防睡眠锁', async () => {
  let resolveReport, starts = 0;
  const close = watchDesktopPower({ powerMonitor: new EventEmitter(), ...timers(),
    powerSaveBlocker: { start: () => starts++, stop: () => {} }, notify: () => {},
    readReport: () => new Promise(resolve => { resolveReport = resolve; }),
  });
  close(); resolveReport({ enabled: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 0);
});
