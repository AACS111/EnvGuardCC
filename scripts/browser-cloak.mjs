// Shares the API gateway's state; it never takes account content or credentials from renderer pages.
export class BrowserCloakController {
  fingerprint = null; report = null; origin = null; pending = null; timer = null;
  constructor(runtime, { gatewayUrl = "http://127.0.0.1:3010", intervalMs = 2500, acquire = () => true, release = () => {} } = {}) { this.runtime = runtime; this.gatewayUrl = gatewayUrl; this.intervalMs = intervalMs; this.acquire = acquire; this.release = release; }
  async gatewayState(origin) {
    const response = await fetch(this.gatewayUrl + "/__checkcc/status", { headers: { Origin: origin, "X-CheckCC-Client": "gateway-ui" }, signal: AbortSignal.timeout(2500) });
    const value = await response.json();
    if (!response.ok || value.version !== 1 || typeof value.cloak?.enabled !== "boolean") throw new Error("无法读取网关模拟保护状态。");
    return value;
  }
  key(state) { return JSON.stringify([state.cloak.enabled, state.cloak.updatedAt, state.profile?.updatedAt, state.profile?.language, state.profile?.locale, state.proxy?.mode, state.proxy?.source, state.proxy?.address]); }
  invalidate() { this.fingerprint = null; this.report = null; }
  detach() { clearInterval(this.timer); this.timer = null; this.origin = null; this.fingerprint = null; this.report = null; }
  async sync(origin, { launch = false, force = false } = {}) {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("只接受本机页面。");
    if (this.pending) { await this.pending; return this.sync(origin, { launch, force }); }
    this.pending = this.run(origin, { launch, force }).catch(async (error) => { this.invalidate(); await this.runtime.suspend().catch(() => {}); throw error; });
    try { return await this.pending; } finally { this.pending = null; }
  }
  async run(origin, { launch, force }) {
    const state = await this.gatewayState(origin);
    const fingerprint = this.key(state);
    const connected = [...this.runtime.clients.keys()].sort().join(",") + this.runtime.enabled;
    const cached = !force && this.fingerprint === fingerprint + connected && this.report;
    if (cached && !state.cloak.enabled) return this.report;
    let execution;
    let requestProbe = null;
    if (!state.cloak.enabled) {
      execution = await this.runtime.suspend();
    } else {
      if (!state.profile?.language || !state.profile?.locale) throw new Error("请先配置网关出口语言与区域。");
      await this.runtime.load();
      const language = state.profile.language === "en" ? "en-US" : state.profile.language;
      const languages = [...new Set([language, language.split("-")[0], "en"])];
      const policy = { fontMode: "none", vendorFontLimit: 0, ...this.runtime.policy, webrtcDisabled: false, webrtcRelayOnly: true, languages, locale: state.profile.locale };
      const kinds = [...this.runtime.clients.keys()];
      if (launch && !kinds.includes("web")) kinds.unshift("web");
      execution = cached ? await this.runtime.inspectCurrent() : await this.runtime.apply(policy, origin, kinds);
      if (!kinds.includes("web")) execution.results.unshift({ target: "web", state: "unverified", detail: "独立浏览器未运行，可点击接入浏览器模拟保护。", pages: 0 });
      requestProbe = await this.runtime.probeBrowserHeaders(this.gatewayUrl);
      const browser = execution.results.find((item) => item.target === "web");
      if (browser?.state === "verified" && requestProbe.state !== "verified") { browser.state = "unverified"; browser.detail = requestProbe.detail; }
    }
    const after = await this.gatewayState(origin);
    if (this.key(after) !== fingerprint) throw new Error("网关配置在接入期间发生变化，浏览器已撤销覆盖，请重试。");
    this.report = { ...execution, enabled: state.cloak.enabled, gatewayUpdatedAt: state.cloak.updatedAt, requestProbe };
    this.fingerprint = fingerprint + [...this.runtime.clients.keys()].sort().join(",") + this.runtime.enabled;
    this.origin = origin;
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.pending || !this.origin || !this.acquire()) return;
        void this.sync(this.origin).catch(async (error) => {
          this.fingerprint = null;
          this.report = { enabled: false, policy: {}, results: [{ target: "web", state: "failed", detail: error.message, pages: 0 }], appliedAt: new Date().toISOString(), requestProbe: null };
        }).finally(() => this.release());
      }, this.intervalMs);
      this.timer.unref();
    }
    return this.report;
  }
  async close() { this.detach(); if (this.pending) await this.pending.catch(() => {}); this.detach(); }
}
