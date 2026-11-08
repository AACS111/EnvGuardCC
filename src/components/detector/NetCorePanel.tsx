"use client";
// 网络页：一张「出口结论」回答"现在安不安全"，其余按「出口 → 节点 → 维护」分层。
// 订阅地址、内核版本、重启等低频信息收进配置弹窗与「诊断与高级操作」，主页面只留结论与证据。
import { useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type { ExitHistory, NetCoreExit, NetCoreNetworkState, NetCoreReport } from "@/detection/gateway-check";
import { netCoreView, visibleViolations } from "@/detection/net-core-view.mjs";
import { claudeRegionSupport } from "@/detection/claude-regions.mjs";
import { describeExit } from "@/detection/exit-quality.mjs";
import { exemptSummary } from "./NetworkExemptDialog";

type Props = {
  locale: LocaleCode;
  report: NetCoreReport | null;
  busy?: boolean;
  error?: string;
  onRefresh: () => void;
  onStart: () => void;
  onStop?: () => void;
  onTunnelChange?: (enabled: boolean) => void;
  onStrictChange?: (enabled: boolean) => void;
  tunnelLocked?: boolean;
  onRestart: () => void;
  onSelectNode: (name: string) => void;
  onManageSources: () => void;
  onAddSource?: () => void;
  onOpenNetworkConfig: () => void;
  onMeasure: () => void;
  networkState?: NetCoreNetworkState | null;
  measuring?: boolean;
  delays?: Record<string, number | null>;
  exits?: Record<string, NetCoreExit | null>;
  exitsAt?: string | null;
  onProbeExits?: () => void;
  probingExits?: boolean;
  onModeChange: (mode: "claude" | "rule" | "global" | "direct") => void;
  onAuthorizeHost?: () => void;
  exitHistory?: ExitHistory | null;
};

type Mode = "claude" | "rule" | "global" | "direct";

const MODES: Array<{ id: Mode; cn: string; en: string; cnHint: string; enHint: string }> = [
  { id: "rule", cn: "规则", en: "Rule", cnHint: "海外走节点，国内直连", enHint: "Overseas via node, domestic direct" },
  { id: "global", cn: "全局", en: "Global", cnHint: "除内网豁免外走节点", enHint: "Via nodes except local exemptions" },
  { id: "direct", cn: "其他直连", en: "Others direct", cnHint: "Claude 仍走固定出口，其他流量直连", enHint: "Claude stays on its pinned exit; other traffic is direct" },
  { id: "claude", cn: "仅 Claude", en: "Claude only", cnHint: "只优化 Claude 域名", enHint: "Only Claude domains" },
];

const clock = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour12: false }) : "—";

// 采样时间用相对说法：绝对时间只在诊断里出现，主页面不需要读秒。
const relative = (value: string | null, zh: boolean) => {
  if (!value) return "";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return "";
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return zh ? "刚刚" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)} d ago`;
};

// 节点名里通常已经带了地区（如 HKHong Kong 01）；出口地区与名字一致时就不再重复显示，只在不一致时补上。
const exitRegion = (name: string, exit: { countryCode: string | null; country: string | null } | null | undefined) => {
  const region = exit?.country ?? exit?.countryCode ?? "";
  if (!region) return "";
  return name.toLowerCase().includes(region.toLowerCase()) ? "" : region;
};

export function NetCorePanel({
  locale, report, busy = false, error, onRefresh, onStart, onStop, onRestart, onAuthorizeHost, onSelectNode,
  onManageSources, onAddSource, onMeasure, measuring = false, delays = {}, exits = {}, exitsAt = null, onProbeExits, probingExits = false,
  onModeChange, exitHistory = null, onOpenNetworkConfig, networkState = null, onTunnelChange, onStrictChange, tunnelLocked = false,
}: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => zh ? cn : en;
  const view = netCoreView(report, { locale, exitHistory });
  const { items: violations, hidden } = visibleViolations(view, 20);
  // 切换出站模式会重启内核（连接中断几秒）：先确认，再执行。
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [confirmStrict, setConfirmStrict] = useState(false);
  const strict = report?.strictMode === true || report?.guard?.armed === true;

  const selectedName = view.nodes.find((node) => node.selected)?.name ?? view.selected ?? null;
  const selectedDelay = selectedName ? delays[selectedName] : undefined;
  const selectedExit = selectedName ? exits[selectedName] : null;
  const exitSupport = claudeRegionSupport(selectedExit?.countryCode);
  const exitIp = selectedExit?.ip ?? exitHistory?.current ?? null;
  const region = selectedName ? (exitRegion(selectedName, selectedExit) || selectedExit?.country || "") : "";
  const sources = report?.sources ?? [];
  const activeSource = sources.find((source) => source.id === report?.activeId) ?? sources[0] ?? null;
  const modeHint = MODES.find((item) => item.id === view.mode);
  // 模式切成功后 view.mode 会等于待确认项，确认条自动消失，不需要用 effect 回写状态。
  const pending = pendingMode && pendingMode !== view.mode ? MODES.find((item) => item.id === pendingMode) ?? null : null;

  return <section className="netcore" aria-label={text("网络内核", "Network kernel")}>
    <div className="netcore-conclusion" data-tone={view.conclusion.tone}>
      <div className="netcore-conclusion__body">
        <p className="netcore-eyebrow">{text("出口结论", "Exit conclusion")}</p>
        <h2>{view.conclusion.title}</h2>
        {view.conclusion.detail && <p className="netcore-detail">{view.conclusion.detail}</p>}
        <p className="netcore-facts">
          {exitIp && <span><b>{text("出口 IP", "Exit IP")}</b>{exitIp}</span>}
          {selectedName && <span><b>{text("节点", "Node")}</b>{selectedName}</span>}
          {typeof selectedDelay === "number" && <span><b>{text("延迟", "Latency")}</b>{selectedDelay} ms</span>}
          {region && <span><b>{text("地区", "Region")}</b>{region}</span>}
          {selectedExit?.hosting && <span><b>{text("出口类型", "Exit type")}</b>{text("云机房/托管", "Cloud/hosting")}</span>}
          {view.sampledAt && <span className="netcore-muted">{text(`采样 ${relative(view.sampledAt, true)} · 自动刷新`, `Sampled ${relative(view.sampledAt, false)} · auto refresh`)}</span>}
        </p>
        {selectedExit?.hosting && <p className="netcore-alert" role="alert">
          {text(
            `出口是云机房/托管 IP（${describeExit(selectedExit)}），Claude 可能拒绝登录；建议使用住宅/原生 IP 节点。`,
            `The exit is a cloud/hosting IP (${describeExit(selectedExit)}); Claude may refuse login. Prefer a residential/native-IP node.`,
          )}
        </p>}
        {exitSupport === "unsupported" && <p className="netcore-detail" role="alert">
          {text(
            `当前出口 ${selectedExit?.countryCode} 不在 Claude 支持地区内；启动环境防护会被拒绝，请先切换到支持地区的节点。`,
            `The current exit ${selectedExit?.countryCode} is outside Claude's supported regions; environment protection will refuse to start. Switch to a supported node first.`,
          )}
        </p>}
      </div>
      <div className="netcore-conclusion__state">
        {view.tone !== "ok" && <span className="netcore-badge" data-tone={view.tone}>{view.label}</span>}
        <div className="netcore-actions">
          <button type="button" className="repair-button repair-button--quiet" onClick={onManageSources} disabled={busy}>{text("配置厂商", "Providers")}</button>
          <button type="button" className="repair-button" onClick={onAddSource ?? onManageSources} disabled={busy}>{text("添加配置", "Add configuration")}</button>
          <button type="button" className="repair-button" onClick={strict && !report?.capabilities?.strictTravel ? onRestart : onRefresh} disabled={busy}>{text("复检路由", "Recheck routing")}</button>
        </div>
      </div>
    </div>

    {onTunnelChange && <section className="netcore-block" aria-label={text("系统流量接管", "System traffic capture")}>
      <div className="netcore-block__head">
        <h3>{text("系统流量接管", "System traffic capture")}</h3>
        <button type="button" className="repair-button" role="switch" aria-checked={view.tunEnabled === true}
          disabled={busy || tunnelLocked || strict || !view.nodes.length} onClick={() => onTunnelChange(!view.tunEnabled)}>
          {view.tunEnabled ? text("关闭接管", "Disable capture") : text("开启接管", "Enable capture")}
        </button>
      </div>
      <p className="netcore-detail">{tunnelLocked ? text("环境防护正在使用隧道；结束环境防护后可单独管理接管。", "Environment protection is using the tunnel; stop it before changing capture separately.") : text("可独立使用代理，无需开启时区或浏览器环境适配。", "Use the proxy independently of timezone and browser environment settings.")}</p>
      <p className="netcore-detail">{text("开启前会自动请求退出已识别的代理客户端，并检查网络与端口是否释放；未能退出时暂停接管。", "Before enabling, known proxy clients are asked to quit and resources are checked. Capture pauses if a conflict remains.")}</p>
      {report?.takeover?.phase === "blocked" && <p className="netcore-detail" role="alert">{report.takeover.reason}</p>}
      {report?.takeover?.phase === "ready" && report.takeover.closed.length > 0 && <p className="netcore-detail" role="status">{text(`已退出：${report.takeover.closed.join("、")}`, `Closed: ${report.takeover.closed.join(", ")}`)}</p>}
      {report?.capabilities?.systemKillSwitch === false && !strict && <p className="netcore-detail" role="note">{text("尚未开启系统断流阻断：内核异常退出后可能恢复直连。", "System kill switch is off: traffic may go direct after a kernel failure.")}</p>}
    </section>}

    {onStrictChange && <section className="netcore-block" aria-label={text("严格连接保护", "Strict connection protection")}>
      <div className="netcore-block__head">
        <h3>{text("严格连接保护", "Strict connection protection")}</h3>
        <button type="button" className="repair-button" role="switch" aria-checked={strict}
          disabled={busy || (!strict && (view.platform !== "darwin" || !view.nodes.length))}
          onClick={() => { if (strict) onStrictChange(false); else setConfirmStrict(true); }}>
          {strict ? text("关闭严格模式并恢复联网", "Disable strict mode and restore network") : text("开启严格模式", "Enable strict mode")}
        </button>
      </div>
      <p className="netcore-detail" role="status">{strict
        ? (report?.guard?.phase === "active" && report.capabilities?.strictTravel ? text("系统阻断与隧道已核验；出口变化后会暂停连接。", "System filter and tunnel verified; an observed exit change pauses connections.") : text("严格模式正在阻断或尚未验证；请复检，或关闭严格模式恢复联网。", "Strict mode is blocking or unverified; recheck, or disable strict mode to restore networking."))
        : text("macOS：全部出站固定到一个节点，阻断其他网络路径；Windows 尚未提供系统断流实现。", "macOS: pin all outbound traffic to one node and block other paths. A Windows system filter is not yet available.")}</p>
      {!strict && <p className="netcore-detail" role="note">{text("出差时让 EGCC 在后台运行即可：固定出口落回不支持地区会自动拒绝 Claude 域名，其他流量不受影响。彻底退出应用后会恢复系统时区与网络，阻断停止。", "Keep EGCC running in the background when travelling: if the pinned exit falls back to an unsupported region, Claude domains are rejected while other traffic keeps working. A full quit restores the system timezone and network, and ends the block.")}</p>}
      {strict && <p className="netcore-detail">{text("退出应用或异常崩溃后仍保留阻断。也可在终端运行 sudo /Library/PrivilegedHelperTools/com.envguardcc.kernel-recover 恢复联网。", "Blocking remains after quitting or crashing. To recover from Terminal, run sudo /Library/PrivilegedHelperTools/com.envguardcc.kernel-recover.")}</p>}
      {confirmStrict && !strict && <div className="netcore-confirm" role="alert">
        <span>{text("开启会重连当前网络连接，阻断内网及其他直连流量。退出应用后也保持阻断，必须明确关闭或使用恢复工具解除。仅在兼容的 macOS 防火墙布局下启用；不保证第三方服务资格或账号结果。", "Enabling reconnects existing connections and blocks LAN and other direct traffic. Blocking remains after quitting until explicitly disabled or recovered. Requires a compatible macOS firewall layout; it does not guarantee service eligibility or account outcomes.")}</span>
        <div className="netcore-confirm__actions"><button type="button" className="repair-button repair-button--quiet" onClick={() => setConfirmStrict(false)}>{text("取消", "Cancel")}</button><button type="button" className="repair-button" onClick={() => { setConfirmStrict(false); onStrictChange(true); }}>{text("确认开启", "Confirm")}</button></div>
      </div>}
    </section>}

    <div className="netcore-modes" role="group" aria-label={text("出站模式", "Egress mode")}>
      <span className="netcore-modes__label">{text("代理范围", "Proxy scope")}</span>
      {MODES.map((item) => <button key={item.id} type="button" className="netcore-mode" aria-pressed={view.mode === item.id} disabled={busy || strict}
        title={text(item.cnHint, item.enHint)}
        onClick={() => { if (item.id !== view.mode) setPendingMode(item.id); }}>{text(item.cn, item.en)}</button>)}
    </div>
    <p className="netcore-mode-hint">{view.mode === "rule" ? text("海外站点（含 Claude）走节点，国内直连。", "Overseas sites (incl. Claude) use the node; domestic traffic is direct.") : modeHint ? text(modeHint.cnHint, modeHint.enHint) : text("未设置", "Not set")}</p>
    {pending && <div className="netcore-confirm" role="alert">
      <span>{text(`切换到「${pending.cn}」会重启内核，Claude 连接会中断几秒。`, `Switching to "${pending.en}" restarts the kernel and interrupts Claude connections for a few seconds.`)}</span>
      <div className="netcore-confirm__actions">
        <button type="button" className="repair-button repair-button--quiet" onClick={() => setPendingMode(null)}>{text("取消", "Cancel")}</button>
        <button type="button" className="repair-button" onClick={() => { const next = pendingMode; setPendingMode(null); if (next) onModeChange(next); }}>{text("确认切换", "Switch")}</button>
      </div>
    </div>}

    {view.tunHint && <p className="netcore-alert" role="status">{view.tunHint}{onAuthorizeHost && ["darwin", "win32"].includes(view.platform ?? "") && view.hostMode === false && view.elevated === false && <button type="button" className="repair-button repair-button--quiet netcore-authorize" onClick={onAuthorizeHost} disabled={busy}>{text("授权安装特权助手", "Authorize helper")}</button>}</p>}
    {error && <p className="netcore-alert" role="alert">{error}</p>}

    {view.empty && view.nodes.length === 0 && <div className="netcore-empty">
      <p>{view.empty.title}</p>
      <p className="netcore-detail">{view.empty.detail}</p>
      <button type="button" className="repair-button" onClick={onAddSource ?? onManageSources} disabled={busy}>{text("添加配置", "Add configuration")}</button>
    </div>}

    {violations.length > 0 && <section className="netcore-block" aria-label={text("直连违规", "Direct violations")}>
      <h3>{text("未走专用出口", "Bypassed the dedicated exit")} <span className="workspace-heading-count">{view.violationCount}</span></h3>
      <ul className="netcore-violations">
        {violations.map((item) => <li key={item.host} data-flagged="true">
          <span className="netcore-host">{item.host}</span>
          <span className="netcore-chain">{item.note}</span>
          {item.count > 1 && <span className="netcore-count">×{item.count}</span>}
        </li>)}
      </ul>
      {hidden > 0 && <p className="netcore-detail">{text(`另有 ${hidden} 个主机未列出。`, `${hidden} more hosts not listed.`)}</p>}
    </section>}

    {view.nodes.length > 0 && <section className="netcore-block" aria-label={text("出口节点", "Exit nodes")}>
      <div className="netcore-block__head">
        <h3>{text("出口节点", "Exit nodes")}<span className="netcore-node-count">{view.nodes.length}</span>
          {activeSource && <span className="netcore-source-name">{activeSource.name}</span>}
        </h3>
        <div className="netcore-block__actions">
          <button type="button" className="repair-button repair-button--quiet" onClick={onAddSource ?? onManageSources} disabled={busy}>{text("添加配置", "Add configuration")}</button>
          <button type="button" className="repair-button repair-button--quiet" onClick={onMeasure} disabled={busy || measuring || !view.actions.canSelect}>{measuring ? text("测速中…", "Measuring…") : text("测速", "Measure")}</button>
          {onProbeExits && <button type="button" className="repair-button repair-button--quiet" onClick={onProbeExits} disabled={busy || probingExits || !view.actions.canSelect}>{probingExits ? text("检测出口中…", "Probing exits…") : text("检测出口", "Probe exits")}</button>}
        </div>
      </div>
      <p className="netcore-detail">{text("要新增或编辑节点厂商（订阅链接、文件、本机代理）：点「配置厂商」；保存后可在列表里切换、改名、更新或删除。", "To add or edit a node provider (subscription link, file, local proxy): open Providers; saved entries can be switched, renamed, refreshed or deleted.")}</p>
      {exitsAt && <p className="netcore-meta netcore-probed">{text(`出口检测于 ${clock(exitsAt)}`, `Exits probed at ${clock(exitsAt)}`)}</p>}
      {report?.ingress?.shared && <p className="netcore-detail" role="note">{text(
        `这 ${report.ingress.total} 个节点共用同一入口（${report.ingress.groups[0]?.server ?? ""}）：入口故障会全部中断，切换节点只是换端口，不产生冗余。`,
        `These ${report.ingress.total} nodes share one ingress (${report.ingress.groups[0]?.server ?? ""}): if it fails all nodes fail; switching nodes only changes the port.`,
      )}</p>}
      <ul className="netcore-nodes">
        {view.nodes.map((node) => {
          const probe = exits[node.name] ?? null;
          const nodeRegion = exitRegion(node.name, probe);
          const delayText = delays[node.name] === undefined ? "" : delays[node.name] === null ? text("超时", "Timeout") : `${delays[node.name]} ms`;
              return <li key={node.name}>
            <button type="button" className="netcore-node" aria-pressed={node.selected} disabled={busy || !view.actions.canSelect} onClick={() => onSelectNode(node.name)}>
              <span className="netcore-node__head">
                <span className="netcore-node__name">{node.name}</span>
                {node.selected && <span className="netcore-node__badge">{text("当前", "Active")}</span>}
                {!node.selected && node.auto && <span className="netcore-node__badge netcore-node__badge--auto">{text("自动", "Auto")}</span>}
              </span>
              <span className="netcore-node__state">
                {/* 延迟：未测到就留空（定时测速在后台跑，不显示「测速中」），结果回来直接覆盖；失败是死节点（超时/不可达），不能画成 0ms。 */}
                {delayText}
                {nodeRegion && <>{delayText ? " · " : ""}{nodeRegion}</>}
                {probe?.ip && <>{(delayText || nodeRegion) ? " · " : ""}{probe.ip}</>}
              </span>
            </button>
          </li>;
        })}
      </ul>
    </section>}

    {view.exitStability && <section className="netcore-block" aria-label={text("出口稳定性", "Exit stability")}>
      <div className="netcore-block__head">
        <h3>{text("出口稳定性", "Exit stability")}<span className="netcore-state-pill" data-tone={view.exitStability.stable ? "ok" : "warn"}>{view.exitStability.stable ? text("稳定", "Stable") : text("存在漂移", "Drifting")}</span></h3>
      </div>
      <p className="netcore-detail">{text(
        `近 ${view.exitStability.windowHours} 小时出口 IP 变化 ${view.exitStability.changes} 次，当前 ${view.exitStability.current ?? exitIp ?? "—"}。`,
        `Exit IP changed ${view.exitStability.changes} time(s) in the last ${view.exitStability.windowHours}h; current ${view.exitStability.current ?? exitIp ?? "—"}.`,
      )}{!view.exitStability.stable && text(" 频繁变化可能让 Claude 重新验证登录，也可能只是节点故障转移。", " Frequent changes may trigger a login re-check, or may just be node failover.")}</p>
      {(exitHistory?.ips?.length ?? 0) > 0 && <details className="netcore-history">
        <summary>{text("查看记录", "View history")}</summary>
        <ul>{exitHistory!.ips.map((ip) => <li key={ip}>{ip}{ip === exitHistory!.current ? text(" · 当前", " · current") : ""}</li>)}</ul>
      </details>}
    </section>}

    <section className="netcore-block" aria-label={text("内网直连", "Local network direct")}>
      <div className="netcore-block__head">
        <h3>{text("内网直连（VPN / 公司网络）", "Local network direct (VPN / corporate)")}</h3>
        <div className="netcore-block__actions">
          <button type="button" className="repair-button repair-button--quiet" onClick={onOpenNetworkConfig} disabled={busy}>{text("配置", "Configure")}</button>
        </div>
      </div>
      <p className="netcore-detail">{networkState?.effective
        ? exemptSummary(zh, {
          domains: networkState.config?.directDomains ?? [],
          addresses: networkState.config?.routeExcludeAddresses ?? [],
          dnsServers: networkState.config?.dnsServers ?? [],
          directInterface: networkState.config?.directInterface ?? "",
        })
        : text("内网域名、内网 DNS 与指定网卡。不配置时内网域名会被当作公网，解析失败。", "Internal domains, internal DNS and a specific NIC. Unlisted internal names are treated as public and fail to resolve.")}</p>
      {networkState?.pendingRestart && <p className="netcore-detail" data-flagged="true">{text("有改动已保存，但需要重启内核才生效。", "Saved changes need a kernel restart to take effect.")}</p>}
    </section>

    <details className="netcore-advanced">
      <summary>{text("诊断与高级操作", "Diagnostics & advanced")}</summary>
      <dl className="netcore-diagnostics">
        <div><dt>{text("内核版本", "Kernel version")}</dt><dd>{view.version ?? text("未知", "Unknown")}{view.showDemoBadge ? text(" · 演示节点", " · demo node") : ""}</dd></div>
        <div><dt>{text("本机代理", "Local proxy")}</dt><dd>{view.localProxy ?? "—"}</dd></div>
        <div><dt>{text("系统流量接管", "TUN capture")}</dt><dd>{view.tunEnabled ? text("已启用", "Enabled") : text("未启用", "Disabled")}</dd></div>
        <div><dt>{text("内核重启", "Kernel restarts")}</dt><dd>{view.restarts ?? 0}</dd></div>
        <div><dt>{text("路由采样", "Routing sample")}</dt><dd>{view.sampledAt ? clock(view.sampledAt) : "—"}</dd></div>
      </dl>
      <div className="netcore-advanced__actions">
        {view.actions.canStart && <button type="button" className="repair-button repair-button--quiet" onClick={onStart} disabled={busy}>{text("启动内核", "Start kernel")}</button>}
        {view.actions.canStop && onStop && <button type="button" className="repair-button repair-button--quiet" onClick={onStop} disabled={busy}>{text("停止内核", "Stop kernel")}</button>}
        <button type="button" className="repair-button repair-button--quiet" onClick={onRestart} disabled={busy || !view.actions.canRestart}>{text("重启内核", "Restart kernel")}</button>
      </div>
      <p className="netcore-detail">{text("重启内核或切换代理范围会中断当前 Claude 连接几秒。", "Restarting the kernel or switching proxy scope interrupts Claude connections for a few seconds.")}</p>
    </details>
  </section>;
}
