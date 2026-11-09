export const CLAUDE_SUPPORTED_REGIONS_URL: string;
export const CLAUDE_SUPPORTED_REGIONS_RETRIEVED_AT: string;
export const CLAUDE_SUPPORTED_REGION_CODES: readonly string[];
export type ClaudeRegionSupport = "supported" | "unsupported" | "unknown";
export function normalizeCountryCode(value: unknown): string | null;
export function claudeRegionSupport(countryCode: unknown): ClaudeRegionSupport;
export function assertClaudeSupportedExit(
  primary: { countryCode?: string | null; ip?: string | null } | null | undefined,
  options?: { source?: string },
): string;
