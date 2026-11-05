// Installed in the target renderer, not in the score calculation. No network or account data is read.
export function installRuntimePolicy(nextPolicy) {
  const key = Symbol.for("checkcc.runtime-policy.v1");
  let state = globalThis[key];
  if (!state) {
    const simplified = ["Microsoft YaHei", "Microsoft JhengHei", "PingFang SC", "Hiragino Sans GB", "STHeiti", "STSong", "SimSun", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei"];
    const traditional = ["PingFang TC", "Heiti TC", "Hiragino Sans CNS", "Noto Sans CJK TC", "Source Han Sans TC", "MingLiU", "PMingLiU"];
    const vendor = ["MiSans", "HarmonyOS Sans", "OPPO Sans", "vivo Sans", "Honor Sans", "Alibaba PuHuiTi", "WPS Fangzheng", "FZLanTingHeiS"];
    state = { policy: {}, simplified, traditional, vendor, blocked: new Set(), originals: [], rtc: {}, intl: {}, languages: typeof navigator === "undefined" ? [] : [...navigator.languages] };
    globalThis[key] = state;
    const replace = (object, property, descriptor) => {
      if (!object) return;
      const original = Object.getOwnPropertyDescriptor(object, property);
      if (!original || !original.configurable) return;
      state.originals.push([object, property, original]);
      Object.defineProperty(object, property, { ...descriptor, configurable: true, enumerable: original.enumerable });
    };
    const blockedFont = (font) => {
      const match = /^(.*?\b\d+(?:\.\d+)?px\s+)(.+)$/i.exec(font);
      if (!match) return font;
      const families = match[2].split(",").map((name) => name.trim()).filter((name) => !state.blocked.has(name.replace(/^["']|["']$/g, "").toLowerCase()));
      return match[1] + (families.length ? families.join(", ") : "sans-serif");
    };
    const canvasTypes = [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D].filter(Boolean);
    for (const Type of canvasTypes) {
      const proto = Type.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "font");
      if (!descriptor?.get || !descriptor?.set) continue;
      const nativeMeasure = proto.measureText;
      if (!state.nativeCanvas) state.nativeCanvas = { descriptor, measure: nativeMeasure };
      replace(proto, "font", { get: descriptor.get, set(value) { descriptor.set.call(this, value); const before = descriptor.get.call(this); const after = blockedFont(before); if (after !== before) descriptor.set.call(this, after); } });
      for (const method of ["measureText", "fillText", "strokeText"]) {
        const native = proto[method];
        replace(proto, method, { writable: true, value: function (...args) { const font = descriptor.get.call(this); const safe = blockedFont(font); if (safe !== font) descriptor.set.call(this, safe); return Reflect.apply(native, this, args); } });
      }
    }
    const hasBlockedFont = (font) => {
      const text = String(font).toLowerCase();
      return [...state.blocked].some((name) => text.includes(name));
    };
    if (globalThis.FontFaceSet) {
      const proto = FontFaceSet.prototype;
      const check = proto.check;
      const load = proto.load;
      replace(proto, "check", { writable: true, value: function (font, ...args) { return hasBlockedFont(font) ? false : Reflect.apply(check, this, [font, ...args]); } });
      replace(proto, "load", { writable: true, value: function (font, ...args) { return hasBlockedFont(font) ? Promise.resolve([]) : Reflect.apply(load, this, [font, ...args]); } });
      // 迭代/size 也要过滤：check 说不存在、迭代却还能列出来，就是新的自相矛盾。
      const nativeValues = typeof proto.values === "function" ? proto.values : null;
      const visible = function* (self) { for (const face of Reflect.apply(nativeValues, self, [])) if (!hasBlockedFont(face?.family)) yield face; };
      if (nativeValues) {
        replace(proto, "values", { writable: true, value: function () { return visible(this); } });
        replace(proto, "keys", { writable: true, value: function () { return visible(this); } });
        replace(proto, "entries", { writable: true, value: function () { return (function* (self) { for (const face of visible(self)) yield [face.family, face]; })(this); } });
        if (proto[Symbol.iterator]) replace(proto, Symbol.iterator, { writable: true, value: function () { return visible(this); } });
        const size = Object.getOwnPropertyDescriptor(proto, "size");
        if (size?.get) replace(proto, "size", { get() { return [...visible(this)].length; } });
        if (typeof proto.forEach === "function") replace(proto, "forEach", { writable: true, value: function (callback, thisArg) {
          for (const face of visible(this)) callback.call(thisArg, face, face, this);
        } });
      }
    }
    if (typeof globalThis.queryLocalFonts === "function") {
      const query = globalThis.queryLocalFonts;
      replace(globalThis, "queryLocalFonts", { writable: true, value: async function (...args) { return (await Reflect.apply(query, this, args)).filter((font) => !state.blocked.has(font.family.toLowerCase())); } });
    }
    if (globalThis.Navigator) {
      replace(Navigator.prototype, "languages", { get() { return state.policy.languages ? Object.freeze([...state.policy.languages]) : [...state.languages]; } });
      replace(Navigator.prototype, "language", { get() { return state.policy.languages?.[0] ?? state.languages[0]; } });
    }
    for (const name of ["DateTimeFormat", "NumberFormat", "Collator", "RelativeTimeFormat", "ListFormat", "PluralRules", "Segmenter"]) {
      const Native = Intl[name];
      if (!Native) continue;
      state.intl[name] = Native;
      replace(Intl, name, { writable: true, value: new Proxy(Native, {
        construct(target, args, newTarget) { if (args[0] === undefined && state.policy.locale) args[0] = state.policy.locale; return Reflect.construct(target, args, newTarget); },
        apply(target, receiver, args) { if (args[0] === undefined && state.policy.locale) args[0] = state.policy.locale; return Reflect.apply(target, receiver, args); },
      }) });
    }
    // 时区：Intl 默认 locale 已覆盖，但 Date#getTimezoneOffset 与 resolvedOptions().timeZone
    // 仍会报系统时区；两处不一致就是最容易被抓的跨信号矛盾。
    if (globalThis.Date) {
      const nativeOffset = Date.prototype.getTimezoneOffset;
      replace(Date.prototype, "getTimezoneOffset", { writable: true, value: function () {
        return Number.isFinite(state.policy.offsetMinutes) ? state.policy.offsetMinutes : Reflect.apply(nativeOffset, this, []);
      } });
    }
    if (globalThis.Intl?.DateTimeFormat?.prototype) {
      const nativeResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      replace(Intl.DateTimeFormat.prototype, "resolvedOptions", { writable: true, value: function () {
        const options = Reflect.apply(nativeResolved, this, []);
        if (state.policy.timezone) options.timeZone = state.policy.timezone;
        return options;
      } });
    }
    // Client Hints：UA 说 Windows 而 UA-CH 说别的平台是典型矛盾。只校对平台，不伪造品牌/版本。
    if (globalThis.Navigator) {
      const nativeHints = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgentData");
      if (nativeHints?.get) replace(Navigator.prototype, "userAgentData", { get() {
        const data = nativeHints.get.call(this);
        const platform = state.policy.uaPlatform;
        if (!data || !platform) return data;
        return new Proxy(data, { get(target, key, receiver) {
          if (key === "platform") return platform;
          if (key === "getHighEntropyValues") return async (hints) => ({ ...await target.getHighEntropyValues(hints), platform });
          return Reflect.get(target, key, receiver);
        } });
      } });
    }
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      state.rtc[name] = globalThis[name];
      const Native = state.rtc[name];
      if (typeof Native !== "function") continue;
      // Relay-only is a real ICE transport restriction: keep native WebRTC available,
      // but never gather host/STUN candidates that could expose the direct exit.
      const Wrapped = new Proxy(Native, {
        construct(target, args, newTarget) {
          if (state.policy.webrtcRelayOnly) args[0] = { ...args[0], iceTransportPolicy: "relay" };
          return Reflect.construct(target, args, newTarget);
        },
      });
      const proto = Native.prototype;
      const configure = proto.setConfiguration;
      if (typeof configure === "function" && !state.rtc.configure) {
        state.rtc.configure = configure;
        replace(proto, "setConfiguration", { writable: true, value: function (config) {
          return Reflect.apply(configure, this, [state.policy.webrtcRelayOnly ? { ...config, iceTransportPolicy: "relay" } : config]);
        } });
      }
      if (Object.getOwnPropertyDescriptor(globalThis, name)) replace(globalThis, name, { get() { return state.policy.webrtcDisabled ? undefined : Wrapped; } });
    }
    state.nativeFonts = (names) => {
      const canvas = globalThis.document?.createElement("canvas") ?? (globalThis.OffscreenCanvas ? new OffscreenCanvas(1, 1) : null);
      const ctx = canvas?.getContext("2d");
      if (!ctx || !state.nativeCanvas) return [];
      const { descriptor, measure } = state.nativeCanvas;
      return names.filter((name) => ["monospace", "sans-serif", "serif"].some((base) => {
        descriptor.set.call(ctx, `72px ${base}`); const width = measure.call(ctx, "中文字体检测ABCabc012").width;
        descriptor.set.call(ctx, `72px "${name}", ${base}`); return Math.abs(measure.call(ctx, "中文字体检测ABCabc012").width - width) > 0.5;
      }));
    };
    state.originalFonts = { simplified: state.nativeFonts(simplified), traditional: state.nativeFonts(traditional), vendor: state.nativeFonts(vendor) };
  }
  state.policy = { ...nextPolicy };
  state.blocked.clear();
  const limits = { none: 0, traditional: 0, one: 1, two: 2, three: 3 };
  if (state.policy.fontMode) {
    const allowed = new Set(state.originalFonts.simplified.slice(0, limits[state.policy.fontMode] ?? 0).map((name) => name.toLowerCase()));
    for (const name of state.simplified) if (!allowed.has(name.toLowerCase())) state.blocked.add(name.toLowerCase());
    if (state.policy.fontMode !== "traditional") for (const name of state.traditional) state.blocked.add(name.toLowerCase());
  }
  if (state.policy.vendorFontLimit !== undefined) {
    const allowed = new Set(state.originalFonts.vendor.slice(0, state.policy.vendorFontLimit).map((name) => name.toLowerCase()));
    for (const name of state.vendor) if (!allowed.has(name.toLowerCase())) state.blocked.add(name.toLowerCase());
  }
  const observe = (names) => {
    const canvas = globalThis.document?.createElement("canvas") ?? (globalThis.OffscreenCanvas ? new OffscreenCanvas(1, 1) : null);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    return names.filter((font) => ["monospace", "sans-serif", "serif"].some((base) => {
      ctx.font = `72px ${base}`; const width = ctx.measureText("中文字体检测ABCabc012").width;
      ctx.font = `72px "${font}", ${base}`; return Math.abs(ctx.measureText("中文字体检测ABCabc012").width - width) > 0.5;
    }));
  };
  let webrtcRelayOnly = false;
  if (state.policy.webrtcRelayOnly && typeof globalThis.RTCPeerConnection === "function") {
    let connection;
    try {
      connection = new globalThis.RTCPeerConnection({ iceTransportPolicy: "all" });
      connection.setConfiguration({ iceTransportPolicy: "all" });
      webrtcRelayOnly = connection.getConfiguration().iceTransportPolicy === "relay";
    } catch { /* Failed enforcement must not be reported as verified. */ }
    finally { connection?.close(); }
  }
  // 字体路径自证：被屏蔽的字体必须在**每一条读取路径**上都“不存在”。
  // 只压 check 而漏了迭代/size，就是留给检测方的矛盾（本函数专门抓这种漏补）。
  const fontPathsConsistent = (() => {
    if (!state.blocked.size) return null;
    const canvas = globalThis.document?.createElement("canvas") ?? (globalThis.OffscreenCanvas ? new OffscreenCanvas(1, 1) : null);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    const sample = "中文字体检测ABCabc012";
    const widthOf = (font) => { ctx.font = font; return ctx.measureText(sample).width; };
    const base = widthOf("72px monospace");
    const fonts = globalThis.document?.fonts;
    return [...state.blocked].slice(0, 8).every((family) => {
      const viaCanvas = Math.abs(widthOf(`72px "${family}", monospace`) - base) <= 0.5;
      const viaCheck = fonts ? fonts.check(`72px "${family}"`) === false : true;
      return viaCanvas && viaCheck;
    });
  })();

  return {
    webrtcRelayOnly,    claudePage: typeof location !== "undefined" && (location.hostname === "claude.ai" || location.hostname.endsWith(".claude.ai")),
    simplified: observe(state.simplified), traditional: observe(state.traditional), vendor: observe(state.vendor),
    languages: typeof navigator === "undefined" ? [] : [...navigator.languages], locale: Intl.DateTimeFormat().resolvedOptions().locale,
    // 时区与 UA-CH：迷惑层必须能自证一致，否则校验结果不能当通过。
    timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
    offsetMinutes: typeof Date === "undefined" ? null : new Date().getTimezoneOffset(),
    uaPlatform: (() => { try { return navigator.userAgentData?.platform ?? null; } catch { return null; } })(),
    uaPlatformFromUserAgent: (() => {
      const ua = typeof navigator === "undefined" ? "" : String(navigator.userAgent ?? "");
      if (/Windows/i.test(ua)) return "Windows";
      if (/Android/i.test(ua)) return "Android";
      if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
      if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
      if (/CrOS/i.test(ua)) return "Chrome OS";
      if (/Linux/i.test(ua)) return "Linux";
      return null;
    })(),
    webrtcDisabled: typeof globalThis.RTCPeerConnection === "undefined", blockedCount: state.blocked.size, fontPathsConsistent,
  };
}

export function runtimePolicyScript(policy) {
  return `(${installRuntimePolicy.toString()})(${JSON.stringify(policy)})`;
}

export function verifyRuntimePolicy(policy, result) {
  if (!result) return false;
  if (policy.fontMode) {
    if (!Array.isArray(result.simplified) || !Array.isArray(result.traditional)) return false;
    const count = { none: 0, traditional: 0, one: 1, two: 2, three: 3 }[policy.fontMode];
    if (result.simplified.length !== count) return false;
    if (policy.fontMode === "traditional" ? result.traditional.length === 0 : result.traditional.length !== 0) return false;
  }
  if (policy.vendorFontLimit !== undefined && result.vendor?.length !== policy.vendorFontLimit) return false;
  if (policy.languages && JSON.stringify(policy.languages) !== JSON.stringify(result.languages)) return false;
  if (policy.locale && Intl.getCanonicalLocales(policy.locale)[0] !== result.locale) return false;
  if (policy.timezone && result.timezone !== policy.timezone) return false;
  if (Number.isFinite(policy.offsetMinutes) && result.offsetMinutes !== policy.offsetMinutes) return false;
  if (policy.uaPlatform && result.uaPlatform !== policy.uaPlatform) return false;
  // UA 与 UA-CH 平台必须自洽（不要求等于出口国家，因为韩国用户也用 Windows）。
  if (result.uaPlatform && result.uaPlatformFromUserAgent && result.uaPlatform !== result.uaPlatformFromUserAgent) return false;
  if (policy.webrtcDisabled !== undefined && policy.webrtcDisabled !== result.webrtcDisabled) return false;
  if (policy.webrtcRelayOnly === true && result.webrtcRelayOnly !== true) return false;
  // 字体各读取路径必须口径一致；任一路径仍能读到被屏蔽字体就不能算验证通过。
  if (result.fontPathsConsistent === false) return false;
  return true;
}

// Upgrade persisted interface blocking without losing the other protection settings.
export function migrateRuntimePolicy(policy) {
  return policy?.webrtcDisabled === true ? { ...policy, webrtcDisabled: false, webrtcRelayOnly: true } : policy;
}

export function restoreRuntimePolicy() {
  const key = Symbol.for("checkcc.runtime-policy.v1");
  const state = globalThis[key];
  if (state) { for (const [object, property, descriptor] of state.originals.reverse()) Object.defineProperty(object, property, descriptor); delete globalThis[key]; }
}
