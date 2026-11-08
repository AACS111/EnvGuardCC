export const HOSTING_ASNS: Set<number>;
export function isHostingExit(info?: { asn?: number | string | null; org?: string | null; isp?: string | null; domain?: string | null; asnOrg?: string | null }): boolean;
export function describeExit(info?: { asn?: number | string | null; org?: string | null; isp?: string | null; domain?: string | null; asnOrg?: string | null }): string;
