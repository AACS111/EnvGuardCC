"use client";
// 网络页展示出口证据和常用操作；低频配置统一由设置弹窗管理。
import { useId, useState, type Ref } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type { ExitHistory, NetCoreExit, NetCoreReport } from "@/detection/gateway-check";
import { netCoreView, visibleViolations } from "@/detection/net-core-view.mjs";
import { claudeRegionSupport } from "@/detection/claude-regions.mjs";
import { describeExit } from "@/detection/exit-quality.mjs";
import { countryDisplayName } from "@/detection/exit-geo";
import { TransferLog, type TransferLogHandle } from "./TransferLog";

type Props = {
  locale: LocaleCode;
  report: NetCoreReport | null;
  visible?: boolean;
  transferLogRef?: Ref<TransferLogHandle>;
  busy?: boolean;
  error?: string;
  onRefresh: () => void;
  onOpenSettings?: () => void;
  onRestart: () => void;
  onSelectNode: (name: string) => void;
  onMeasure: () => void;
  measuring?: boolean;
  delays?: Record<string, number | null>;
  exits?: Record<string, NetCoreExit | null>;
  exitsAt?: string | null;
  onProbeExits?: () => void;
  probingExits?: boolean;
  onModeChange: (mode: "rule" | "global" | "direct") => void;
  exitHistory?: ExitHistory | null;
};

type Mode = "rule" | "global" | "direct";

const MODES: Array<{ id: Mode; cn: string; en: string; cnHint: string; enHint: string }> = [
  { id: "rule", cn: "规则", en: "Rule", cnHint: "海外走节点，国内直连", enHint: "Overseas via node, domestic direct" },
  { id: "global", cn: "全局", en: "Global", cnHint: "除内网豁免外走节点", enHint: "Via nodes except local exemptions" },
  { id: "direct", cn: "其他直连", en: "Others direct", cnHint: "Claude 仍走固定出口，其他流量直连", enHint: "Claude stays on its pinned exit; other traffic is direct" },
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
  locale, report, busy = false, error, onRefresh, onRestart, onSelectNode, onOpenSettings,
  onMeasure, measuring = false, delays = {}, exits = {}, exitsAt = null, onProbeExits, probingExits = false,
  onModeChange, exitHistory = null, visible = true, transferLogRef,
}: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => zh ? cn : en;
  const view = netCoreView(report, { locale, exitHistory });
  const { items: violations, hidden } = visibleViolations(view, 20);
  // 代理范围会影响新连接的路由；确认后热加载，已有连接可能沿用原路径。
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const measureHelpId = useId();
  const exitHelpId = useId();
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
        {view.showDemoBadge && <span className="netcore-badge" data-tone="warn">{text("演示节点", "Demo node")}</span>}
        {view.tone !== "ok" && <span className="netcore-badge" data-tone={view.tone}>{view.label}</span>}
        <div className="netcore-actions">
          <button type="button" className="repair-button repair-button--quiet" aria-haspopup="dialog" onClick={onOpenSettings}>{text("网络设置", "Network settings")}</button>
          <button type="button" className="repair-button" onClick={strict && !report?.capabilities?.strictTravel ? onRestart : onRefresh} disabled={busy}>{text("复检路由", "Recheck routing")}</button>
        </div>
      </div>
    </div>

    {view.tunHint && <p className="netcore-alert" role="status">{view.tunHint}<button type="button" className="workspace-text-link" onClick={onOpenSettings} aria-haspopup="dialog">{text('前往网络设置', 'Open network settings')} →</button></p>}
    {error && <p className="netcore-alert" role="alert">{error}</p>}

    {view.empty && view.nodes.length === 0 && <div className="netcore-empty">
      <p>{view.empty.title}</p>
      <p className="netcore-detail">{view.empty.detail}</p>
      <button type="button" className="repair-button" onClick={onOpenSettings} aria-haspopup="dialog" disabled={busy}>{text("前往设置添加配置", "Add configuration in settings")}</button>
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

    <div className="netcore-columns">
      <div className="netcore-stack">
        <section className="netcore-block netcore-scope">
          <div className="netcore-modes" role="group" aria-label={text("出站模式", "Egress mode")}>
            <span className="netcore-modes__label">{text("代理范围", "Proxy scope")}</span>
            {MODES.map((item) => <button key={item.id} type="button" className="netcore-mode" aria-pressed={view.mode === item.id} disabled={busy || strict}
              title={text(item.cnHint, item.enHint)}
              onClick={() => { if (item.id !== view.mode) setPendingMode(item.id); }}>{text(item.cn, item.en)}</button>)}
          </div>
          <p className="netcore-mode-hint">{view.mode === "rule" ? text("海外站点（含 Claude）走节点，国内直连。", "Overseas sites (incl. Claude) use the node; domestic traffic is direct.") : modeHint ? text(modeHint.cnHint, modeHint.enHint) : text("未设置", "Not set")}</p>
          {pending && <div className="netcore-confirm" role="alert">
            <span>{text(`切换到「${pending.cn}」后，新连接按新范围路由，已有连接可能沿用原路径。`, `After switching to "${pending.en}", new connections use the new scope; existing connections may keep their original routes.`)}</span>
            <div className="netcore-confirm__actions">
              <button type="button" className="repair-button repair-button--quiet" onClick={() => setPendingMode(null)}>{text("取消", "Cancel")}</button>
              <button type="button" className="repair-button" onClick={() => { const next = pendingMode; setPendingMode(null); if (next) onModeChange(next); }}>{text("确认切换", "Switch")}</button>
            </div>
          </div>}

        </section>

        {view.nodes.length > 0 && <section className="netcore-block" aria-label={text("出口节点", "Exit nodes")}>
          <div className="netcore-block__head">
            <h3>{text("出口节点", "Exit nodes")}<span className="netcore-node-count">{view.nodes.length}</span>
              {activeSource && <span className="netcore-source-name">{activeSource.name}</span>}
            </h3>
            <div className="netcore-block__actions netcore-probe-actions">
              <span className="netcore-action-help"><button type="button" className="repair-button repair-button--quiet" aria-describedby={measureHelpId} onClick={onMeasure} disabled={busy || measuring || !view.actions.canSelect}>{measuring ? text("测速中…", "Measuring…") : text("测速", "Measure")}</button><span id={measureHelpId} role="tooltip" className="netcore-action-tooltip">{text('测量节点访问检测地址的响应延迟（毫秒），用于比较连接快慢，不是下载带宽测速。', 'Measure response latency to a test endpoint in milliseconds to compare nodes. This is not a download bandwidth test.')}</span></span>
              {onProbeExits && <span className="netcore-action-help"><button type="button" className="repair-button repair-button--quiet" aria-describedby={exitHelpId} onClick={onProbeExits} disabled={busy || probingExits || !view.actions.canSelect}>{probingExits ? text("检测出口中…", "Probing exits…") : text("检测出口", "Probe exits")}</button><span id={exitHelpId} role="tooltip" className="netcore-action-tooltip">{text('通过各节点查询实际出口 IP 与地区，完成后显示在节点卡片中；不以节点名称推断。', 'Query each node’s actual exit IP and region and show them on its card. The node name is not used to infer its exit.')}</span></span>}
            </div>
          </div>
          {exitsAt && <p className="netcore-meta netcore-probed">{text(`出口检测于 ${clock(exitsAt)}`, `Exits probed at ${clock(exitsAt)}`)}</p>}
          {report?.ingress?.shared && <p className="netcore-detail" role="note">{text(
            `这 ${report.ingress.total} 个节点共用同一入口（${report.ingress.groups[0]?.server ?? ""}）：入口故障会全部中断，切换节点只是换端口，不产生冗余。`,
            `These ${report.ingress.total} nodes share one ingress (${report.ingress.groups[0]?.server ?? ""}): if it fails all nodes fail; switching nodes only changes the port.`,
          )}</p>}
          <ul className="netcore-nodes">
            {view.nodes.map((node) => {
              const probe = exits[node.name] ?? null;
              const nodeRegion = exitRegion(node.name, probe);
              const measuredRegion = probe?.countryCode ? countryDisplayName(probe.countryCode, locale) : probe?.country;
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
                    {!exitsAt && nodeRegion && <>{delayText ? " · " : ""}{nodeRegion}</>}
                    {!exitsAt && probe?.ip && <>{(delayText || nodeRegion) ? " · " : ""}{probe.ip}</>}
                  </span>
                  {exitsAt && <span className="netcore-node__exit" data-state={probe?.ip ? 'measured' : 'unavailable'}>
                    <span><span>{text('出口 IP', 'Exit IP')}</span><span>{probe?.ip || text('未测得', 'Not measured')}</span></span>
                    <span><span>{text('出口地区', 'Exit region')}</span><span>{measuredRegion || text('未测得', 'Not measured')}</span></span>
                    {!probe?.ip && <span className="netcore-node__exit-note">{text('本次未取得出口 IP，请重试检测。', 'No exit IP was returned. Retry the probe.')}</span>}
                  </span>}
                </button>
              </li>;
            })}
          </ul>
        </section>}

      </div>
      <div className="netcore-stack">
        <TransferLog locale={locale} visible={visible} controllerRef={transferLogRef} />
        <section className="netcore-block" aria-label={text('连接保护', 'Connection protection')}>
          <div className="netcore-block__head"><h3>{text('连接保护', 'Connection protection')}</h3></div>
          <dl className="workspace-fields">
            <div><dt>{text('系统流量接管', 'System traffic capture')}</dt><dd>{view.tunCaptured === true ? text('已接管', 'Captured') : view.tunEnabled ? text('待确认', 'Unverified') : text('未启用', 'Disabled')}</dd></div>
            <div><dt>{text('严格连接保护', 'Strict connection protection')}</dt><dd>{strict ? text('已开启', 'Enabled') : text('未开启', 'Off')}</dd></div>
          </dl>
          {strict && <p className="netcore-detail" role="status">{report?.guard?.phase === 'active' && report.capabilities?.strictTravel ? text('系统阻断与隧道已核验。', 'System filter and tunnel verified.') : text('严格模式正在阻断或尚未验证；请复检或在设置中恢复联网。', 'Strict mode is blocking or unverified; recheck or restore networking in settings.')}</p>}
          {report?.capabilities?.systemKillSwitch === false && !strict && <p className="netcore-detail" role="note">{text('系统断流阻断未开启，内核异常退出后可能恢复直连。', 'System kill switch is off; traffic may go direct after a kernel failure.')}</p>}
        </section>
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

      </div>
    </div>

  </section>;
}
