"use client";
import { useState } from 'react';
import type { LocaleCode } from '@/i18n/messages';
import type { NetCoreNetworkState, NetCoreReport } from '@/detection/gateway-check';
import { netCoreView } from '@/detection/net-core-view.mjs';
import { ConnectionLogSettings } from './ConnectionLogSettings';
import { exemptSummary } from './NetworkExemptDialog';

export type NetCoreSettingsProps = {
  locale: LocaleCode; report: NetCoreReport | null; busy: boolean; error?: string;
  tunnelLocked: boolean; networkState?: NetCoreNetworkState | null;
  onStart: () => void; onStop?: () => void; onRestart: () => void;
  onTunnelChange?: (enabled: boolean) => void; onStrictChange?: (enabled: boolean) => void;
  onNetworkFailureChange?: (policy: "claude" | "all") => void;
  onManageSources: () => void; onAddSource?: () => void; onOpenNetworkConfig: () => void; onAuthorizeHost?: () => void;
};
const clock = (value: string | null) => value ? new Date(value).toLocaleTimeString([], { hour12: false }) : '—';

export function NetCoreSettings({ locale, report, busy, error, tunnelLocked, networkState, onStart, onStop, onRestart, onTunnelChange, onStrictChange, onNetworkFailureChange, onManageSources, onAddSource, onOpenNetworkConfig, onAuthorizeHost, advanced = false }: NetCoreSettingsProps & { advanced?: boolean }) {
  const zh = locale.startsWith('zh');
  const text = (cn: string, en: string) => zh ? cn : en;
  const view = netCoreView(report, { locale });
  const [confirmStrict, setConfirmStrict] = useState(false);
  const strict = report?.strictMode === true || report?.guard?.armed === true;
  const activeSource = report?.sources?.find(source => source.id === report.activeId) ?? report?.sources?.[0];
  if (advanced) return <>
    <section className="workspace-settings-group">
      <h3>{text("诊断与内核维护", "Diagnostics and kernel maintenance")}</h3>
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
      <p className="netcore-detail">{text("重启内核会中断连接；切换代理范围使用热加载，已有连接可能沿用原路径。", "Restarting the kernel interrupts connections; scope switches reload rules while existing connections may keep their original routes.")}</p>
    </section>
    {error && <p className="netcore-alert" role="alert">{error}</p>}
  </>;
  return <>
    <section className="workspace-settings-group">
      <div className="workspace-settings-group__heading"><div><h3>{text('节点与配置来源', 'Nodes and configuration sources')}</h3><p>{activeSource ? text(`当前配置：${activeSource.name}`, `Current configuration: ${activeSource.name}`) : text('添加自己的订阅、配置文件、节点或本机代理。', 'Add your own subscription, configuration, nodes or local proxy.')}</p></div><div className="netcore-block__actions"><button type="button" className="repair-button" disabled={busy} aria-haspopup="dialog" onClick={onManageSources}>{text('管理配置', 'Manage configuration')}</button><button type="button" className="repair-button repair-button--primary" disabled={busy} aria-haspopup="dialog" onClick={onAddSource ?? onManageSources}>{text('添加配置', 'Add configuration')}</button></div></div>
    </section>
    <section className="workspace-settings-group" aria-label={text("内网直连", "Local network direct")}>
      <div className="netcore-block__head">
        <h3>{text("内网直连（VPN / 公司网络）", "Local network direct (VPN / corporate)")}</h3>
        <div className="netcore-block__actions">
          <button type="button" className="repair-button repair-button--quiet" aria-haspopup="dialog" onClick={onOpenNetworkConfig} disabled={busy}>{text("配置", "Configure")}</button>
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

    <ConnectionLogSettings locale={locale} busy={busy} />
    <section className="workspace-settings-group"><h3>{text('连接保护', 'Connection protection')}</h3>
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

      {onNetworkFailureChange && <section className="netcore-block" aria-label={text("网络异常时的处置", "Behavior on network failure")}>
        <div className="netcore-block__head">
          <h3>{text("网络异常时", "On network failure")}</h3>
          <div className="netcore-modes" role="group" aria-label={text("网络异常时的处置", "Behavior on network failure")}>
            <button type="button" className="netcore-mode" aria-pressed={(report?.networkFailurePolicy ?? 'claude') === 'claude'} disabled={busy} onClick={() => onNetworkFailureChange('claude')}>{text("仅阻断 Claude", "Claude only")}</button>
            <button type="button" className="netcore-mode" aria-pressed={report?.networkFailurePolicy === 'all'} disabled={busy} onClick={() => onNetworkFailureChange('all')}>{text("阻断全部网络", "Block all")}</button>
          </div>
        </div>
        <p className="netcore-detail">{text("默认只拒绝 Claude 域名，直连与其他代理出口不受影响；断开后 3 分钟内每 5 秒自动复检，一恢复就立即解除。选择「阻断全部网络」才使用严格断流封禁其他流量。", "By default only Claude domains are rejected; direct and other proxy traffic keeps working. After a drop it re-probes every 5 seconds for 3 minutes and unlocks as soon as the network returns. Choose \"Block all\" to engage the strict kill switch.")}</p>
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
        <p className="netcore-detail">{text('将全部出站流量固定到一个节点，阻断其他网络路径。仅支持兼容的 macOS 防火墙环境。', 'Pin all outbound traffic to one node and block other paths. Requires a compatible macOS firewall environment.')}</p>
        <p className="netcore-detail">{text('使用效果：其他直连与普通内网连接将被阻断。出口异常时按上方「网络异常时」设置处理，默认只阻断 Claude。', 'Effect: other direct and ordinary LAN connections are blocked. Exit failures follow the "On network failure" setting above; the default only blocks Claude.')}</p>
        {strict && <p className="netcore-detail" role="status">{report?.guard?.phase === 'active' && report.capabilities?.strictTravel ? text('系统阻断与隧道已核验。', 'System filter and tunnel verified.') : text('严格模式正在阻断或尚未验证；请复检，或关闭严格模式恢复联网。', 'Strict mode is blocking or unverified; recheck, or disable strict mode to restore networking.')}</p>}
        {strict && <p className="netcore-detail">{text("退出应用或异常崩溃后仍保留阻断。也可在终端运行 sudo /Library/PrivilegedHelperTools/com.envguardcc.kernel-recover 恢复联网。", "Blocking remains after quitting or crashing. To recover from Terminal, run sudo /Library/PrivilegedHelperTools/com.envguardcc.kernel-recover.")}</p>}
        {confirmStrict && !strict && <div className="netcore-confirm" role="alert">
          <span>{text("开启会重连当前网络连接，阻断内网及其他直连流量。退出应用后也保持阻断，必须明确关闭或使用恢复工具解除。仅在兼容的 macOS 防火墙布局下启用；不保证第三方服务资格或账号结果。", "Enabling reconnects existing connections and blocks LAN and other direct traffic. Blocking remains after quitting until explicitly disabled or recovered. Requires a compatible macOS firewall layout; it does not guarantee service eligibility or account outcomes.")}</span>
          <div className="netcore-confirm__actions"><button type="button" className="repair-button repair-button--quiet" onClick={() => setConfirmStrict(false)}>{text("取消", "Cancel")}</button><button type="button" className="repair-button" onClick={() => { setConfirmStrict(false); onStrictChange(true); }}>{text("确认开启", "Confirm")}</button></div>
        </div>}
      </section>}

    </section>
    {view.tunHint && <div className="netcore-alert" role="status">{view.tunHint}{onAuthorizeHost && ['darwin', 'win32'].includes(view.platform ?? '') && view.hostMode === false && view.elevated === false && <button type="button" className="repair-button netcore-authorize" onClick={onAuthorizeHost} disabled={busy}>{text('授权安装特权助手', 'Authorize helper')}</button>}</div>}
    {error && <p className="netcore-alert" role="alert">{error}</p>}
  </>;
}
