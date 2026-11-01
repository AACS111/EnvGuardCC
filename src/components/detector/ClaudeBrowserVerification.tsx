"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { claudeBrowserSignal, readClaudeBrowser, type ClaudeBrowserReport } from "@/detection/claude-browser";
import type { SignalResult } from "@/detection/types";
import type { LocaleCode } from "@/i18n/messages";

export function ClaudeBrowserVerification({ locale, disabled, onSample }: { locale: LocaleCode; disabled: boolean; onSample: (sample: SignalResult) => void }) {
  const zh = locale.startsWith("zh");
  const [report, setReport] = useState<ClaudeBrowserReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const mounted = useRef(false);
  const check = useCallback(async (open = false) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setOpening(open);
    try {
      const result = await readClaudeBrowser(open);
      if (!mounted.current) return;
      setReport(result); setError(""); onSample(claudeBrowserSignal(result, locale));
    } catch {
      if (!mounted.current) return;
      setError(zh ? "无法连接浏览器验证服务，请确认本机助手已更新并运行，再点击复检。" : "Cannot connect to browser verification. Update and start the local helper, then check again.");
      const unavailable: ClaudeBrowserReport = { state: "unavailable", checkedAt: new Date().toISOString() };
      setReport(unavailable); onSample(claudeBrowserSignal(unavailable, locale));
    } finally { lock.current = false; if (mounted.current) { setBusy(false); setOpening(false); } }
  }, [locale, onSample, zh]);
  useEffect(() => {
    mounted.current = true;
    if (disabled) return () => { mounted.current = false; };
    const initial = setTimeout(() => void check(), 0);
    const timer = setInterval(() => void check(), 3000);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); };
  }, [check, disabled]);
  return <section className="repair-notice" aria-label={zh ? "Claude 浏览器验证" : "Claude browser verification"}>
    <strong>{zh ? "在实际浏览器中验证" : "Verify in the browser"}</strong>
    <p role="status">{error || (report ? claudeBrowserSignal(report, locale).value : zh ? "正在读取受控浏览器状态…" : "Reading managed browser status…")}</p>
    <p>{zh ? "打开后，在受控窗口中完成人机验证或登录，再点击复检；此面板打开时每 3 秒更新页面状态。登录页能打开即可通过网页可达性检测，聊天功能需另行实际使用确认。" : "Open the managed window, complete any challenge or login, then check again. This panel refreshes every 3 seconds. An accessible login page passes website reachability; messaging needs a separate actual-use check."}</p>
    <button type="button" className="repair-button" disabled={disabled || busy} onClick={() => void check(true)}>{opening ? (zh ? "正在打开…" : "Opening…") : (zh ? "打开受控浏览器验证" : "Open managed browser")}</button>{" "}
    <button type="button" className="repair-button" disabled={disabled || busy} onClick={() => void check()}>{zh ? "完成验证后复检" : "Check after verification"}</button>
  </section>;
}
