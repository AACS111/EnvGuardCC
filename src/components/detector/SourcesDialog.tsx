"use client";
// 配置与供应商：一条配置 = 一份可命名、可切换的节点快照。
// 订阅地址、更新时间、更新按钮都收在这里；主页面不再出现长链接。
import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type {
  LocalProxyEntry,
  NetCoreImportPayload,
  NetCoreImportResult,
  NetCoreSource,
  NetCoreSourceAction,
  NetCoreSourceResult,
} from "@/detection/gateway-check";
import { scanLocalProxies } from "@/detection/gateway-check";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = {
  locale: LocaleCode;
  /** 从「添加配置」入口打开时直接进表单，少点一次。 */
  initialView?: "list" | "add";
  sources: NetCoreSource[];
  activeId: string | null;
  busy: boolean;
  onClose: () => void;
  onImport: (payload: NetCoreImportPayload) => Promise<NetCoreImportResult>;
  onAction: (action: NetCoreSourceAction, id: string, name?: string) => Promise<NetCoreSourceResult>;
  /** 保存成功后让外层重新读一次内核状态（列表随 props.sources 刷新）。 */
  onChanged: () => void;
};

type AddMode = "url" | "file" | "local" | "manual";
type Confirm = { type: "activate" | "delete"; id: string } | null;

const ADD_MODES: Array<{ id: AddMode; cn: string; en: string; cnHint: string; enHint: string }> = [
  { id: "url", cn: "链接", en: "Link", cnHint: "订阅链接或代理分享链接", enHint: "Subscription or share link" },
  { id: "local", cn: "本地代理", en: "Local proxy", cnHint: "借用本机已运行的 VPN / 代理端口", enHint: "Reuse a running local VPN/proxy port" },
  { id: "file", cn: "文件", en: "File", cnHint: "上传 Clash 配置或分享链接列表", enHint: "Upload a Clash config or a list of share links" },
  { id: "manual", cn: "自定义", en: "Manual", cnHint: "手工填写一个出口节点", enHint: "Fill in a single exit node" },
];

const KIND_LABEL: Record<string, { cn: string; en: string }> = {
  url: { cn: "订阅链接", en: "Subscription" },
  manual: { cn: "手写节点", en: "Manual" },
  content: { cn: "粘贴配置", en: "Pasted" },
  local: { cn: "本地代理", en: "Local proxy" },
};

const hostOf = (url: string | null) => {
  if (!url) return "";
  try { return new URL(url).hostname; } catch { return url; }
};

const timeOf = (value: string) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : "—";
};

export function SourcesDialog({ locale, initialView = "list", sources, activeId, busy, onClose, onImport, onAction, onChanged }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [view, setView] = useState<"list" | "form">(initialView === "add" ? "form" : "list");
  const [editing, setEditing] = useState<NetCoreSource | null>(null);
  const [mode, setMode] = useState<AddMode>("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [manual, setManual] = useState({ name: "", type: "ss", server: "", port: "", secret: "", cipher: "aes-128-gcm" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [localProxies, setLocalProxies] = useState<LocalProxyEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  // 只清表单字段：错误/提示由调用方决定何时清，避免「操作成功」的提示被返回列表时抹掉。
  const resetForm = () => {
    setEditing(null); setMode("url"); setName(""); setUrl(""); setFileText(""); setFileName("");
    setManual({ name: "", type: "ss", server: "", port: "", secret: "", cipher: "aes-128-gcm" });
    setLocalProxies(null); setScanNote("");
  };
  const openAdd = () => { resetForm(); setError(""); setNotice(""); setView("form"); };
  const openEdit = (source: NetCoreSource) => {
    resetForm();
    setEditing(source);
    setName(source.name);
    setUrl(source.url ?? "");
    setError(""); setNotice("");
    setView("form");
  };
  const backToList = () => { resetForm(); setView("list"); };

  const runImport = async (payload: NetCoreImportPayload) => {
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await onImport(payload);
      if (!result.ok) { setError(result.reason ?? text("导入失败。", "Import failed.")); return false; }
      const skipped = result.skipped?.length ?? 0;
      setNotice(text(`已保存 ${result.imported ?? 0} 个节点${skipped ? `，跳过 ${skipped} 条` : ""}。`, `Saved ${result.imported ?? 0} node(s)${skipped ? `, skipped ${skipped}` : ""}.`));
      onChanged();
      backToList();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { setWorking(false); }
  };

  const runAction = async (action: NetCoreSourceAction, id: string, value?: string) => {
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await onAction(action, id, value);
      if (!result.ok) { setError(result.reason ?? text("操作未生效。", "The action did not take effect.")); return false; }
      setNotice(action === "activate" ? text("已切换，正在重启内核。", "Switched; restarting the kernel.") : action === "delete" ? text("已删除这条配置。", "Configuration deleted.") : action === "rename" ? text("已重命名。", "Renamed.") : text("已更新这条订阅。", "Subscription refreshed."));
      onChanged();
      if (action === "delete" || action === "activate") backToList();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { setWorking(false); setConfirm(null); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const trimmed = name.trim();
    if (!trimmed) { setError(text("请填写名称。", "Enter a name.")); return; }
    if (editing.mode === "url" && editing.url !== url.trim()) {
      if (!url.trim()) { setError(text("请填写订阅链接。", "Enter a subscription link.")); return; }
      await runImport({ mode: "url", url: url.trim(), sourceId: editing.id, name: trimmed });
      return;
    }
    if (trimmed === editing.name) { backToList(); return; }
    if (await runAction("rename", editing.id, trimmed)) backToList();
  };

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

  const submitAdd = () => {
    if (mode === "url") {
      if (!url.trim()) { setError(text("请填写订阅或分享链接。", "Enter a subscription or share link.")); return; }
      void runImport({ mode: "url", url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) });
      return;
    }
    if (mode === "file") {
      if (!fileText.trim()) { setError(text("请选择文件或粘贴内容。", "Choose a file or paste content.")); return; }
      void runImport({ mode: "content", content: fileText, ...(name.trim() ? { name: name.trim() } : {}) });
      return;
    }
    if (mode === "manual") {
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
      void runImport({ mode: "manual", proxies: [proxy], ...(name.trim() ? { name: name.trim() } : {}) });
      return;
    }
    setError(text("请从扫描结果里选择一个本地代理。", "Pick a local proxy from the scan results."));
  };

  const disabled = working || busy;
  const confirmSource = confirm ? sources.find((source) => source.id === confirm.id) ?? null : null;

  return <dialog ref={dialog} className="repair-dialog sources-dialog" aria-labelledby="sources-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { backdropPointerDown.current = isDialogBackdropEvent(event); }}
    onClick={(event) => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}>
    <header className="repair-dialog__header">
      <div>
        <h2 id="sources-title">{view === "list" ? text("配置与供应商", "Configurations") : editing ? text("编辑配置", "Edit configuration") : text("添加配置", "Add configuration")}</h2>
        <p className="netcore-detail">{view === "list"
          ? text("一条配置保存一份节点快照；切换会用已保存的快照重建内核，连接会中断几秒。", "Each configuration keeps its own node snapshot; switching rebuilds the kernel and interrupts connections briefly.")
          : text("解析在后端完成，失败不会覆盖已有配置。", "Parsing happens in the backend; a failure never overwrites existing configurations.")}</p>
      </div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose} aria-label={text("关闭", "Close")}>{text("关闭", "Close")}</button>
    </header>

    <div className="sources-body">
      {notice && <p className="netcore-notice" role="status">{notice}</p>}
      {error && <p className="netcore-alert" role="alert">{error}</p>}

      {view === "list" ? <>
        {sources.length === 0 && <p className="netcore-detail">{text("还没有保存任何配置。添加一条订阅链接或本机代理作为出口。", "No configurations yet. Add a subscription or a local proxy as the exit.")}</p>}
        <ul className="sources-list">
          {sources.map((source) => <li key={source.id} className="source-item" data-active={source.active}>
            <div className="source-item__main">
              <div className="source-item__title">
                <strong>{source.name}</strong>
                {source.active && <span className="netcore-state-pill" data-tone="ok">{text("当前", "Active")}</span>}
                <span className="source-item__kind">{text(KIND_LABEL[source.mode]?.cn ?? "配置", KIND_LABEL[source.mode]?.en ?? "Config")}</span>
              </div>
              <p className="source-item__meta">
                {source.mode === "url" && source.url && <span className="source-item__url">{hostOf(source.url)}</span>}
                <span>{text(`${source.nodeCount} 个节点`, `${source.nodeCount} node(s)`)}</span>
                <span>{text(`更新于 ${timeOf(source.updatedAt)}`, `Updated ${timeOf(source.updatedAt)}`)}</span>
              </p>
            </div>
            <div className="source-item__actions">
              {source.active
                ? <span className="source-item__current">{text("正在使用", "In use")}</span>
                : <button type="button" className="repair-button repair-button--quiet" disabled={disabled} onClick={() => setConfirm({ type: "activate", id: source.id })}>{text("设为当前", "Use")}</button>}
              {source.mode === "url" && <button type="button" className="repair-button repair-button--quiet" disabled={disabled} onClick={() => void runAction("refresh", source.id)}>{text("更新", "Update")}</button>}
              <button type="button" className="repair-button repair-button--quiet" disabled={disabled} onClick={() => openEdit(source)}>{text("编辑", "Edit")}</button>
              <button type="button" className="repair-button repair-button--quiet" disabled={disabled || (source.active && sources.length === 1)} title={source.active && sources.length === 1 ? text("至少保留一条配置", "Keep at least one configuration") : undefined} onClick={() => setConfirm({ type: "delete", id: source.id })}>{text("删除", "Delete")}</button>
            </div>
          </li>)}
        </ul>

        {confirm && confirmSource && <div className="sources-confirm" role="alert">
          <p>{confirm.type === "activate"
            ? text(`切换到「${confirmSource.name}」会重启内核，Claude 连接会中断几秒。`, `Switching to "${confirmSource.name}" restarts the kernel and interrupts Claude connections briefly.`)
            : text(`删除「${confirmSource.name}」会同时删除它的 ${confirmSource.nodeCount} 个节点快照，且无法撤销。${confirmSource.active ? " 当前配置会切换到下一条并重启内核。" : ""}`, `Deleting "${confirmSource.name}" also deletes its ${confirmSource.nodeCount} node snapshot; this cannot be undone.${confirmSource.active ? " The current configuration switches to the next one and the kernel restarts." : ""}`)}</p>
          <div className="sources-confirm__actions">
            <button type="button" className="repair-button repair-button--quiet" disabled={working} onClick={() => setConfirm(null)}>{text("取消", "Cancel")}</button>
            <button type="button" className="repair-button" disabled={working} onClick={() => void runAction(confirm.type === "activate" ? "activate" : "delete", confirm.id)}>{confirm.type === "activate" ? text("设为当前", "Use") : text("删除", "Delete")}</button>
          </div>
        </div>}

        <p className="netcore-detail">{text("第三方订阅常把香港/中国大陆节点排在最前；这些出口会被 Claude 地区校验拒绝。导入后请在「出口节点」里选择台湾、新加坡、日本等支持地区的节点。", "Third-party subscriptions often list Hong Kong/mainland China nodes first; those exits are refused by Claude's regional check. After importing, pick a node in Taiwan, Singapore, Japan or another supported region under Exit nodes.")}</p>
        <div className="sources-footer">
          <button type="button" className="repair-button" disabled={disabled} onClick={openAdd}>{text("添加配置", "Add configuration")}</button>
          <span className="netcore-detail">{text("当前配置：", "Current: ")}{sources.find((source) => source.id === activeId)?.name ?? "—"}</span>
        </div>
      </> : <div className="addconfig-body" data-editing={editing ? "true" : "false"}>
        {!editing && <div className="addconfig-modes" role="group" aria-label={text("配置来源", "Configuration source")}>
          {ADD_MODES.map((item) => <button key={item.id} type="button" className="addconfig-mode" aria-pressed={mode === item.id} disabled={disabled} onClick={() => { setMode(item.id); setError(""); }}>
            <span className="addconfig-mode__title">{text(item.cn, item.en)}</span>
            <span className="addconfig-mode__hint">{text(item.cnHint, item.enHint)}</span>
          </button>)}
        </div>}
        <div className="addconfig-panel">
          <label className="addconfig-label" htmlFor="source-name">{text("名称", "Name")}
            <input id="source-name" className="workspace-interval addconfig-input" value={name} disabled={disabled} placeholder={editing?.name ?? text("例如：首尔机场", "e.g. Seoul provider")} onChange={(event) => setName(event.target.value)} />
          </label>

          {editing ? <>
            {editing.mode === "url" ? <>
              <label className="addconfig-label" htmlFor="source-url">{text("订阅链接", "Subscription link")}
                <input id="source-url" type="url" className="workspace-interval addconfig-input" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} />
              </label>
              <p className="netcore-detail">{text("修改链接并保存会立刻重新拉取节点；拉取失败时保留原有节点。", "Saving a new link fetches nodes immediately; a failed fetch keeps the current nodes.")}</p>
            </> : <p className="netcore-detail">{text("这条配置的节点来自手工导入，这里只能改名。要换节点，请添加一条新配置。", "This configuration's nodes were imported manually; only the name can change here. Add a new configuration to replace the nodes.")}</p>}
            <div className="sources-form__actions">
              <button type="button" className="repair-button repair-button--quiet" onClick={backToList} disabled={working}>{text("返回", "Back")}</button>
              <button type="button" className="repair-button" onClick={() => void saveEdit()} disabled={disabled}>{working ? text("保存中…", "Saving…") : text("保存", "Save")}</button>
            </div>
          </> : <>
            {mode === "url" && <>
              <label className="addconfig-label" htmlFor="source-url">{text("订阅 / 分享链接", "Subscription or share link")}
                <input id="source-url" type="url" className="workspace-interval addconfig-input" placeholder="https://example.com/sub.yaml" value={url} disabled={disabled} onChange={(event) => setUrl(event.target.value)} />
              </label>
              <p className="netcore-detail">{text("支持 Clash 配置（proxies）与 ss / vmess / trojan / vless 分享链接；整体 base64 也可识别。", "Supports Clash configs (proxies) and ss / vmess / trojan / vless share links, including base64 lists.")}</p>
            </>}
            {mode === "file" && <>
              <label className="addconfig-label" htmlFor="source-file">{text("配置文件", "Configuration file")}
                <input id="source-file" type="file" accept=".yaml,.yml,.txt,.conf,.json" className="addconfig-input" disabled={disabled} onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 4 * 1024 * 1024) { setError(text("文件超过 4MB。", "File exceeds 4MB.")); return; }
                  setFileName(file.name); setFileText(await file.text());
                }} />
              </label>
              {fileName && <p className="netcore-detail">{fileName} · {text(`${fileText.length} 字符`, `${fileText.length} characters`)}</p>}
              <label className="addconfig-label" htmlFor="source-content">{text("或直接粘贴内容", "Or paste content")}
                <textarea id="source-content" className="addconfig-textarea" rows={6} value={fileText} disabled={disabled} onChange={(event) => { setFileText(event.target.value); setFileName(""); }} />
              </label>
            </>}
            {mode === "local" && <>
              <p className="netcore-detail">{text("扫描本机已运行的代理客户端（FlClash / Clash Verge / v2rayN 等），把它的本地端口追加到当前配置。只探测端口，不读也不改对方的配置。", "Scan proxy clients already running on this machine (FlClash, Clash Verge, v2rayN…) and append one local port to the current configuration. Ports are only probed; their configuration is never read or changed.")}</p>
              <button type="button" className="repair-button" disabled={disabled || scanning} onClick={() => void runScan()}>{scanning ? text("扫描中…", "Scanning…") : text("扫描本地代理", "Scan local proxies")}</button>
              {scanNote && <p className="netcore-detail" role="status">{scanNote}</p>}
              {localProxies && localProxies.length > 0 && <ul className="exempt-list">
                {localProxies.map((entry) => <li key={entry.port} className="exempt-item">
                  <span>{entry.tool} · {entry.protocol} · {text(`端口 ${entry.port}`, `port ${entry.port}`)}</span>
                  <button type="button" className="repair-button repair-button--quiet" disabled={disabled} onClick={() => void runImport({ mode: "local-proxy", port: entry.port, protocol: entry.protocol, name: `本地代理 · ${entry.tool} ${entry.port}` })}>{text("加为出口", "Add as exit")}</button>
                </li>)}
              </ul>}
            </>}
            {mode === "manual" && <div className="addconfig-grid">
              <label>{text("节点名称", "Node name")}<input className="workspace-interval" value={manual.name} disabled={disabled} onChange={(event) => setManual({ ...manual, name: event.target.value })} /></label>
              <label>{text("类型", "Type")}<select className="workspace-interval" value={manual.type} disabled={disabled} onChange={(event) => setManual({ ...manual, type: event.target.value })}>{["ss", "vmess", "trojan", "vless"].map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label>{text("服务器", "Server")}<input className="workspace-interval" value={manual.server} disabled={disabled} onChange={(event) => setManual({ ...manual, server: event.target.value })} /></label>
              <label>{text("端口", "Port")}<input className="workspace-interval" inputMode="numeric" value={manual.port} disabled={disabled} onChange={(event) => setManual({ ...manual, port: event.target.value })} /></label>
              <label>{manual.type === "ss" || manual.type === "trojan" ? text("密码", "Password") : text("UUID", "UUID")}<input className="workspace-interval" value={manual.secret} disabled={disabled} onChange={(event) => setManual({ ...manual, secret: event.target.value })} /></label>
              {manual.type === "ss" && <label>{text("加密方式", "Cipher")}<input className="workspace-interval" value={manual.cipher} disabled={disabled} onChange={(event) => setManual({ ...manual, cipher: event.target.value })} /></label>}
            </div>}
            <div className="sources-form__actions">
              <button type="button" className="repair-button repair-button--quiet" onClick={backToList} disabled={working}>{text("取消", "Cancel")}</button>
              <button type="button" className="repair-button" onClick={submitAdd} disabled={disabled}>{working ? text("保存中…", "Saving…") : text("保存并设为当前", "Save & use")}</button>
            </div>
            <p className="netcore-detail">{text("保存后会立即成为当前配置并重建内核。导入会替换这条配置原有的节点快照。", "Saving makes it the current configuration and rebuilds the kernel. Importing replaces the node snapshot of this configuration.")}</p>
          </>}
        </div>
      </div>}
    </div>
  </dialog>;
}
