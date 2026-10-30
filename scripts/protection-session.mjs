import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One durable baseline per activation. Re-adaptation must never replace it.
export class ProtectionSession {
  constructor({ stateDir, snapshot, apply, restore, detect, test, intervalMs = 60000, canTest = () => true }) {
    Object.assign(this, { snapshot, apply, restore, detect, test, intervalMs, canTest });
    this.file = path.join(stateDir, 'protection-session.json');
    this.preferenceFile = path.join(stateDir, 'protection-preference.json');
    this.desiredEnabled = false;
    this.intentVersion = 0;
    this.state = { phase: 'idle', enabled: false, target: null, issues: [], history: [], lastTestAt: null, nextTestAt: null, runId: null, score: null, alarm: false, monitoring: true };
    this.pending = null;
    this.queue = Promise.resolve();
    this.timer = null;
    this.testing = false;
  }
  report() { return structuredClone({ ...this.state, desiredEnabled: this.desiredEnabled, intervalMs: this.intervalMs, testing: this.testing }); }
  async savePreference(enabled) {
    await mkdir(path.dirname(this.preferenceFile), { recursive: true });
    await writeFile(this.preferenceFile + '.tmp', JSON.stringify({ enabled }), { mode: 0o600 });
    await rename(this.preferenceFile + '.tmp', this.preferenceFile);
    this.desiredEnabled = enabled;
  }
  event(message) {
    this.state.history.unshift({ at: new Date().toISOString(), message });
    this.state.history = this.state.history.slice(0, 30);
  }
  async persist() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(this.pending), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  serialize(operation) {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async recover() {
    try { this.desiredEnabled = JSON.parse(await readFile(this.preferenceFile, 'utf8')).enabled === true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { this.pending = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this.report(); throw error; }
    if (this.pending) { this.event('检测到未恢复的配置，正在自动恢复'); await this.stop({ shutdown: true }); }
    return this.report();
  }
  start(origin) {
    return this.serialize(() => this.activate(origin));
  }
  async activate(origin) {
    if (this.state.enabled && this.state.phase !== 'restart_required') return this.report();
    if (this.pending && this.state.phase !== 'restart_required') throw new Error('尚有配置未恢复，请先关闭模拟保护以重试恢复。');
    this.state.phase = 'starting'; this.state.issues = [];
    try {
      const target = await this.detect();
      if (!target?.ip || !target.language || !target.locale) throw new Error('无法识别当前出口 IP，未应用任何配置。');
      if (!this.pending) {
        this.pending = { origin, baseline: await this.snapshot(), savedAt: new Date().toISOString() };
        await this.persist();
      }
      this.state.target = target;
      this.state.issues = await this.apply(target, origin);
      await this.savePreference(true);
      this.state.enabled = true;
      this.state.runId = null; this.state.score = null; this.state.alarm = false; this.state.testError = null; this.state.testState = 'pending';
      this.state.phase = this.state.issues.length ? 'partial' : 'active';
      this.event('模拟保护已启动，已按当前出口应用适配配置');
      this.schedule();
      return this.report();
    } catch (error) {
      this.state.issues.push(error.message);
      if (this.pending) await this.restorePending();
      else this.state.phase = 'idle';
      throw error;
    }
  }
  resume(origin) {
    const version = this.intentVersion;
    return this.serialize(async () => {
      // A queued wake event must never undo an explicit stop.
      if (version !== this.intentVersion || !this.desiredEnabled || this.state.phase === 'restore_failed') return this.report();
      const wasEnabled = this.state.enabled;
      if (!wasEnabled) await this.activate(origin);
      try {
        const target = wasEnabled ? await this.detect() : this.state.target;
        if (!target?.ip || !target.language || !target.locale) throw new Error('网络尚未恢复，等待重新连接。');
        this.state.phase = 'starting';
        this.state.runId = null; this.state.score = null; this.state.alarm = false;
        this.state.testState = 'pending'; this.state.testError = null;
        if (wasEnabled) this.state.issues = await this.apply(target, origin);
        this.state.target = target;
        this.state.phase = this.state.issues.length ? 'partial' : 'active';
        await this.performTest(target);
        if (this.state.testState === 'passed') this.event('连接已恢复，已重新适配并检测当前环境');
      } catch (error) {
        this.state.phase = 'partial'; this.state.runId = null; this.state.score = null; this.state.alarm = false;
        this.state.testState = 'failed'; this.state.testError = error.message;
        this.event('自动重连暂未完成：' + error.message);
      }
      this.schedule();
      return this.report();
    });
  }
  schedule() {
    clearInterval(this.timer); this.timer = null;
    if (!this.state.enabled || !this.state.monitoring || this.state.phase === 'restart_required') { this.state.nextTestAt = null; return; }
    this.state.nextTestAt = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      if (!this.state.enabled || this.testing || !this.canTest()) return;
      void this.serialize(async () => {
        if (this.state.enabled && this.canTest()) await this.performTest();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  async performTest(detectedTarget) {
    if (this.testing || !this.state.enabled || this.state.phase === 'restart_required') return;
    this.testing = true;
    this.state.nextTestAt = this.state.monitoring ? new Date(Date.now() + this.intervalMs).toISOString() : null;
    try {
      const target = detectedTarget ?? await this.detect();
      if (!target?.ip || !target.language) throw new Error('出口识别失败，旧检测结果已过期。');
      // Compare only the fields that affect protection, not fluctuating geo labels.
      const fields = ['ip', 'countryCode', 'language', 'locale', 'timezone', 'windowsTimezone'];
      if (fields.some(key => target[key] !== this.state.target?.[key])) {
        this.state.phase = 'restart_required';
        this.state.runId = null; this.state.score = null; this.state.alarm = false;
        this.state.testState = 'stale';
        this.state.testError = '检测到出口节点变化，旧检测结果已过期。请点击“重新启动保护”，按最新出口 IP 生成配置。';
        this.event(this.state.testError);
        this.schedule();
        return;
      }
      const result = await this.test();
      this.state.runId = result.runId ?? randomUUID();
      this.state.lastTestAt = new Date().toISOString();
      this.state.testState = result.state;
      this.state.testError = result.state === 'passed' ? null : result.error || '模拟测试未通过，请查看测试项目。';
      this.state.phase = this.state.issues.length || result.state !== 'passed' ? 'partial' : 'active';
      this.event(result.state === 'passed' ? '本轮模拟测试已通过，等待环境采样' : '本轮模拟测试未通过');
    } catch (error) {
      this.state.runId = randomUUID(); this.state.lastTestAt = new Date().toISOString();
      this.state.testState = 'failed'; this.state.testError = error.message; this.state.phase = 'partial';
      this.event('检测异常：' + error.message);
    } finally { this.testing = false; }
  }
  observe({ runId, score }) {
    if (!this.state.enabled || this.testing || runId !== this.state.runId || this.state.testState !== 'passed') return this.report();
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error('无效异常分。');
    const previous = this.state.alarm;
    this.state.score = score; this.state.alarm = score !== null && score > 50;
    if (previous !== this.state.alarm) this.event(this.state.alarm ? `异常分 ${score}，超过 50 分报警阈值` : '异常分已恢复至报警阈值以内');
    return this.report();
  }
  retest() {
    return this.serialize(async () => {
      if (!this.state.enabled) throw new Error('请先启动保护，再重新运行保护测试。');
      await this.performTest();
      return this.report();
    });
  }
  monitor(enabled, intervalMs = this.intervalMs) {
    if (typeof enabled !== 'boolean') throw new Error('无效的监测开关。');
    if (!Number.isInteger(intervalMs) || intervalMs < 30000 || intervalMs > 600000) throw new Error('检测间隔须为30秒至10分钟。');
    this.intervalMs = intervalMs;
    this.state.monitoring = enabled; this.schedule(); return this.report();
  }
  async restorePending(options = {}) {
    this.state.phase = 'stopping'; this.state.enabled = false; this.state.nextTestAt = null;
    this.state.runId = null; this.state.testError = null; this.state.testState = 'pending';
    clearInterval(this.timer); this.timer = null;
    if (!this.pending) { this.state.phase = 'idle'; return; }
    try {
      const issues = await this.restore(this.pending.baseline, this.pending.origin, options);
      if (issues.length) throw new Error(issues.join('；'));
      await rm(this.file, { force: true }); this.pending = null;
      this.state.phase = 'idle'; this.state.issues = []; this.state.alarm = false; this.state.score = null;
      this.event('模拟保护已关闭，本次改动已自动恢复');
    } catch (error) {
      this.state.phase = 'restore_failed'; this.state.issues = [error.message];
      this.event('自动恢复未完成：' + error.message);
    }
  }
  stop(options = {}) {
    this.intentVersion++;
    if (!options.shutdown) this.desiredEnabled = false;
    clearInterval(this.timer); this.timer = null; this.state.nextTestAt = null;
    return this.serialize(async () => {
      if (!options.shutdown) await this.savePreference(false);
      await this.restorePending(options); return this.report();
    });
  }
}
