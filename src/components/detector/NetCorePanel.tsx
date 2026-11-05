"use client";
// 网络内核面板：方向 4（不对称仪表盘）——只有一张"出口结论"卡占主导，
// 其余信息压缩成一条指标细条与无容器的列表，避免三张等宽卡片平分注意力。
import type { LocaleCode } from "@/i18n/messages";
import type { ExitHistory, NetCoreNetworkState, NetCoreReport } from "@/detection/gateway-check";
import { netCoreView, visibleViolations } from "@/detection/net-core-view.mjs";
import { exemptSummary } from "./NetworkExemptDialog";

type Props = {
  locale: LocaleCode;
  report: NetCoreReport | null;
  busy?: boolean;
  error?: string;
  onRefresh: () => void;
  onRestart: () => void;
  onSelectNode: (name: string) => void;
  onAddConfig: () => void;
  onEditConfig?: () => void;
  onRefreshSubscription: () => void;
  onMeasure: () => void;
  onOpenNetworkConfig: () => void;
  networkState?: NetCoreNetworkState | null;
  measuring?: boolean;
  delays?: Record<string, number | null>;
  exits?: Record<string, { countryCode: string | null; country: string | null; ip: string | null } | null>;
  onProbeExits?: () => void;
  probingExits?: boolean;
  onModeChange: (mode: "claude" | "rule" | "global" | "direct") => void;
  exitHistory?: ExitHistory | null;
};

const MODES = [
  { id: "rule", cn: "规则", en: "Rule", cnHint: "海外走节点，国内直连", enHint: "Overseas via node, domestic direct" },
  { id: "global", cn: "全局", en: "Global", cnHint: "全部流量走节点", enHint: "All traffic via node" },
  { id: "direct", cn: "直连", en: "Direct", cnHint: "不接管任何流量", enHint: "No traffic through node" },
  { id: "claude", cn: "仅 Claude", en: "Claude only", cnHint: "只优化 Claude 域名", enHint: "Only Claude domains" },
] as const;

const clock = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour12: false }) : "—";

// 节点名里通常已经带了地区（如 HKHong Kong 01）；出口地区与名字一致时就不再重复显示，只在不一致时补上。
const exitRegion = (name: string, exit: { countryCode: string | null; country: string | null } | null | undefined) => {
  const region = exit?.country ?? exit?.countryCode ?? "";
  if (!region) return "";
  return name.toLowerCase().includes(region.toLowerCase()) ? "" : region;
};

export function NetCorePanel({ locale, report, busy = false, error, onRefresh, onRestart, onSelectNode, onAddConfig, onEditConfig, onRefreshSubscription, onMeasure, measuring = false, delays = {}, exits = {}, onProbeExits, probingExits = false, onModeChange, exitHistory = null, onOpenNetworkConfig, networkState = null }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => zh ? cn : en;
  const view = netCoreView(report, { locale, exitHistory });
  const { items: violations, hidden } = visibleViolations(view, 20);

  return <section className="netcore" aria-label={text("网络内核", "Network kernel")}>
    <div className="netcore-conclusion" data-tone={view.conclusion.tone}>
      <div className="netcore-conclusion__body">
        <p className="netcore-eyebrow">{text("出口结论", "Exit conclusion")}</p>
        <h2>{view.conclusion.title}</h2>
        {view.conclusion.detail && <p className="netcore-detail">{view.conclusion.detail}</p>}
        <p className="netcore-meta">
          {view.version ? <span>{text("内核 ", "Kernel ")}{view.version}</span> : <span>{text("内核版本未知", "Kernel version unknown")}</span>}
          <span>{view.tunEnabled ? text("TUN 已接管", "TUN capturing") : text("TUN 未接管", "TUN not capturing")}</span>
          {view.showDemoBadge && <span className="netcore-demo">{text("演示节点", "Demo node")}</span>}
          {view.localProxy && <span>{text("本机代理 ", "Local proxy ")}{view.localProxy}</span>}
          {view.sampledAt && <span>{text("采样 ", "Sampled ")}{clock(view.sampledAt)}</span>}
        </p>
      </div>
      <div className="netcore-conclusion__state">
        <span className="netcore-badge" data-tone={view.tone}>{view.label}</span>
        <div className="netcore-actions">
          <button type="button" className="repair-button repair-button--quiet" onClick={onRefresh} disabled={busy}>{text("复检路由", "Recheck routing")}</button>
          <button type="button" className="repair-button repair-button--quiet" onClick={onRestart} disabled={busy || !view.actions.canRestart}>{text("重启内核", "Restart kernel")}</button>
        </div>
      </div>
    </div>

    <div className="netcore-modes" role="group" aria-label={text("出站模式", "Egress mode")}>
      <span className="netcore-modes__label">{text("出站模式", "Egress mode")}</span>
      {MODES.map((item) => <button key={item.id} type="button" className="netcore-mode" aria-pressed={view.mode === item.id} disabled={busy} title={text(item.cnHint, item.enHint)} onClick={() => onModeChange(item.id)}>{text(item.cn, item.en)}</button>)}
      <span className="netcore-modes__hint">{(zh ? MODES.find((item) => item.id === view.mode)?.cnHint : MODES.find((item) => item.id === view.mode)?.enHint) ?? text("未设置", "Not set")}</span>
    </div>
    {view.metrics.length > 0 && <dl className="netcore-strip">
      {view.metrics.map((metric) => <div key={metric.id} data-metric={metric.id} data-flagged={metric.id === "direct" && Number(metric.value) > 0}>
        <dt>{metric.label}</dt>
        <dd>{metric.value}</dd>
      </div>)}
    </dl>}

    {view.tunHint && <p className="netcore-alert" role="status">{view.tunHint}</p>}
    {error && <p className="netcore-alert" role="alert">{error}</p>}

    {view.empty && <div className="netcore-empty">
      <p>{view.empty.title}</p>
      <p className="netcore-detail">{view.empty.detail}</p>
      <button type="button" className="repair-button" onClick={onAddConfig} disabled={busy}>{text("添加配置", "Add configuration")}</button>{onEditConfig && <button type="button" className="repair-button repair-button--quiet" onClick={onEditConfig} disabled={busy}>{text("修改配置", "Edit configuration")}</button>}
    </div>}

    {view.source && <p className="netcore-meta netcore-source">
      <span>{view.source.mode === "url" ? text("订阅", "Subscription") : text("来源", "Source")}</span>
      {view.source.url && <span className="netcore-url" title={view.source.url}>{view.source.url}</span>}
      {view.source.updatedAt && <span>{text("更新 ", "Updated ")}{new Date(view.source.updatedAt).toLocaleString()}</span>}
      <button type="button" className="repair-button repair-button--quiet" onClick={onRefreshSubscription} disabled={busy}>{text("立即更新", "Update now")}</button>
    </p>}

    {view.exitStability && <p className="netcore-meta" data-flagged={!view.exitStability.stable}>
      <span>{text(`出口 IP ${view.exitStability.windowHours}h 内变化 ${view.exitStability.changes} 次`, `Exit IP changed ${view.exitStability.changes} time(s) in ${view.exitStability.windowHours}h`)}</span>
      <span>{view.exitStability.stable ? text("稳定", "Stable") : text("存在漂移", "Drifting")}</span>
    </p>}

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
      <h3>{text("出口节点", "Exit nodes")}<button type="button" className="repair-button repair-button--quiet netcore-measure" onClick={onMeasure} disabled={busy || measuring || !view.actions.canSelect}>{measuring ? text("测速中…", "Measuring…") : text("测速", "Measure")}</button>{onProbeExits && <button type="button" className="repair-button repair-button--quiet" onClick={onProbeExits} disabled={busy || probingExits || !view.actions.canSelect}>{probingExits ? text("检测出口中…", "Probing exits…") : text("检测出口", "Probe exits")}</button>}<button type="button" className="repair-button repair-button--quiet netcore-add" onClick={onAddConfig} disabled={busy}>{text("添加配置", "Add configuration")}</button></h3>
      {report?.ingress?.shared && <p className="netcore-detail" role="note">{text(
        `这 ${report.ingress.total} 个节点共用同一入口（${report.ingress.groups[0]?.server ?? ""}）：入口故障会全部中断，切换节点只是换端口，不产生冗余。`,
        `These ${report.ingress.total} nodes share one ingress (${report.ingress.groups[0]?.server ?? ""}): if it fails all nodes fail; switching nodes only changes the port.`,
      )}</p>}
      <ul className="netcore-nodes">
        {view.nodes.map((node) => {
          const region = exitRegion(node.name, exits[node.name]);
          return <li key={node.name}>
            <button type="button" className="netcore-node" aria-pressed={node.selected} disabled={busy || !view.actions.canSelect} onClick={() => onSelectNode(node.name)}>
              <span>{node.name}</span>
              <span className="netcore-node__state">
                {/* 延迟：未测到就留空（定时测速在后台跑，不显示「测速中」），结果回来直接覆盖；失败是死节点（超时/不可达），不能画成 0ms。 */}
                {delays[node.name] === undefined ? "" : delays[node.name] === null ? text("超时", "Timeout") : `${delays[node.name]} ms`}
                {region ? ` · ${region}` : ""}{node.selected ? text(" · 当前", " · Active") : ""}{node.auto && node.name !== view.selected ? text(" · 自动", " · Auto") : ""}</span>
            </button>
          </li>;
        })}
      </ul>
    </section>}

    <section className="netcore-block" aria-label={text("内网直连", "Local network direct")}>
      <h3>{text("内网直连（VPN / 公司网络）", "Local network direct (VPN / corporate)")}<button type="button" className="repair-button repair-button--quiet netcore-add" onClick={onOpenNetworkConfig} disabled={busy}>{text("配置", "Configure")}</button></h3>
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
  </section>;
}
