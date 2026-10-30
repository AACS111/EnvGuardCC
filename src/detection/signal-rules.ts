// Actual detection and setting previews share these rules. Values are heuristic scores, not probabilities.
export const timezoneScore = (value: string) =>
  ["Asia/Shanghai", "Asia/Urumqi", "Asia/Chongqing", "Asia/Harbin", "Asia/Kashgar"].includes(value) ? 1
    : ["Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei"].includes(value) ? 0.6 : 0;

export const languageScore = (values: string[]) => values.some((value) => /^zh-cn|zh-hans|^zh$/i.test(value)) ? 1
  : values.some((value) => /^zh/i.test(value)) ? 0.5 : 0;
export const localeScore = (value: string) => /zh-cn|zh-hans|^zh$/i.test(value) ? 1 : /^zh/i.test(value) ? 0.5 : 0;
export const variantScore = (values: string[]) => values.some((value) => /zh/i.test(value)) ? 1 : 0;
export const fontScore = (simplified: number, traditional: number) => simplified ? Math.min(1, 0.75 + 0.08 * simplified) : traditional ? 0.5 : 0;
export const vendorFontScore = (count: number) => count >= 2 ? 1 : count === 1 ? 0.8 : 0;
export const deviceScore = (value: string | null) => value === "harmonyos" ? 1 : value ? 0.7 : 0;
export const emojiScore = (ua: string) => /android|harmonyos|windows/i.test(ua) ? 1 : /iphone|ipad|mac os/i.test(ua) ? 0.5 : 0;
export const offsetScore = (offset: number) => offset === 8 ? 1 : 0;
// WebRTC 泄漏：暴露任意公网候选地址即整项命中；HTTPS 下 mDNS 隐藏不会产生泄漏。
export const webrtcLeakScore = (count: number) => count > 0 ? 1 : 0;

export function timezoneOffset(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(now);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (Number(match[2]) + Number(match[3]) / 60) * (match[1] === "+" ? 1 : -1) : 0;
}
