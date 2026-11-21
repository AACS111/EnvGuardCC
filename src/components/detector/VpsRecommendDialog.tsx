"use client";

import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import { VPS_PROVIDERS, VPS_DISCLAIMER, type VpsProvider } from "@/detection/vps-providers";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = { locale: LocaleCode; onClose: () => void };

function ProviderCard({ provider, zh }: { provider: VpsProvider; zh: boolean }) {
  const language = zh ? "zh" : "en";
  const record = provider.assessment;
  return <article className="vps-card">
    <header className="vps-card__head">
      <div><h3>{provider.name}</h3><span className="vps-domain">{provider.domain}</span></div>
      <span className="vps-tag">{zh ? "官网标称" : "Vendor claim"}</span>
    </header>
    <p className="vps-card__summary">{provider.summary[language]}</p>
    <section className="vps-block" aria-label={zh ? "ISP 产品示例" : "ISP product example"}>
      <h4>{zh ? "ISP 产品示例 · 官网标称" : "ISP product example · vendor claim"}</h4>
      <strong>{provider.product.title[language]}</strong>
      <ul>{provider.product.specs.map((spec) => <li key={spec.en}>{spec[language]}</li>)}</ul>
      <span className="vps-price">{provider.product.price[language]}</span>
    </section>
    <section className="vps-block vps-block--measured" aria-label={zh ? "实测体验" : "Test results"}>
      <h4>{zh ? "实测体验" : "Test results"}<span className="vps-tag vps-tag--measured">{zh ? "匿名样本" : "Anonymous sample"}</span></h4>
      <dl className="vps-metrics">
        <div><dt>{zh ? "数据库定位" : "Database location"}</dt><dd>{record.location[language]}</dd></div>
        <div><dt>{zh ? "运营商" : "Operator"}</dt><dd>{record.operator}</dd></div>
        <div><dt>ASN</dt><dd>AS{record.asn}</dd></div>
        <div><dt>{zh ? "ICMP 平均" : "Avg ICMP"}</dt><dd>{record.averageMs.toFixed(1)} ms</dd></div>
        <div><dt>{zh ? "延迟范围" : "Latency range"}</dt><dd>{record.minMs}–{record.maxMs} ms</dd></div>
        <div><dt>{zh ? "应答次数" : "Replies"}</dt><dd>{record.received}/{record.sent}</dd></div>
        <div><dt>{zh ? "超时次数" : "Timeouts"}</dt><dd>{record.timeouts}</dd></div>
      </dl>
    </section>
    <p className="vps-note">{provider.note[language]}</p>
    <footer className="vps-card__foot">
      <a className="repair-button" href={provider.website} target="_blank" rel="noopener noreferrer sponsored">{zh ? "访问官网" : "Visit site"} ↗</a>
    </footer>
  </article>;
}

export function VpsRecommendDialog({ locale, onClose }: Props) {
  const zh = locale.startsWith("zh");
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ message: string; failed?: boolean } | null>(null);

  const exportScript = async () => {
    if (saving) return;
    setNotice(null);
    const desktop = window.envGuardDesktop;
    if (!desktop) {
      const link = document.createElement("a");
      link.href = "/install-node.sh";
      link.download = "install-node.sh";
      document.body.append(link);
      link.click();
      link.remove();
      setNotice({ message: zh ? "已请求下载，请查看浏览器下载列表。" : "Download requested. Check your browser’s downloads." });
      return;
    }
    setSaving(true);
    try {
      if (!desktop.exportNodeSetupScript) {
        setNotice({ message: zh ? "请更新桌面版后再导出脚本。" : "Update the desktop app to export the script.", failed: true });
        return;
      }
      const { saved } = await desktop.exportNodeSetupScript();
      setNotice({ message: saved
        ? (zh ? "脚本已保存。" : "Script saved.")
        : (zh ? "已取消保存。" : "Save canceled.") });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice({ message: (zh ? "无法保存脚本。" : "Could not save the script.") + (detail ? ` ${detail}` : ""), failed: true });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    if (element && !element.open) element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const checkedAt = VPS_PROVIDERS[0].assessment.checkedAt;
  const formattedAt = new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(checkedAt));

  return <dialog ref={dialog} className="repair-dialog vps-dialog" aria-labelledby="vps-title" aria-describedby="vps-description"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={(event) => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <div>
        <h2 id="vps-title">{zh ? "自建节点推荐" : "Self-host a node"}</h2>
        <p id="vps-description" className="repair-caption">{zh
          ? "想用自己的固定出口？选购厂商标称的 ISP IP 套餐，开通服务器后用脚本搭建自己的节点。"
          : "Want your own fixed exit? Browse vendor-listed ISP IP plans, then use the setup script on your server."}</p>
      </div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} aria-label={zh ? "关闭厂商推荐" : "Close provider recommendations"}>×</button>
    </header>
    <div className="repair-dialog__body">
      <div className="vps-grid">{VPS_PROVIDERS.map((provider) => <ProviderCard key={provider.id} provider={provider} zh={zh} />)}</div>
      <section className="vps-setup" aria-labelledby="vps-setup-title">
        <div>
          <h3 id="vps-setup-title">{zh ? "已有服务器？开始搭建" : "Already have a server? Set up your node"}</h3>
          <p>{zh
            ? "将脚本上传到 Debian 11+ 或 Ubuntu 22.04+ 服务器，以管理员权限运行下面的命令，再将生成的 YAML 导入 EnvGuardCC。"
            : "Upload the script to a Debian 11+ or Ubuntu 22.04+ server, run the command as an administrator, then import the generated YAML into EnvGuardCC."}</p>
          <code>sudo bash install-node.sh</code>
        </div>
        <button type="button" className="repair-button repair-button--primary" disabled={saving} onClick={() => void exportScript()}>
          {saving ? (zh ? "正在保存…" : "Saving…") : (zh ? "导出搭建脚本" : "Download setup script")}
        </button>
        {notice && <p className="vps-export-notice" role={notice.failed ? "alert" : "status"}>{notice.message}</p>}
      </section>
      <div className="vps-toolbar">
        <span className="vps-muted">{zh ? "历史采样时间" : "Historical sample time"}：<time dateTime={checkedAt}>{formattedAt} UTC</time></span>
        <span className="vps-muted">{zh ? "每个样本 20 次 ICMP · 不代表当前网络表现" : "20 ICMP probes per sample · not current network performance"}</span>
      </div>
      <p className="vps-disclaimer">{VPS_DISCLAIMER[zh ? "zh" : "en"]}</p>
    </div>
  </dialog>;
}
