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
};

export function HostAuthorizationDialog({ locale, busy, error, onAuthorize, onClose, platform = "darwin" }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
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
        <p className="repair-caption">{text("系统级隧道", "System tunnel")}</p>
        <h2 id="host-auth-title">{text("需要一次系统授权", "One-time system authorization")}</h2>
      </div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={busy} aria-label={text("关闭", "Close")}>×</button>
    </header>
    <div className="repair-dialog__body">
      <p id="host-auth-detail" className="repair-description">
        {text(
          platform === "win32" ? "系统流量接管需要管理员权限。Windows 会显示用户账户控制（UAC）窗口，账户密码不会经过应用或本页面。" : "把系统流量接管进隧道需要一个以 root 运行的本地助手。macOS 会弹出系统密码 / Touch ID 窗口，密码不会经过应用或本页面。",
          platform === "win32" ? "System capture requires administrator privileges. Windows shows User Account Control (UAC); account passwords never pass through this app or page." : "Capturing system traffic requires a local helper running as root. macOS shows the system password / Touch ID prompt; the password never passes through the app or this page.",
        )}
      </p>
      <p className="repair-description">
        {text(
          "助手只接受固定的启动 / 停止 / 重启动作，验证配置后使用独立副本；之后可用安装器卸载。拒绝授权将保持系统接管未完成，仍可使用本机代理端口。",
          "The helper only accepts fixed start / stop / restart actions and uses a separate copy after validating configuration. It can be removed with the installer later. Declining leaves system capture incomplete; the local proxy port remains available.",
        )}
      </p>
      {error && <p className="netcore-alert" role="alert">{error}</p>}
      {busy && <p className="netcore-detail" role="status">{text("已请求系统授权，请在系统弹窗中确认…", "Requested system authorization; confirm in the system prompt…")}</p>}
    </div>
    <footer className="repair-dialog__footer">
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} disabled={busy}>{text("暂不", "Not now")}</button>
      <button type="button" className="repair-button repair-button--primary" onClick={onAuthorize} disabled={busy}>
        {busy ? text("等待授权…", "Waiting…") : text("授权并启用隧道", "Authorize & enable tunnel")}
      </button>
    </footer>
  </dialog>;
}
