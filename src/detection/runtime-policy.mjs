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
  return {
    webrtcRelayOnly,
    claudePage: typeof location !== "undefined" && (location.hostname === "claude.ai" || location.hostname.endsWith(".claude.ai")),
    simplified: observe(state.simplified), traditional: observe(state.traditional), vendor: observe(state.vendor),
    languages: typeof navigator === "undefined" ? [] : [...navigator.languages], locale: Intl.DateTimeFormat().resolvedOptions().locale,
    webrtcDisabled: typeof globalThis.RTCPeerConnection === "undefined", blockedCount: state.blocked.size,
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
  if (policy.webrtcDisabled !== undefined && policy.webrtcDisabled !== result.webrtcDisabled) return false;
  if (policy.webrtcRelayOnly === true && result.webrtcRelayOnly !== true) return false;
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
