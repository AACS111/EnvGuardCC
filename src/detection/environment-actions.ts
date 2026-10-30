import type { RepairChoice } from "./repair-options";

export type RuntimePolicy = { fontMode?: "none" | "traditional" | "one" | "two" | "three"; vendorFontLimit?: number; languages?: string[]; locale?: string; webrtcDisabled?: boolean; webrtcRelayOnly?: boolean };
export function choiceRuntimePolicy(id: string, choice?: RepairChoice): RuntimePolicy | null {
  if (!choice || choice.id === "current") return null;
  if (id === "chineseFonts") {
    const modes = ["none", "traditional", "one", "two", "three"] as const;
    const index = ["No listed fonts", "Traditional only", "1 simplified font", "2 simplified fonts", "3+ simplified fonts"].findIndex((prefix) => choice.value.startsWith(prefix));
    return index < 0 ? null : { fontMode: modes[index] };
  }
  if (id === "vendorFonts" && /^[012]$/.test(choice.value)) return { vendorFontLimit: Number(choice.value) };
  if ((id === "language" || id === "languageVariant") && choice.action === "language") return { languages: choice.value.split(",").map((part) => part.trim()) };
  if (id === "locale" && choice.action === "locale") return { locale: choice.value };
  if (id === "webrtcLeak" && choice.value.startsWith("禁用 WebRTC")) return { webrtcDisabled: false, webrtcRelayOnly: true };
  return null;
}

export function policyAffectsSignal(policy: RuntimePolicy, id: string) {
  return id === "chineseFonts" && Boolean(policy.fontMode) || id === "vendorFonts" && policy.vendorFontLimit !== undefined || ["language", "languageVariant"].includes(id) && Boolean(policy.languages) || id === "locale" && Boolean(policy.locale) || id.startsWith("webrtc") && (policy.webrtcDisabled === true || policy.webrtcRelayOnly === true);
}
