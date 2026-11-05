// 网络内核的视图模型：把内核报告翻译成界面需要的字段与结论。
// 纯函数、无 DOM，便于用 node --test 直接验证（与 runtime-policy.mjs 相同的引入方式）。
//
// 三条真实性规则（任何一条被破坏都算 P0 缺陷）：
//   1. routing.state = "unknown" 时不得显示"通过/已优化/安全"；
//   2. demo = true 时必须标注演示，且不得判为通过；
//   3. 内核未运行或未配置时，不得给出任何出口结论。

const text = (locale, cn, en) => (String(locale).startsWith("zh") ? cn : en);

const STATE_LABELS = {
  unconfigured: ["未启用", "Not enabled"],
  error: ["启动失败", "Start failed"],
  idle: ["未启动", "Not started"],
  running: ["运行中", "Running"],
  unavailable: ["状态不可读", "Status unavailable"],
  off: ["未接入", "Not connected"],
};

function normalizeViolation(item) {
  const host = typeof item?.host === "string" ? item.host : "";
  const chains = Array.isArray(item?.chains) ? item.chains.filter((name) => typeof name === "string") : [];
  return { host, chains };
}

/** 同一主机的多条违规合并为一条，但计数保留真实条数。 */
export function dedupeViolations(violations) {
  const map = new Map();
  for (const item of Array.isArray(violations) ? violations : []) {
    const { host, chains } = normalizeViolation(item);
    if (!host) continue;
    const current = map.get(host);
    if (current) {
      current.count += 1;
      if (!current.chains.length && chains.length) current.chains = chains;
      continue;
    }
    map.set(host, { host, chains, count: 1 });
  }
  return [...map.values()];
}

export function netCoreView(report, { locale = "zh", exitHistory = null } = {}) {
  const zh = String(locale).startsWith("zh");
  const t = (cn, en) => text(locale, cn, en);

  if (!report || typeof report !== "object") {
    return {
      state: "off",
      tone: "muted",
      label: t(...STATE_LABELS.off),
      conclusion: {
        tone: "muted",
        title: t("网络内核未接入", "Network kernel not connected"),
        detail: t("本次启动没有内核状态，无法判断出口。", "No kernel status in this session; exit cannot be judged."),
      },
      metrics: [],
      violations: [],
      nodes: [],
      empty: null,
      showDemoBadge: false,
      violationCount: 0,
      source: null,
      localProxy: null,
      mode: null,
      elevated: null,
      tunHint: null,
      exitStability: null,
      actions: { canStart: false, canStop: false, canRestart: false, canSelect: false },
    };
  }

  const rawState = typeof report.state === "string" ? report.state : "unavailable";
  // 服务端用 disabled 表示未启用；界面按"未配置"处理，避免与"状态不可读"混淆。
  const normalizedState = rawState === "disabled" ? "unconfigured" : rawState;
  const state = STATE_LABELS[normalizedState] ? normalizedState : "unavailable";
  const routing = report.routing && typeof report.routing === "object" ? report.routing : null;
  const demo = report.demo === true;
  const tunEnabled = report.tunEnabled === true;
  // 配置里开了 ≠ 网卡真的接管了：分开显示，才能区分「没启用 TUN」和「启用了但没接管」。
  const tunCaptured = typeof report.tunCaptured === "boolean" ? report.tunCaptured : null;
  const hostMode = report.hostMode === true;
  const restarts = Number.isFinite(report.restarts) ? report.restarts : 0;
  const nodes = Array.isArray(report.nodes) ? report.nodes.filter((name) => typeof name === "string") : [];
  const selected = typeof report.selected === "string" ? report.selected : null;
  // 兜底出口由故障转移组选出，可能不是 Claude 组的当前节点；两者都要能看见。
  const autoSelected = typeof report.autoSelected === "string" ? report.autoSelected : null;

  const baseMetrics = [];
  const source = report.source && typeof report.source === "object" ? report.source : null;
  const localProxy = typeof report.localProxy === "string" ? report.localProxy : null;
  const mode = ["claude", "rule", "global", "direct"].includes(report.mode) ? report.mode : null;
  const elevated = report.elevation && typeof report.elevation.elevated === "boolean" ? report.elevation.elevated : null;
  const stability = exitHistory && Number.isFinite(exitHistory.changes)
    ? { changes: exitHistory.changes, windowHours: exitHistory.windowHours ?? 48, stable: exitHistory.changes === 0, current: exitHistory.current ?? null }
    : null;
  if (routing) {
    baseMetrics.push(
      { id: "claude", label: t("Claude 连接", "Claude connections"), value: String(routing.claude ?? 0) },
      { id: "pinned", label: t("命中专用组", "Pinned"), value: String(routing.pinned ?? 0) },
      { id: "direct", label: t("直连违规", "Direct"), value: String(routing.direct ?? 0) },
    );
  }
  // 未启用时没有可比较的指标，避免显示一排 0 冒充"已测量"。
  if (state !== "unconfigured" && state !== "off") {
    baseMetrics.push({ id: "restarts", label: t("内核重启", "Kernel restarts"), value: String(restarts) });
  }

  let tone = "muted";
  let label = t(...STATE_LABELS[state]);
  let conclusion;

  if (state === "unconfigured" || state === "off") {
    conclusion = {
      tone: "muted",
      title: t("网络内核未启用", "Network kernel not enabled"),
      detail: report.reason || t("尚未配置出口节点或未接入内核。", "No exit nodes configured, or the kernel is not connected."),
    };
  } else if (state === "error") {
    tone = "danger";
    conclusion = {
      tone: "danger",
      title: t("内核启动失败", "Kernel failed to start"),
      detail: report.reason || t("未提供失败原因。", "No failure reason reported."),
    };
  } else if (state === "idle") {
    // 内核停止 = 没有 TUN 接管：这是「关闭保护后恢复直连」的正常态，不是故障。
    tone = "muted";
    conclusion = {
      tone: "muted",
      title: t("内核已停止 · 流量直连", "Kernel stopped · traffic goes direct"),
      detail: t("当前没有任何流量被隧道接管；需要代理时重新开启保护。", "No traffic is captured by the tunnel; start protection again to route through it."),
    };
  } else if (state === "unavailable") {
    tone = "warn";
    conclusion = {
      tone: "warn",
      title: t("内核状态不可读", "Kernel status unavailable"),
      detail: report.reason || t("请确认内核进程仍在运行。", "Confirm the kernel process is still running."),
    };
  } else if (routing?.state === "violation" || Number(routing?.direct ?? 0) > 0) {
    tone = "danger";
    conclusion = {
      tone: "danger",
      title: t("存在未走专用出口的连接", "Connections bypassed the dedicated exit"),
      detail: report.detail || t("请复查置顶规则是否被其它规则抢先命中。", "Check whether another rule captured these domains first."),
    };
  } else if (routing?.state === "verified") {
    // 未启用 TUN、或配置了却没接管，都不能算通过。
    tone = demo || !tunEnabled || tunCaptured === false ? "warn" : "ok";
    conclusion = {
      tone,
      title: t("Claude 流量全部走专用出口", "All Claude traffic uses the dedicated exit"),
      detail: report.detail || "",
    };
  } else {
    // 没有路由证据（含 routing 缺失、state=unknown、claude=0）：一律不得显示为通过。
    tone = "warn";
    conclusion = {
      tone: "warn",
      title: t("未观察到 Claude 连接", "No Claude connections observed"),
      detail: report.detail || t("无法验证是否走隧道；这不等于通过。", "Tunnel routing is unverified; this is not a pass."),
    };
  }

  if (state === "running" && demo) {
    label = t("运行中 · 演示", "Running · Demo");
    conclusion.title = `${t("演示模式", "Demo mode")} · ${conclusion.title}`;
  }
  if (state === "running" && !tunEnabled) {
    // 宿主模式下 TUN 关闭是「关闭保护 / 暂停接管」的正常态，不是故障：
    // 内核仍在跑（节点可测速、39080 可当代理），只是系统流量直连。
    if (hostMode) tone = "muted";
    conclusion.tone = tone;
    conclusion.detail = [conclusion.detail, t("TUN 未启用，流量未走隧道（内核仍在运行）。", "TUN is disabled; traffic goes direct while the kernel keeps running.")]
      .filter(Boolean).join(zh ? " " : " ");
  } else if (state === "running" && tunCaptured === false) {
    conclusion.detail = [conclusion.detail, t("TUN 已配置但未接管流量（网卡未生效），请重启内核或检查宿主权限。", "TUN is configured but not capturing traffic; restart the kernel or check the host privilege.")]
      .filter(Boolean).join(zh ? " " : " ");
  }

  const violations = dedupeViolations(routing?.violations).map((item) => ({
    ...item,
    note: item.chains.length ? item.chains.join(" → ") : t("无代理链", "No proxy chain"),
  }));

  // 未启用 TUN 时必须说明原因，而不是让用户以为内核坏了。
  const tunHint = state === "running" && !tunEnabled
    ? (hostMode
      ? t("内核已由特权宿主托管，但当前配置未启用 TUN（CHECKCC_NET_CORE_TUN=0）。", "The kernel is hosted but TUN is disabled in the current configuration (CHECKCC_NET_CORE_TUN=0).")
      : (elevated !== true
        ? (report.elevation?.instruction || t("TUN 需要管理员权限才能接管系统流量。", "TUN requires administrator privileges to capture system traffic."))
        : t("当前是本机直连模式，未安装特权宿主；需要 TUN 请安装宿主。", "Running kernel directly without the privileged host; install the host to use TUN.")))
    : null;

  const empty = state === "unconfigured" || state === "off"
    ? {
      title: t("先配置出口节点", "Configure exit nodes first"),
      detail: t("内核只在有节点时启动；未配置时不做任何出口判断。", "The kernel only starts with nodes; with none, no exit judgement is made."),
    }
    : null;

  return {
    state,
    tone,
    label,
    version: typeof report.version === "string" ? report.version : null,
    restarts,
    tunEnabled,
    tunCaptured,
    hostMode,
    demo,
    showDemoBadge: demo,
    apiPort: Number.isInteger(report.apiPort) ? report.apiPort : null,
    binary: typeof report.binary === "string" ? report.binary : null,
    sampledAt: typeof routing?.sampledAt === "string" ? routing.sampledAt : null,
    conclusion,
    metrics: baseMetrics,
    violations,
    violationCount: violations.reduce((sum, item) => sum + item.count, 0),
    nodes: nodes.map((name) => ({ name, selected: name === selected, auto: name === autoSelected })),
    selected,
    autoSelected,
    empty,
    source,
    localProxy,
    mode,
    elevated,
    tunHint,
    exitStability: stability,
    actions: {
      canStart: state !== "running" && state !== "unconfigured" && state !== "off",
      canStop: state === "running",
      canRestart: state === "running",
      canSelect: state === "running" && nodes.length > 0,
    },
  };
}

/** 供列表展示：最多渲染多少条违规，其余折叠成计数。 */
export function visibleViolations(view, limit = 20) {
  const list = Array.isArray(view?.violations) ? view.violations : [];
  return { items: list.slice(0, limit), hidden: Math.max(0, list.length - limit) };
}
