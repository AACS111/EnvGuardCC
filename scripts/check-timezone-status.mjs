import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTimezoneStatusReader } from './timezone-status.mjs';

test('slow status reads never block polling; concurrent polls share one read', async () => {
  let release, reads = 0, clock = 0;
  const status = createTimezoneStatusReader(() => { reads++; return new Promise(resolve => { release = resolve; }); }, { now: () => clock });
  assert.equal(status().systemTimezonePending, true);
  await setImmediate();
  for (let i = 0; i < 20; i++) assert.equal(status().systemTimezone, null);
  assert.equal(reads, 1);
  release('Korea Standard Time');
  await setImmediate();
  assert.equal(status().systemTimezone, 'Korea Standard Time');
  clock = 9999;
  status();
  assert.equal(reads, 1);
  clock = 10000;
  assert.equal(status().systemTimezonePending, true);
  await setImmediate();
  assert.equal(reads, 2);
  release('UTC');
  await setImmediate();
  assert.equal(status().systemTimezone, 'UTC');
});

test('failed reads clear stale timezones, report diagnostics, and retry automatically', async () => {
  let clock = 0, failure = false;
  const logs = [];
  const status = createTimezoneStatusReader(async () => { if (failure) throw new Error('timezone unavailable'); return 'UTC'; }, { now: () => clock, logger: (...args) => logs.push(args) });
  status(); await setImmediate();
  assert.equal(status().systemTimezone, 'UTC');
  clock = 10000; failure = true;
  status(); await setImmediate();
  assert.equal(status().systemTimezone, null);
  assert.equal(status().systemTimezoneError, 'timezone unavailable');
  assert.equal(logs.length, 1);
  clock = 20000; failure = false;
  status(); await setImmediate();
  assert.equal(status().systemTimezone, 'UTC');
  assert.equal(status().systemTimezoneError, null);
});

test('a configuration change invalidates cached and in-flight timezone results', async () => {
  let release;
  const status = createTimezoneStatusReader(() => new Promise(resolve => { release = resolve; }));
  status(); await setImmediate();
  status.invalidate();
  release('old timezone'); await setImmediate();
  assert.equal(status().systemTimezone, null);
  await setImmediate();
  release('new timezone'); await setImmediate();
  assert.equal(status().systemTimezone, 'new timezone');
});

test('HTTP request handler survives timezone and unexpected report failures', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'checkcc-status-api-'));
  const oldState = process.env.CHECKCC_STATE_DIR;
  process.env.CHECKCC_STATE_DIR = stateDir;
  let unexpected = false;
  const { startRepairHelper } = await import('./local-repair.mjs');
  const helper = await startRepairHelper(0, {
    readTimezone: async () => { throw new Error('injected timezone failure'); },
    netCore: { connectionState: () => { if (unexpected) throw new Error('injected report failure'); return null; } },
  });
  t.after(async () => {
    await helper.closeRuntime();
    helper.server.closeAllConnections();
    await new Promise(resolve => helper.server.close(resolve));
    if (oldState === undefined) delete process.env.CHECKCC_STATE_DIR; else process.env.CHECKCC_STATE_DIR = oldState;
    await rm(stateDir, { recursive: true, force: true });
  });
  // Dispatch through the actual HTTP server listener without relying on local
  // socket access (some Windows test sandboxes deny loopback connections).
  const get = (url = '/protection') => new Promise(resolve => {
    const req = { method: 'GET', url, headers: { host: new URL(helper.url).host, origin: 'http://localhost:3000', 'x-checkcc-client': 'repair-ui' }, socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      status: 200, writableEnded: false,
      setHeader() {},
      writeHead(status) { this.status = status; },
      end(body) { this.writableEnded = true; resolve({ status: this.status, json: async () => JSON.parse(body) }); },
    };
    helper.server.emit('request', req, res);
  });
  assert.equal((await get()).status, 200);
  await setImmediate();
  const report = await (await get()).json();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(report.systemTimezone, null);
    assert.match(report.systemTimezoneError, /injected timezone failure/);
  }
  unexpected = true;
  const failed = await get();
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /injected report failure/);
  unexpected = false;
  assert.equal((await get()).status, 200);
  assert.equal((await get('/session?tokenOnly=1')).status, 200);
});
