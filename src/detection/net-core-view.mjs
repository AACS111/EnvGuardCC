// 网络内核的视图模型：把内核报告翻译成界面需要的字段与结论。
// 纯函数、无 DOM，便于用 node --test 直接验证（与 runtime-policy.mjs 相同的引入方式）。
//
// 三条真实性规则（任何一条被破坏都算 P0 缺陷）：
//   1. routing.state = "unknown" 时不得显示"通过/已优化/安全"；
//   2. demo = true 时必须标注演示，且不得判为通过；
//   3. 内核未运行或未配置时，不得给出任何出口结论。

import { regionOfNode } from "../../scripts/net-core/public-dns.mjs";

const text = (locale, cn, en) => (String(locale).startsWith("zh") ? cn : en);

export function nodeMeasurementScope(report) {
  return JSON.stringify([report?.activeId ?? null, report?.source?.url ?? null, report?.source?.updatedAt ?? null]);
}

export function nodeLatencyTone(delay) {
  if (delay === null) return "danger";
  if (!Number.isFinite(delay) || delay < 0) return "muted";
  if (delay < 200) return "ok";
  if (delay < 500) return "warn";
  return "danger";
}

/** 实测出口优先于节点名称；未知地区按需要确认的切换处理。 */
export function nodeSelectionState({ nodes = [], selected = null, delays = {}, exits = {} } = {}) {
  const states = nodes.map(name => {
    const measured = String(exits[name]?.countryCode ?? "").toUpperCase();
    const countryCode = /^[A-Z]{2}$/.test(measured) ? measured : regionOfNode({ name });
    return { name, countryCode, inferred: !/^[A-Z]{2}$/.test(measured), delay: delays[name] };
  });
  const current = states.find(node => node.name === selected);
  const choices = states.map(node => ({
    ...node,
    switchTone: current?.countryCode && current.countryCode === node.countryCode ? "warn" : "danger",
  }));
  if (current?.delay !== null) return { nodes: choices, recovery: null };
  const available = choices.filter(node => node.name !== selected && Number.isFinite(node.delay) && node.delay >= 0);
  const sameRegion = available.filter(node => node.switchTone === "warn");
  const otherRegions = available.filter(node => node.switchTone === "danger");
  return { nodes: choices, recovery: { tone: sameRegion.length ? "warn" : "danger", sameRegion, otherRegions } };
}

const STATE_LABELS = {
  unconfigured: ["未启用", "Not enabled"],
  error: ["启动失败", "Start failed"],
  idle: ["未启动", "Not started"],
  running: ["运行中", "Running"],
  unavailable: ["状态不可读", "Status unavailable"],
  off: ["未接入", "Not connected"],
  starting: ["启动中", "Starting"],
  offline: ["等待网络", "Waiting for network"],
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
      platform: null,
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
  const sampled = Date.parse(routing?.sampledAt ?? "");
  const sampleAge = Date.now() - sampled;
  const freshRouting = Number.isFinite(sampled) && sampleAge >= -5000 && sampleAge <= 45000;
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
  const mode = ["rule", "global", "direct"].includes(report.mode) ? report.mode : null;
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
  } else if (state === "starting") {
    // 启动阶段（建隧道、验证出口）比页面加载慢：告诉用户正在做什么，而不是报未启动。
    tone = "muted";
    conclusion = {
      tone: "muted",
      title: t("网络内核正在启动", "Network kernel is starting"),
      detail: report.reason || t("正在建立隧道并验证出口，完成后自动刷新。", "Establishing the tunnel and verifying the exit; this view refreshes automatically."),
    };
  } else if (state === "idle") {
    // 内核停止 = 没有 TUN 接管：这是「关闭保护后恢复直连」的正常态，不是故障。
    tone = "muted";
    conclusion = {
      tone: "muted",
      title: t("内核已停止 · 流量直连", "Kernel stopped · traffic goes direct"),
      detail: t("当前没有任何流量被隧道接管；需要代理时点击「启动内核」，或重新开启保护。", "No traffic is captured by the tunnel; press \"Start kernel\" or turn protection on again to route through it."),
    };
  } else if (state === "unavailable") {
    tone = "warn";
    conclusion = {
      tone: "warn",
      title: t("内核状态不可读", "Kernel status unavailable"),
      detail: report.reason || t("请确认内核进程仍在运行。", "Confirm the kernel process is still running."),
    };
  } else if (state === "offline") {
    // 断网不是内核故障：等 network 回来就自动复检/重建，不能报成「启动失败」吓人。
    tone = "warn";
    conclusion = {
      tone: "warn",
      title: t("网络已断开 · 等待恢复", "Network down · waiting to recover"),
      detail: report.reason || t("网络恢复后会自动复检，不需要手动重启。", "Verification resumes automatically when the network returns; no manual restart is needed."),
    };
  } else if (routing?.state === "violation" || Number(routing?.direct ?? 0) > 0) {
    tone = "danger";
    conclusion = {
      tone: "danger",
      title: t("存在未走专用出口的连接", "Connections bypassed the dedicated exit"),
      detail: t(`${Number(routing?.direct ?? 0)} 条连接没有走专用出口，见下方明细。`, `${Number(routing?.direct ?? 0)} connection(s) bypassed the dedicated exit; see the details below.`),
    };
  } else if (routing?.state === "verified") {
    // 未启用 TUN、或配置了却没接管，都不能算通过。
    tone = demo || !tunEnabled || tunCaptured !== true || !freshRouting ? "warn" : "ok";
    conclusion = {
      tone,
      title: t("已观察到的 Claude 连接走专用出口", "Observed Claude connections use the dedicated exit"),
      // 后端 detail 是内部术语（CLAUDE-PIN）且只有中文：结论文案在视图层按语言重写。
      detail: t(`内核观察到的 ${Number(routing?.claude ?? 0)} 条 Claude 连接走了专用出口，未覆盖内核外流量。`, `The ${Number(routing?.claude ?? 0)} observed Claude connections used the dedicated exit; traffic outside the kernel is not covered.`),
    };
  } else {
    // 没有路由证据（含 routing 缺失、state=unknown、claude=0）：一律不得显示为通过。
    tone = "warn";
    conclusion = {
      tone: "warn",
      title: t("未观察到 Claude 连接", "No Claude connections observed"),
      detail: t("无法验证是否走隧道；这不等于通过。", "Tunnel routing is unverified; this is not a pass."),
    };
  }

  if (state === "running" && demo) {
    label = t("运行中 · 演示", "Running · Demo");
    conclusion.title = `${t("演示模式", "Demo mode")} · ${conclusion.title}`;
  }
  if (state === "running" && routing?.state === "verified" && !freshRouting) {
    conclusion.detail += t(" 路由证据缺失或已过期，请复检。", " Routing evidence is missing or expired; recheck routing.");
  }
  if (report.strictMode === true && report.capabilities?.strictTravel !== true) {
    tone = "warn";
    conclusion = { tone, title: t("严格连接尚未放行", "Strict connection is not released"), detail: t("系统阻断状态或固定出口尚未验证；复检连接或关闭严格模式恢复联网。", "System filtering or the pinned exit is unverified; recheck or disable strict mode to restore networking.") };
  }
  // 区域锁定优先于「运行中」的其他结论：Claude 已经被拒绝，不能再显示为可用。
  if (report.regionLock?.locked) {
    const lock = report.regionLock;
    // 网络锁会自动复检并自行解除；地区锁必须人工确认新出口。
    const auto = lock.type === "network" || lock.autoRecover === true;
    const attempts = Number.isInteger(lock.recheckAttempts) ? lock.recheckAttempts : 0;
    tone = "danger";
    label = t("已阻断", "Blocked");
    conclusion = {
      tone,
      title: t("Claude 流量已阻断", "Claude traffic blocked"),
      detail: [
        lock.reason || t("固定出口未通过复检，Claude 域名已被拒绝。", "The pinned exit failed recheck; Claude domains are rejected."),
        auto
          ? t(`系统正在自动复检${attempts ? `（第 ${attempts} 次）` : ""}：网络恢复后会立即自动解除，无需手动操作。`, `Automatic recheck is running${attempts ? ` (attempt ${attempts})` : ""}: it unlocks as soon as the network recovers; no manual action needed.`)
          : t("出口确实不在 Claude 支持地区：切换节点后点「复检并解除」。", "The exit is in an unsupported region: switch nodes, then recheck and unlock."),
      ].join(" "),
    };
  } else if (report.unprotectedGuard?.active === true) {
    // 保护关闭即阻断：隧道仍然接管着流量，只是 Claude 域名被拒绝。
    tone = "danger";
    label = t("已阻断", "Blocked");
    conclusion = {
      tone,
      title: t("Claude 已阻断", "Claude blocked"),
      detail: report.unprotectedGuard.reason || t("环境防护未开启，Claude 域名已被拒绝；开启环境防护后恢复。", "Environment protection is off; Claude domains are rejected until protection is enabled."),
    };
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
  } else if (state === "running" && tunEnabled && tunCaptured === null) {
    conclusion.detail += t(" 隧道接管状态未知，不能确认系统流量已受保护。", " Tunnel capture is unknown; system traffic protection is unverified.");
  }
  // 有线 + 无线同时在线时默认接口会跳，TUN 跟着重建，表现为“一波动就断”。
  if (state === "running" && Number(report.network?.links) > 1) {
    conclusion.detail = [conclusion.detail, t("检测到多个网络同时在线（例如同时连有线和无线），出口可能抖动；建议只保留一条网络。", "Multiple networks are online (e.g. Ethernet and Wi-Fi); the exit may flap. Keeping a single link is recommended.")]
      .filter(Boolean).join(zh ? " " : " ");
  }
  // 宿主暂时探测不到：保持宿主模式，不降级自起内核（否则会抢 39090/TUN）。
  if (report.hostProbeFailed === true) {
    conclusion.detail = [conclusion.detail, t("特权宿主暂时无响应，已在保持现有模式；稍后重试即可，不会另起一个内核。", "The privileged helper is temporarily unresponsive; the current mode is kept. Retry shortly — no second kernel is started.")]
      .filter(Boolean).join(zh ? " " : " ");
    if (tone === "ok") { tone = "warn"; conclusion.tone = "warn"; }
  }

  const violations = dedupeViolations(routing?.violations).map((item) => ({
    ...item,
    note: item.chains.length ? item.chains.join(" → ") : t("无代理链", "No proxy chain"),
  }));

  // 未启用 TUN 时必须说明原因，而不是让用户以为内核坏了。
  const hostStaleHint = !hostMode && report.hostStale
    ? t("特权助手版本过旧：开启环境防护时会请求一次系统授权更新，之后不再提示。", "The privileged helper is outdated: enabling protection will request a one-time system authorization to update it.")
    : null;
  const tunHint = hostStaleHint ?? (state === "running" && !tunEnabled
    ? (hostMode
      ? t("系统接管已关闭，内核仍可提供本机代理；开启接管后会重新验证隧道。", "System capture is off; the kernel still provides a local proxy. Enabling capture will reverify the tunnel.")
      : (elevated !== true
        ? (report.elevation?.instruction || t("TUN 需要管理员权限才能接管系统流量。", "TUN requires administrator privileges to capture system traffic."))
        : t("当前是本机直连模式，未安装特权宿主；需要 TUN 请安装宿主。", "Running kernel directly without the privileged host; install the host to use TUN.")))
    : null);

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
    platform: typeof report.elevation?.platform === "string" ? report.elevation.platform : null,
    tunHint,
    exitStability: stability,
    actions: {
      canStart: state !== "running" && state !== "unconfigured" && state !== "off",
      canStop: state === "running",
      canRestart: state === "running",
      canSelect: ["running", "unavailable"].includes(state) && nodes.length > 0,
    },
  };
}

/** 供列表展示：最多渲染多少条违规，其余折叠成计数。 */
export function visibleViolations(view, limit = 20) {
  const list = Array.isArray(view?.violations) ? view.violations : [];
  return { items: list.slice(0, limit), hidden: Math.max(0, list.length - limit) };
}

/** 图上合并实际代理连接；Claude 审计仍使用独立字段。旧后台或过期采样不冒充实测。 */
export function trafficFlowSamples(report, { now = Date.now() } = {}) {
  const routing = report?.routing;
  const age = now - Date.parse(routing?.sampledAt ?? "");
  const sampled = report?.state === "running" && report?.demo !== true && age >= -5000 && age <= 45000;
  const count = value => sampled && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const ordinary = count(routing?.traffic?.proxied), pinned = count(routing?.pinned);
  return {
    proxied: count(routing?.paths?.proxied ?? (ordinary !== null && pinned !== null ? ordinary + pinned : undefined)),
    direct: count(routing?.paths?.direct ?? routing?.traffic?.direct),
    blocked: count(routing?.paths?.blocked ?? routing?.traffic?.blocked),
    unknown: count(routing?.paths?.unknown ?? routing?.traffic?.unknown),
    pinned: count(routing?.pinned),
  };
}

export function activeFlowConnections(report, { now = Date.now() } = {}) {
  const snapshot = report?.connectionLog;
  const age = now - Date.parse(snapshot?.sampledAt ?? "");
  if (report?.state !== "running" || report.demo || !snapshot?.available || !(age >= -5000 && age <= 10000)) return { records: [], hidden: 0 };
  const records = (Array.isArray(snapshot.active) ? snapshot.active : []).filter(record => record?.id && record.kind !== "request" && !record.endedAt);
  return { records, hidden: Math.max(0, (Number(snapshot.activeTotal) || records.length) - records.length) };
}
