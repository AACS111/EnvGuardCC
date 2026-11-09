"use client";
// 本地浏览器清单：识别已安装的浏览器，让用户决定哪些不接入。
// 边界必须说清：接入的是「受管实例」（独立配置目录 + 调试端口），不是接管你正在用的那个窗口。
import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type { BrowserCatalog } from "@/detection/environment-runtime";
import { readBrowsers, saveBrowsers } from "@/detection/environment-runtime";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = {
  locale: LocaleCode;
  busy: boolean;
  onClose: () => void;
  onSaved: (catalog: BrowserCatalog) => void;
  onLink: (browserId: string) => Promise<void> | void;
};

export function BrowserPickerDialog({ locale, busy, onClose, onSaved, onLink }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [catalog, setCatalog] = useState<BrowserCatalog | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try { const value = await readBrowsers(); if (!cancelled) { setCatalog(value); setExcluded(value.excluded); } }
      catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (id: string) => { setError(""); setNotice(""); setExcluded((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); };

  const persist = async () => {
    setWorking(true); setError(""); setNotice("");
    try {
      const value = await saveBrowsers({ excluded, preferred: catalog?.preferred ?? null });
      setCatalog(value); setExcluded(value.excluded);
      setNotice(text("已保存浏览器接入偏好。", "Browser preference saved."));
      onSaved(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setWorking(false); }
  };

  const link = async (id: string) => {
    setLinking(id); setError(""); setNotice("");
    try {
      await saveBrowsers({ excluded, preferred: id });
      const value = await readBrowsers();
      setCatalog(value); setExcluded(value.excluded);
      await onLink(id);
      setNotice(text("已按所选浏览器接入。", "Linked with the selected browser."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLinking(null); }
  };

  const disabled = working || busy || linking !== null;
  const rows = catalog?.browsers ?? [];

  return <dialog ref={dialog} className="repair-dialog browser-picker" aria-labelledby="browser-picker-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}
    onPointerDown={(event) => { backdropPointerDown.current = isDialogBackdropEvent(event); }}>
    <div className="repair-dialog__header">
      <div>
        <h2 id="browser-picker-title">{text("本地浏览器", "Local browsers")}</h2>
        <p className="netcore-detail">{text("接入会在独立配置目录里启动一份受管实例；你正在用的窗口不会被接管，也不会被改动。", "Linking launches a managed instance with its own profile; your running window is neither taken over nor modified.")}</p>
      </div>
      <button type="button" className="repair-button" onClick={onClose}>{text("关闭", "Close")}</button>
    </div>
    <div className="repair-dialog__body browser-picker__body">
      {!catalog && !error && <p className="netcore-detail" role="status">{text("正在识别本机浏览器…", "Detecting installed browsers…")}</p>}
      {catalog && <ul className="browser-picker__list">
        {rows.map((browser) => {
          const isExcluded = excluded.includes(browser.id);
          const usable = browser.installed && browser.supported && !isExcluded;
          return <li key={browser.id} className="browser-picker__item" data-usable={usable}>
            <div className="browser-picker__main">
              <span className="browser-picker__name">{browser.name}</span>
              <span className="browser-picker__meta">
                {!browser.supported
                  ? text("不支持调试接入（非 Chromium 内核）", "No debug attach (not Chromium-based)")
                  : !browser.installed ? text("未安装", "Not installed")
                    : browser.path}
              </span>
            </div>
            <label className="browser-picker__toggle">
              <input type="checkbox" checked={isExcluded} disabled={disabled} onChange={() => toggle(browser.id)} />
              <span>{text("不接入", "Skip")}</span>
            </label>
            <button type="button" className="repair-button repair-button--quiet" disabled={disabled || !browser.installed || !browser.supported || isExcluded}
              onClick={() => void link(browser.id)}>
              {linking === browser.id ? text("接入中…", "Linking…") : text("用这个接入", "Link this")}
            </button>
          </li>;
        })}
      </ul>}
      {catalog && !catalog.active && <p className="netcore-alert" role="alert">{text("当前没有可接入的浏览器：至少保留一个 Chromium 内核浏览器。", "No browser can be linked: keep at least one Chromium-based browser.")}</p>}
      {error && <p className="netcore-alert" role="alert">{error}</p>}
      {notice && <p className="exempt-notice" role="status">{notice}</p>}
    </div>
    <footer className="repair-dialog__footer">
      <p className="netcore-detail">{text("「不接入」只影响受保护浏览器，不卸载、不改动这些浏览器本身的设置。", "Skipping only affects the managed browser; it neither uninstalls nor changes these browsers.")}</p>
      <button type="button" className="repair-button" onClick={() => void persist()} disabled={disabled}>{working ? text("保存中…", "Saving…") : text("保存选择", "Save selection")}</button>
    </footer>
  </dialog>;
}
