"use client";
// 系统级隧道授权：TUN 需要 root 才能创建，macOS 用系统密码 / Touch ID 弹窗授权安装特权助手。
// 这里只解释与确认，密码输入与校验完全在系统窗口完成，不经过应用或页面。
import { useEffect, useRef } from "react";
import type { LocaleCode } from "@/i18n/messages";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = {
  locale: LocaleCode;
  busy: boolean;
  error: string;
  onAuthorize: () => void;
  onClose: () => void;
  platform?: string;
  mode?: 'host' | 'firewall';
};

export function HostAuthorizationDialog({ locale, busy, error, onAuthorize, onClose, platform = "darwin", mode = 'host' }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const firewall = mode === 'firewall';
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);

  return <dialog
    ref={dialog}
    className="repair-dialog"
    aria-labelledby="host-auth-title"
    aria-describedby="host-auth-detail"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onPointerDown={(event) => { backdropPointerDown.current = !busy && isDialogBackdropEvent(event); }}
    onClick={(event) => { const dismiss = backdropPointerDown.current && !busy && isDialogBackdropEvent(event); backdropPointerDown.current = false; if (dismiss) onClose(); }}
  >
    <header className="repair-dialog__header">
      <div>
        <p className="repair-caption">{firewall ? text('防止 Claude 直连', 'Prevent Claude direct connections') : text("系统级隧道", "System tunnel")}</p>
        <h2 id="host-auth-title">{firewall ? text('开启 Windows 防火墙？', 'Enable Windows Firewall?') : text("需要一次系统授权", "One-time system authorization")}</h2>
      </div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={busy} aria-label={text("关闭", "Close")}>×</button>
    </header>
    <div className="repair-dialog__body">
      <p id="host-auth-detail" className="repair-description">
        {firewall ? text('防火墙当前未开启，无法在内核重启时阻止 Claude 直连。确认后将启动 Windows 防火墙服务，并开启域网络、专用网络和公用网络的防火墙。', 'Windows Firewall is off, so Claude direct traffic cannot be blocked during a kernel restart. Confirming starts the firewall service and enables the Domain, Private and Public profiles.') : text(
          platform === "win32" ? "首次启用需要通过 Windows 用户账户控制（UAC）安装系统助手。安装后助手随系统启动，之后可用普通权限打开应用、启停保护，无需每次授权。账户密码不会经过应用或本页面。" : "把系统流量接管进隧道需要一个以 root 运行的本地助手。macOS 会弹出系统密码 / Touch ID 窗口，密码不会经过应用或本页面。",
          platform === "win32" ? "First-time setup uses Windows User Account Control (UAC) to install a system helper. The helper starts with Windows; subsequent app launches and protection controls work without administrator prompts. Account passwords never pass through this app or page." : "Capturing system traffic requires a local helper running as root. macOS shows the system password / Touch ID prompt; the password never passes through the app or this page.",
        )}
      </p>
      <p className="repair-description">
        {firewall ? text('这是系统范围的设置，可能影响其他应用的联网。退出 EnvGuardCC 后防火墙仍保持开启，可在 Windows 安全中心调整。核验成功后会重试刚才的保护操作；暂不允许则保持保护未完成。', 'This system-wide setting may affect other applications. The firewall stays enabled after EnvGuardCC exits and can be changed in Windows Security. After verification, the pending protection action is retried. Declining leaves protection incomplete.') : text(
          "仅当助手被卸载、权限失效或需要升级时才再次授权；短暂无响应不会反复弹出授权。助手只接受经过认证的固定网络管理操作，可用安装器卸载。拒绝授权将保持系统接管未完成。",
          "Authorization is needed again only if the helper is removed, its permissions become invalid, or an upgrade is required. Temporary unresponsiveness does not trigger repeated prompts. The helper accepts only authenticated, fixed network-management operations and can be removed with the installer. Declining leaves system capture incomplete.",
        )}
      </p>
      {error && <p className="netcore-alert" role="alert">{error}</p>}
      {busy && <p className="netcore-detail" role="status">{firewall ? text('正在开启并核验防火墙，然后恢复保护…', 'Enabling and verifying the firewall, then resuming protection…') : text("已请求系统授权，请在系统弹窗中确认…", "Requested system authorization; confirm in the system prompt…")}</p>}
    </div>
    <footer className="repair-dialog__footer">
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={busy}>{text("暂不", "Not now")}</button>
      <button type="button" className="repair-button repair-button--primary" onClick={onAuthorize} disabled={busy}>
        {busy ? text("处理中…", "Working…") : firewall ? text('确认开启并继续', 'Enable and continue') : text("授权并启用隧道", "Authorize & enable tunnel")}
      </button>
    </footer>
  </dialog>;
}
