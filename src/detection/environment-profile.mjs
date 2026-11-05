// 声明面画像的唯一真相源。
// 内核（出口）、网关（HTTP 头）、迷惑层（渲染页）都必须从这里取值：
// 跨信号矛盾（例如 languages=ko-KR 而时区仍是 UTC+8）比任何单个信号都更容易被识别。
// 只做纯计算，不读网络、不读账号数据。

/** IANA 时区在当前时刻的 UTC 偏移（分钟，东八区为 -480，与 Date#getTimezoneOffset 同号）。 */
export function offsetMinutes(timeZone) {
  if (!timeZone) return null;
  try {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    // 与 Date#getTimezoneOffset 同号：UTC+9 → -540。
    return -Math.round((asUTC - (now.getTime() - now.getMilliseconds())) / 60000);
  } catch {
    return null;
  }
}

/** 与网关改写保持同一顺序：主语言、主语言基码、en；避免同一 profile 在三处生成不同字符串。 */
export function acceptLanguage(language, locale) {
  const primary = locale || language;
  if (!primary) return null;
  const base = primary.split("-")[0];
  return [...new Set([primary, base, "en"])].map((tag, index) => index === 0 ? tag : `${tag};q=${index === 1 ? "0.9" : "0.5"}`).join(",");
}

/** 从 UA 推出平台，用于断言 UA 与 UA-CH 不矛盾（不伪造平台：Windows 用户在哪个地区都是 Windows）。 */
export function userAgentPlatform(userAgent) {
  const ua = String(userAgent ?? "");
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}

/**
 * 把出口画像翻译成声明面参数。
 * platform 默认为 null（保持真实平台）：韩国用户也用 Windows，伪造平台只会与 UA 冲突。
 */
export function environmentProfile({ language, locale, timezone = null, platform = null } = {}) {
  if (!language && !locale) throw new Error("环境画像至少需要语言或区域。");
  const tag = Intl.getCanonicalLocales(locale || language)[0];
  return {
    language: tag,
    locale: tag,
    timezone: timezone || null,
    offsetMinutes: offsetMinutes(timezone),
    platform,
    acceptLanguage: acceptLanguage(language, tag),
    languages: [...new Set([tag, tag.split("-")[0], "en"])],
  };
}

/**
 * 一致性核对：返回值只列「不一致项」，全部一致时返回空数组。
 * 调用方不许把非空结果当成通过（这是迷惑层「已验证」的唯一判据）。
 */
export function profileMismatches(profile, observed = {}) {
  const mismatches = [];
  const expected = profile?.languages;
  if (Array.isArray(expected) && JSON.stringify(expected) !== JSON.stringify(observed.languages ?? [])) {
    mismatches.push({ id: "languages", expected, actual: observed.languages ?? [] });
  }
  if (profile?.locale && observed.locale && profile.locale !== observed.locale) {
    mismatches.push({ id: "locale", expected: profile.locale, actual: observed.locale });
  }
  if (profile?.timezone && observed.timezone && profile.timezone !== observed.timezone) {
    mismatches.push({ id: "timezone", expected: profile.timezone, actual: observed.timezone });
  }
  if (profile?.offsetMinutes !== null && profile?.offsetMinutes !== undefined && Number.isFinite(observed.offsetMinutes) && observed.offsetMinutes !== profile.offsetMinutes) {
    mismatches.push({ id: "timezoneOffset", expected: profile.offsetMinutes, actual: observed.offsetMinutes });
  }
  // 平台按「UA 与 UA-CH 自洽」核对，而不是要求等于出口国家。
  if (observed.uaPlatform && observed.uaPlatformFromUserAgent && observed.uaPlatform !== observed.uaPlatformFromUserAgent) {
    mismatches.push({ id: "uaPlatform", expected: observed.uaPlatformFromUserAgent, actual: observed.uaPlatform });
  }
  return mismatches;
}
