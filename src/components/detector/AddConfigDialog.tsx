"use client";
// 添加配置：链接订阅 / 文件 / 自定义。
// 解析在后端完成，界面只负责收集输入与展示真实结果（导入数、跳过数、失败原因）。
import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type { NetCoreImportPayload, NetCoreImportResult, LocalProxyEntry } from "@/detection/gateway-check";
import { scanLocalProxies } from "@/detection/gateway-check";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = {
  locale: LocaleCode;
  busy: boolean;
  onClose: () => void;
  onImport: (payload: NetCoreImportPayload) => Promise<NetCoreImportResult>;
  /** 修改配置时预填当前订阅地址；新建时为空。 */
  initialUrl?: string;
};

const MODES = [
  { id: "url", cn: "链接", en: "Link", cnHint: "通过订阅链接或代理分享链接获取配置", enHint: "Fetch configuration from a subscription or share link" },
  { id: "local", cn: "本地代理", en: "Local proxy", cnHint: "扫描本机已装的 VPN / 代理客户端并借用", enHint: "Scan local VPN/proxy clients and reuse one" },
  { id: "file", cn: "文件", en: "File", cnHint: "直接上传配置文件", enHint: "Upload a configuration file" },
  { id: "manual", cn: "自定义", en: "Manual", cnHint: "手工填写一个出口节点", enHint: "Fill in a single exit node" },
] as const;

type Mode = (typeof MODES)[number]["id"];

export function AddConfigDialog({ locale, busy, onClose, onImport, initialUrl = "" }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState(initialUrl);
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [manual, setManual] = useState({ name: "", type: "ss", server: "", port: "", secret: "", cipher: "aes-128-gcm" });
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<NetCoreImportResult | null>(null);
  const [error, setError] = useState("");
  const [localProxies, setLocalProxies] = useState<LocalProxyEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  const submit = async (payload: NetCoreImportPayload) => {
    setWorking(true); setError(""); setResult(null);
    try {
      const value = await onImport(payload);
      if (!value.ok) { setError(value.reason ?? text("导入失败。", "Import failed.")); return; }
      setResult(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setWorking(false); }
  };

  // 扫描本地代理：只读探测，把「本机已经有能用的 VPN」变成可一键借用的列表。
  const runScan = async () => {
    setScanning(true); setScanNote(""); setLocalProxies(null); setError("");
    try {
      const value = await scanLocalProxies();
      setLocalProxies(value.items);
      setScanNote(value.summary || text("未发现本地代理", "No local proxy found"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setScanning(false); }
  };
  const borrowLocal = (entry: LocalProxyEntry) => {
    void submit({ mode: "local-proxy", port: entry.port, protocol: entry.protocol, name: `本地代理 · ${entry.tool} ${entry.port}` });
  };

  const fromUrl = () => {
    if (!url.trim()) { setError(text("请填写订阅或分享链接。", "Enter a subscription or share link.")); return; }
    void submit({ mode: "url", url: url.trim() });
  };
  const fromFile = () => {
    if (!fileText.trim()) { setError(text("请选择文件或粘贴内容。", "Choose a file or paste content.")); return; }
    void submit({ mode: "content", content: fileText });
  };
  const fromManual = () => {
    const port = Number(manual.port);
    if (!manual.name.trim() || !manual.server.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError(text("名称、服务器与端口都必须填写。", "Name, server and port are required."));
      return;
    }
    const proxy: Record<string, unknown> = { name: manual.name.trim(), type: manual.type, server: manual.server.trim(), port };
    if (manual.type === "ss") { proxy.cipher = manual.cipher || "aes-128-gcm"; proxy.password = manual.secret; }
    else if (manual.type === "vmess") { proxy.uuid = manual.secret; proxy.alterId = 0; proxy.cipher = "auto"; }
    else if (manual.type === "trojan") proxy.password = manual.secret;
    else proxy.uuid = manual.secret;
    void submit({ mode: "manual", proxies: [proxy] });
  };

  const disabled = working || busy;
  const skipped = result?.skipped ?? [];

  return <dialog ref={dialog} className="repair-dialog addconfig-dialog" aria-labelledby="addconfig-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={(event) => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <h2 id="addconfig-title">{initialUrl ? text("修改配置", "Edit configuration") : text("添加配置", "Add configuration")}</h2>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} aria-label={text("关闭", "Close")}>{text("关闭", "Close")}</button>
    </header>
    <div className="addconfig-body">
      <div className="addconfig-modes" role="group" aria-label={text("配置来源", "Configuration source")}>
        {MODES.map((item) => <button key={item.id} type="button" className="addconfig-mode" aria-pressed={mode === item.id} onClick={() => { setMode(item.id); setError(""); setResult(null); }}>
          <span className="addconfig-mode__title">{text(item.cn, item.en)}</span>
          <span className="addconfig-mode__hint">{text(item.cnHint, item.enHint)}</span>
        </button>)}
      </div>
      <div className="addconfig-panel">
        {mode === "url" && <>
          <label className="addconfig-label" htmlFor="addconfig-url">{text("订阅 / 分享链接", "Subscription or share link")}</label>
          <input id="addconfig-url" type="url" inputMode="url" className="workspace-interval addconfig-input" placeholder="https://example.com/sub.yaml" value={url} onChange={(event) => setUrl(event.target.value)} disabled={disabled} />
          <p className="netcore-detail">{text("支持 Clash 配置（proxies）与 ss / vmess / trojan / vless 分享链接；整体 base64 也可识别。", "Supports Clash configs (proxies) and ss/vmess/trojan/vless share links, including base64-encoded lists.")}</p>
          <button type="button" className="repair-button" disabled={disabled} onClick={fromUrl}>{working ? text("导入中…", "Importing…") : text("导入", "Import")}</button>
        </>}

        {mode === "local" && <>
          <p className="netcore-detail">{text("扫描本机已运行的代理客户端（FlClash / Clash Verge / v2rayN 等），把它的本地端口当作出口节点。只探测端口，不读也不改对方的配置。", "Scan proxy clients already running on this machine (FlClash, Clash Verge, v2rayN…) and use their local port as an exit node. Ports are only probed; their configuration is never read or changed.")}</p>
          <button type="button" className="repair-button" disabled={disabled || scanning} onClick={() => void runScan()}>{scanning ? text("扫描中…", "Scanning…") : text("扫描本地代理", "Scan local proxies")}</button>
          {scanNote && <p className="netcore-detail" role="status">{scanNote}</p>}
          {localProxies && localProxies.length > 0 && <ul className="exempt-list">
            {localProxies.map((entry) => <li key={entry.port} className="exempt-item">
              <span>{entry.tool} · {entry.protocol} · {text(`端口 ${entry.port}`, `port ${entry.port}`)}</span>
              <button type="button" className="repair-button repair-button--quiet" disabled={disabled} onClick={() => borrowLocal(entry)}>{text("用作出口", "Use as exit")}</button>
            </li>)}
          </ul>}
          {localProxies && localProxies.length === 0 && <p className="netcore-detail">{text("没有找到可用端口：先启动 FlClash 之类客户端并确认它已启用，再扫描。", "No usable port found: start FlClash (or similar) and make sure it is enabled, then scan again.")}</p>}
        </>}

        {mode === "file" && <>
          <label className="addconfig-label" htmlFor="addconfig-file">{text("配置文件", "Configuration file")}</label>
          <input id="addconfig-file" type="file" accept=".yaml,.yml,.txt,.conf,.json" className="addconfig-input" disabled={disabled}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 4 * 1024 * 1024) { setError(text("文件超过 4MB。", "File exceeds 4MB.")); return; }
              setFileName(file.name); setFileText(await file.text());
            }} />
          {fileName && <p className="netcore-detail">{fileName} · {text(`${fileText.length} 字符`, `${fileText.length} characters`)}</p>}
          <label className="addconfig-label" htmlFor="addconfig-content">{text("或直接粘贴内容", "Or paste content")}</label>
          <textarea id="addconfig-content" className="addconfig-textarea" rows={6} value={fileText} disabled={disabled} onChange={(event) => { setFileText(event.target.value); setFileName(""); }} />
          <button type="button" className="repair-button" disabled={disabled} onClick={fromFile}>{working ? text("导入中…", "Importing…") : text("导入", "Import")}</button>
        </>}

        {mode === "manual" && <>
          <div className="addconfig-grid">
            <label>{text("名称", "Name")}<input className="workspace-interval" value={manual.name} disabled={disabled} onChange={(event) => setManual({ ...manual, name: event.target.value })} /></label>
            <label>{text("类型", "Type")}<select className="workspace-interval" value={manual.type} disabled={disabled} onChange={(event) => setManual({ ...manual, type: event.target.value })}>{["ss", "vmess", "trojan", "vless"].map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
            <label>{text("服务器", "Server")}<input className="workspace-interval" value={manual.server} disabled={disabled} onChange={(event) => setManual({ ...manual, server: event.target.value })} /></label>
            <label>{text("端口", "Port")}<input className="workspace-interval" inputMode="numeric" value={manual.port} disabled={disabled} onChange={(event) => setManual({ ...manual, port: event.target.value })} /></label>
            <label>{manual.type === "ss" ? text("密码", "Password") : manual.type === "trojan" ? text("密码", "Password") : text("UUID", "UUID")}<input className="workspace-interval" value={manual.secret} disabled={disabled} onChange={(event) => setManual({ ...manual, secret: event.target.value })} /></label>
            {manual.type === "ss" && <label>{text("加密方式", "Cipher")}<input className="workspace-interval" value={manual.cipher} disabled={disabled} onChange={(event) => setManual({ ...manual, cipher: event.target.value })} /></label>}
          </div>
          <button type="button" className="repair-button" disabled={disabled} onClick={fromManual}>{working ? text("保存中…", "Saving…") : text("添加到节点列表", "Add node")}</button>
        </>}

        {error && <p className="netcore-alert" role="alert">{error}</p>}
        {result && <div className="addconfig-result" role="status">
          <p>{text(`已导入 ${result.imported} 个节点 · 当前选择 ${result.selected ?? "—"}`, `Imported ${result.imported} node(s) · selected ${result.selected ?? "—"}`)}</p>
          {skipped.length > 0 && <p className="netcore-detail">{text(`跳过 ${skipped.length} 条：${skipped.slice(0, 3).map((item) => item.reason).join("；")}`, `Skipped ${skipped.length}: ${skipped.slice(0, 3).map((item) => item.reason).join("; ")}`)}</p>}
        </div>}
      </div>
    </div>
    <footer className="repair-dialog__footer">
      <p className="netcore-detail">{text("导入会替换当前节点列表；解析失败时不会覆盖已有配置。", "Importing replaces the current node list; a failed parse never overwrites existing configuration.")}</p>
    </footer>
  </dialog>;
}
