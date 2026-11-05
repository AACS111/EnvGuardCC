import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 出口漂移自动重适配的节流：窗口内次数超限才退回人工重启，避免节点反复抖动把时区/浏览器配置刷来刷去。
const AUTO_ADAPT_WINDOW_MS = 10 * 60 * 1000;
const AUTO_ADAPT_LIMIT = 5;

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
    this.testController = null;
    this.operationCount = 0;
    this.observedSamples = new Set();
    // 出口变化后的自动重适配：记住启动时的页面来源，并跟踪在途的 apply，避免与关闭/恢复交叉。
    this.origin = null;
    this.applying = null;
    this.autoAdapts = [];
  }
  report() { return structuredClone({ ...this.state, desiredEnabled: this.desiredEnabled, intervalMs: this.intervalMs, testing: this.testing }); }
  async savePreference(enabled, { monitoring = this.state.monitoring, intervalMs = this.intervalMs } = {}) {
    await mkdir(path.dirname(this.preferenceFile), { recursive: true });
    await writeFile(this.preferenceFile + '.tmp', JSON.stringify({ enabled, monitoring, intervalMs }), { mode: 0o600 });
    await rename(this.preferenceFile + '.tmp', this.preferenceFile);
    this.desiredEnabled = enabled;
    this.state.monitoring = monitoring;
    this.intervalMs = intervalMs;
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
  updateIssues(issues) {
    if (!this.state.enabled || !['active', 'partial'].includes(this.state.phase)) return;
    this.state.issues = [...new Set(issues)];
    this.state.phase = issues.length || this.state.testState === 'failed' ? 'partial' : 'active';
  }
  serialize(operation) {
    this.operationCount++;
    const next = this.queue.then(operation).finally(() => { this.operationCount--; });
    this.queue = next.catch(() => {});
    return next;
  }
  async recover() {
    try {
      const saved = JSON.parse(await readFile(this.preferenceFile, 'utf8'));
      this.desiredEnabled = saved.enabled === true;
      if (typeof saved.monitoring === 'boolean') this.state.monitoring = saved.monitoring;
      if (Number.isInteger(saved.intervalMs) && saved.intervalMs >= 30000 && saved.intervalMs <= 600000) this.intervalMs = saved.intervalMs;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { this.pending = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this.report(); throw error; }
    if (this.pending) { this.event('检测到未恢复的配置，正在自动恢复'); await this.stop({ shutdown: true }); }
    return this.report();
  }
  startupPreference(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('无效的启动保护设置。');
    return this.serialize(async () => {
      if (this.pending || this.state.enabled || this.state.phase !== 'idle') throw new Error('当前保护尚未恢复，不能覆盖启动意愿。');
      this.intentVersion++;
      await this.savePreference(enabled);
      return this.report();
    });
  }
  start(origin) {
    return this.serialize(() => this.activate(origin));
  }
  async activate(origin) {
    if (this.state.enabled && this.state.phase !== 'restart_required') return this.report();
    if (this.pending && this.state.phase !== 'restart_required') throw new Error('尚有配置未恢复，请先关闭模拟保护以重试恢复。');
    if (origin) this.origin = origin;
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
  resume(origin, { background = false } = {}) {
    this.cancelTest();
    if (origin) this.origin = origin;
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
        if (background) void this.performTest(target);
        else await this.performTest(target);
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
      if (!this.state.enabled || this.testing || this.operationCount || !this.canTest()) return;
      void this.performTest();
    }, this.intervalMs);
    this.timer.unref?.();
  }
  async performTest(detectedTarget) {
    if (this.testing || !this.state.enabled || this.state.phase === 'restart_required') return;
    const controller = new AbortController();
    const version = this.intentVersion;
    this.testController = controller;
    const current = () => this.testController === controller && !controller.signal.aborted && version === this.intentVersion && this.state.enabled;
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    this.testing = true;
    this.state.nextTestAt = this.state.monitoring ? new Date(Date.now() + this.intervalMs).toISOString() : null;
    try {
      const target = detectedTarget ?? await Promise.race([this.detect({ signal: controller.signal }), cancelled]);
      if (!current()) return;
      if (!target?.ip || !target.language) throw new Error('出口识别失败，旧检测结果已过期。');
      // Compare only the fields that affect protection, not fluctuating geo labels.
      const fields = ['ip', 'countryCode', 'language', 'locale', 'timezone', 'windowsTimezone'];
      const changed = fields.filter(key => target[key] !== this.state.target?.[key]);
      if (changed.length) {
        this.state.runId = null; this.state.score = null; this.state.alarm = false;
        // 出口变化不再是死局：自动按最新出口重新适配，用户不必手动关闭再启动。
        // 只保留首次恢复备份（this.pending 不重写），退保护仍能回到原始环境。
        const now = Date.now();
        this.autoAdapts = this.autoAdapts.filter(at => now - at < AUTO_ADAPT_WINDOW_MS);
        if (this.autoAdapts.length >= AUTO_ADAPT_LIMIT) {
          this.state.phase = 'restart_required';
          this.state.testState = 'stale';
          this.state.testError = `出口在 ${Math.round(AUTO_ADAPT_WINDOW_MS / 60000)} 分钟内反复变化（${this.autoAdapts.length} 次），自动重新适配已暂停，请关闭保护后重新启动。`;
          this.event(this.state.testError);
          this.schedule();
          return;
        }
        this.autoAdapts.push(now);
        const applying = Promise.resolve().then(() => this.apply(target, this.origin ?? 'http://localhost:3000'));
        this.applying = applying.catch(() => {});
        let issues;
        try { issues = await applying; }
        catch (error) {
          if (!current()) return;
          // 自动重适配失败才退回人工重启，不把失败伪装成适配成功。
          this.state.phase = 'restart_required';
          this.state.testState = 'stale';
          this.state.testError = `出口已变化但自动重新适配失败：${error.message}。请关闭保护后重新启动。`;
          this.event(this.state.testError);
          this.schedule();
          return;
        }
        finally { this.applying = null; }
        if (!current()) return;
        this.state.target = target;
        this.state.issues = issues;
        this.state.testState = 'pending'; this.state.testError = null;
        this.state.phase = issues.length ? 'partial' : 'active';
        this.event(`检测到出口变化（${changed.join(' / ')}），已自动按最新出口重新适配`);
        // 继续走下面的实际检测：用新配置立刻验证，不留空一轮结果。
      }
      const result = await Promise.race([this.test({ signal: controller.signal }), cancelled]);
      if (!current()) return;
      this.state.runId = result.runId ?? randomUUID();
      this.state.lastTestAt = new Date().toISOString();
      this.state.testState = result.state;
      this.state.testError = result.state === 'passed' ? null : result.error || '模拟测试未通过，请查看测试项目。';
      this.state.phase = this.state.issues.length || result.state !== 'passed' ? 'partial' : 'active';
      this.event(result.state === 'passed' ? '本轮模拟测试已通过，等待环境采样' : '本轮模拟测试未通过');
    } catch (error) {
      if (!current()) return;
      this.state.runId = randomUUID(); this.state.lastTestAt = new Date().toISOString();
      this.state.testState = 'failed'; this.state.testError = error.message; this.state.phase = 'partial';
      this.event('检测异常：' + error.message);
    } finally { if (this.testController === controller) { this.testing = false; this.testController = null; } }
  }
  cancelTest() {
    this.testController?.abort();
    this.testController = null;
    this.testing = false;
  }
  observe({ runId, score, verificationScore, verificationMaximum, sampleId }) {
    if (!this.state.enabled || this.testing || runId !== this.state.runId || (this.state.testState !== 'passed' && !(this.state.testState === 'failed' && verificationScore !== undefined))) return this.report();
    if (sampleId !== undefined && (typeof sampleId !== 'string' || !sampleId || sampleId.length > 128)) throw new Error('无效采样标识。');
    const sampleKey = sampleId === undefined ? null : `${runId}:${sampleId}`;
    if (sampleKey && this.observedSamples.has(sampleKey)) return this.report();
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw new Error('无效异常分。');
    if (score === null) return this.report();
    if (verificationScore !== undefined && (!Number.isFinite(verificationScore) || !Number.isFinite(verificationMaximum) || verificationMaximum <= 0 || verificationScore < 0 || verificationScore > verificationMaximum)) throw new Error('无效验证得分。');
    const previous = this.state.alarm;
    const normalized = verificationScore === undefined ? 100 - score : verificationScore * 100 / verificationMaximum;
    const reference = previous ? this.state.scoreReference : this.state.score === null ? null : this.state.verificationScore;
    const drop = reference > 0 ? Math.max(0, (reference - normalized) * 100 / reference) : 0;
    this.state.score = score; this.state.verificationScore = normalized; this.state.scoreReference = reference;
    this.state.scoreDropPercent = drop; this.state.alarm = drop >= 40 - 1e-9;
    if (sampleKey) {
      this.observedSamples.add(sampleKey);
      if (this.observedSamples.size > 128) this.observedSamples.delete(this.observedSamples.values().next().value);
    }
    if (previous !== this.state.alarm) this.event(this.state.alarm ? `验证得分较上次有效检测下降 ${Math.round(drop)}%，达到 40% 提醒阈值` : '验证得分已恢复至提醒阈值以内');
    return this.report();
  }
  async retest() {
    await this.queue;
    if (!this.state.enabled) throw new Error('请先启动保护，再重新运行保护测试。');
    await this.performTest();
    return this.report();
  }
  monitor(enabled, intervalMs) {
    if (typeof enabled !== 'boolean') throw new Error('无效的监测开关。');
    if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 30000 || intervalMs > 600000)) throw new Error('检测间隔须为30秒至10分钟。');
    return this.serialize(async () => {
      // Commit to disk before updating the live timer or returning success.
      await this.savePreference(this.desiredEnabled, { monitoring: enabled, intervalMs: intervalMs ?? this.intervalMs });
      this.schedule();
      return this.report();
    });
  }
  async restorePending(options = {}) {
    // 等自动重适配的 apply 落盘，避免恢复与重新适配交叉（关闭后配置又被写回去）。
    if (this.applying) await this.applying.catch(() => {});
    this.applying = null;
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
    this.cancelTest();
    if (!options.shutdown) this.desiredEnabled = false;
    clearInterval(this.timer); this.timer = null; this.state.nextTestAt = null;
    return this.serialize(async () => {
      if (!options.shutdown) await this.savePreference(false);
      await this.restorePending(options); return this.report();
    });
  }
}
