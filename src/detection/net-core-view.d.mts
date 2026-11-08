// 网络内核视图模型的类型契约（实现见 net-core-view.mjs）。
export type NetCoreTone = "ok" | "warn" | "danger" | "muted";
export type NetCoreViewState = "unconfigured" | "error" | "idle" | "running" | "unavailable" | "off";

export type NetCoreViolation = { host: string; chains: string[]; count: number; note: string };

export type NetCoreView = {
  state: NetCoreViewState;
  tone: NetCoreTone;
  label: string;
  version: string | null;
  restarts: number;
  tunEnabled: boolean;
  tunCaptured: boolean | null;
  hostMode: boolean;
  demo: boolean;
  showDemoBadge: boolean;
  apiPort: number | null;
  binary: string | null;
  sampledAt: string | null;
  conclusion: { tone: NetCoreTone; title: string; detail: string };
  metrics: Array<{ id: string; label: string; value: string }>;
  violations: NetCoreViolation[];
  violationCount: number;
  nodes: Array<{ name: string; selected: boolean; auto: boolean }>;
  selected: string | null;
  autoSelected: string | null;
  empty: { title: string; detail: string } | null;
  source: { mode: string; url?: string; updatedAt?: string } | null;
  localProxy: string | null;
  mode: "claude" | "rule" | "global" | "direct" | null;
  elevated: boolean | null;
  platform: string | null;
  tunHint: string | null;
  exitStability: { changes: number; windowHours: number; stable: boolean; current: string | null } | null;
  actions: { canStart: boolean; canStop: boolean; canRestart: boolean; canSelect: boolean };
};

export function netCoreView(report: unknown, options?: { locale?: string; exitHistory?: unknown }): NetCoreView;
export function dedupeViolations(violations: unknown): Array<{ host: string; chains: string[]; count: number }>;
export function visibleViolations(view: NetCoreView | null | undefined, limit?: number): { items: NetCoreViolation[]; hidden: number };
