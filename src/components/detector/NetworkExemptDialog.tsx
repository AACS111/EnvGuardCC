"use client";
// 内网直连（VPN / 公司网络）：编辑 net-core-network.json。
// 骨架沿用「配置与供应商」弹窗的单页表单，顶部补一条「当前生效」结论：
// 用户改完能立刻看到会生成什么规则，而不是只相信自己填对了一串地址。
import { useEffect, useRef, useState } from "react";
import type { LocaleCode } from "@/i18n/messages";
import type { NetCoreDomainCheck, NetCoreNetworkConfig, NetCoreNetworkState } from "@/detection/gateway-check";
import { readNetCoreNetwork, saveNetCoreNetwork, verifyNetCoreDomain } from "@/detection/gateway-check";
import { isDialogBackdropEvent } from "./RepairDialog";

type Props = {
  locale: LocaleCode;
  busy: boolean;
  onClose: () => void;
  onSaved: (state: NetCoreNetworkState) => void;
};

/**
 * 摘要只说人话：列真实域名 / DNS / 网卡，不出现 `DOMAIN-SUFFIX,…` 或 `#ENVGUARD-LOCAL-DNS` 这类内核语法，
 * 也不把「0 个」摆成仪表盘。原始规则只在「高级」折叠里出现。
 */
export function exemptSummary(zh: boolean, draft: { domains: string[]; addresses: string[]; dnsServers: string[]; directInterface: string }): string {
  // 没有任何豁免时不提 DNS/网卡：那些字段此刻不影响任何路由，说多了只是噪音。
  if (!draft.domains.length && !draft.addresses.length) {
    return zh ? "还没有内网豁免：内网域名会被当成公网去解析，通常打不开。" : "No local exemptions yet: internal names resolve publicly and usually fail.";
  }
  const dnsNames = draft.dnsServers.map((server) => server.split("#")[0]);
  const parts = [
    draft.domains.length
      ? zh
        ? `内网域名 ${draft.domains.slice(0, 2).join("、")}${draft.domains.length > 2 ? ` 等 ${draft.domains.length} 个` : ""}`
        : `Internal domains ${draft.domains.slice(0, 2).join(", ")}${draft.domains.length > 2 ? ` +${draft.domains.length - 2}` : ""}`
      : null,
    draft.addresses.length ? (zh ? `豁免 IP ${draft.addresses.length} 个` : `${draft.addresses.length} exempt IP(s)`) : null,
    dnsNames.length ? (zh ? `内网 DNS ${dnsNames.join(" · ")}` : `Internal DNS ${dnsNames.join(" · ")}`) : (zh ? "DNS 跟随系统" : "DNS follows system"),
    draft.directInterface ? (zh ? `走网卡 ${draft.directInterface}` : `via ${draft.directInterface}`) : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

const ipv4 = (value: string): number | null => {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
};

// 仅用于「这句提示该不该显示」的展示性判断；真正的校验在服务端试算。
const covers = (address: string, cidr: string): boolean => {
  const [rawAddress, rawBits] = cidr.split("/");
  const base = ipv4(rawAddress);
  const host = ipv4(address.split("/")[0]);
  const bits = Number(rawBits);
  if (base === null || host === null || !Number.isInteger(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((host & mask) >>> 0) === ((base & mask) >>> 0);
};

export function NetworkExemptDialog({ locale, busy, onClose, onSaved }: Props) {
  const zh = locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const [state, setState] = useState<NetCoreNetworkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"save" | "restart" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [domains, setDomains] = useState<string[]>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [dnsMode, setDnsMode] = useState<"system" | "custom">("system");
  const [dnsServers, setDnsServers] = useState<string[]>([]);
  const [directInterface, setDirectInterface] = useState("");
  const [dnsInterface, setDnsInterface] = useState("");
  const [strictRoute, setStrictRoute] = useState(true);
  const [domainDraft, setDomainDraft] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [dnsDraft, setDnsDraft] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [checked, setChecked] = useState<NetCoreDomainCheck | null>(null);
  const [checkError, setCheckError] = useState("");

  const apply = (value: NetCoreNetworkState) => {
    const config = value.config ?? {};
    setDomains(Array.isArray(config.directDomains) ? config.directDomains : []);
    setAddresses(Array.isArray(config.routeExcludeAddresses) ? config.routeExcludeAddresses : []);
    const servers = Array.isArray(config.dnsServers) ? config.dnsServers : [];
    setDnsMode(servers.length ? "custom" : "system");
    setDnsServers(servers);
    setDirectInterface(typeof config.directInterface === "string" ? config.directInterface : "");
    setDnsInterface(typeof config.dnsInterface === "string" ? config.dnsInterface : "");
    setStrictRoute(config.strictRoute !== false);
  };

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
      try {
        const value = await readNetCoreNetwork();
        if (cancelled) return;
        setState(value);
        apply(value);
        setError(value.problem ?? "");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const interfaces = state?.interfaces ?? [];
  const defaultExclusions = state?.effective?.defaultExclusions ?? [];
  const redundantOf = (value: string) => defaultExclusions.find((cidr) => covers(value, cidr)) ?? null;

  const addDomain = () => {
    const value = domainDraft.trim().toLowerCase();
    if (!value) return;
    setDomains((current) => current.includes(value) ? current : [...current, value]);
    setDomainDraft("");
    setError(""); setNotice("");
  };
  const addAddress = () => {
    const value = addressDraft.trim();
    if (!value) return;
    setAddresses((current) => current.includes(value) ? current : [...current, value]);
    setAddressDraft("");
    setError(""); setNotice("");
  };
  const addDns = () => {
    const value = dnsDraft.trim();
    if (!value) return;
    setDnsServers((current) => current.includes(value) ? current : [...current, value]);
    setDnsDraft("");
    setError(""); setNotice("");
  };
  // 删掉某一条后，上一次保存失败的原因往往已经不再成立，必须一并清掉。
  const removeFrom = (list: string[], value: string) => { setError(""); setNotice(""); setChecked(null); return list.filter((item) => item !== value); };

  const buildConfig = (): NetCoreNetworkConfig | null => {
    if (dnsMode === "custom" && !dnsServers.length) {
      setError(text("指定 DNS 时至少要填一个地址。", "Provide at least one DNS server when not following the system."));
      return null;
    }
    return {
      ...(domains.length ? { directDomains: domains } : {}),
      ...(dnsMode === "custom" ? { dnsServers } : {}),
      ...(directInterface ? { directInterface } : {}),
      ...(dnsInterface ? { dnsInterface } : {}),
      strictRoute,
      ...(addresses.length ? { routeExcludeAddresses: addresses } : {}),
    };
  };

  // 解析测试永远是「内核真实解析」：普通进程直接查内网 DNS 会被 strict-route 拦住，测了也是假结论。
  const verify = async (name: string) => {
    const target = name.trim();
    if (!target) { setCheckError(text("先填一个域名再测试。", "Enter a domain first.")); return; }
    const config = buildConfig();
    if (!config) return;
    setVerifying(true); setCheckError(""); setChecked(null); setNotice("");
    try {
      const value = await verifyNetCoreDomain(config, target);
      if (!value.ok) { setCheckError(value.reason ?? text("测试失败。", "Test failed.")); return; }
      setChecked(value);
      setState(value);
      apply(value);
      setError(value.problem ?? "");
      onSaved(value);
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally { setVerifying(false); }
  };

  const submit = async (restart: boolean) => {
    const config = buildConfig();
    if (!config) return;
    setWorking(restart ? "restart" : "save");
    setError("");
    setNotice("");
    try {
      const value = await saveNetCoreNetwork(config, restart);
      if (!value.ok) {
        setError(value.reason ?? text("保存失败。", "Saving failed."));
        return;
      }
      setState(value);
      apply(value);
      setError(value.problem ?? "");
      setNotice(restart
        ? text("已保存并重启内核。", "Saved and restarted the kernel.")
        : text("已保存。重启内核后生效。", "Saved. Restart the kernel to apply."));
      onSaved(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const disabled = working !== null || busy || loading;
  const effective = state?.effective ?? null;
  // 摘要说人话：列真实域名/DNS/网卡，不展示内核规则语法，也不摆一堆 0。
  const summary = exemptSummary(zh, { domains, addresses, dnsServers: dnsMode === "custom" ? dnsServers : [], directInterface });

  return <dialog ref={dialog} className="repair-dialog exempt-dialog" aria-labelledby="exempt-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (backdropPointerDown.current && isDialogBackdropEvent(event)) onClose(); backdropPointerDown.current = false; }}
    onPointerDown={(event) => { backdropPointerDown.current = isDialogBackdropEvent(event); }}>
    <div className="repair-dialog__header">
      <div>
        <h2 id="exempt-title">{text("内网直连（VPN / 公司网络）", "Local network direct (VPN / corporate)")}</h2>
      </div>
      <button type="button" className="repair-button repair-button--quiet" onClick={onClose}>{text("关闭", "Close")}</button>
    </div>
    <div className="repair-dialog__body exempt-body">
      <div className="exempt-summary" data-tone={error ? "danger" : state?.pendingRestart ? "warn" : "ok"}>
        <p className="exempt-summary__row">{loading ? text("读取中…", "Loading…") : summary || text("当前没有内网豁免，所有域名按公网处理。", "No local exemptions yet; every domain is treated as public.")}</p>
        {state?.pendingRestart && <p className="exempt-summary__flag">{text("有已保存但尚未生效的改动：需要重启内核。", "Saved changes are not active yet: restart the kernel.")}</p>}
      </div>

      <section className="exempt-section" aria-labelledby="exempt-domains">
        <h3 id="exempt-domains" className="exempt-heading">{text("域名后缀", "Domain suffixes")}
          <button type="button" className="repair-button repair-button--quiet exempt-action"
            title={text("用内核真实解析一次；若有未生效的改动会先重启内核，否则结论不准。", "Resolves through the kernel; pending changes restart it first, otherwise the result would be wrong.")}
            disabled={disabled || verifying || (!domains.length && !domainDraft.trim())}
            onClick={() => void verify(domainDraft.trim() || domains[0] || "")}>
            {verifying ? text("测试中…", "Testing…") : text("测试解析", "Test resolution")}
          </button>
        </h3>
        <p className="netcore-detail">{text("包含所有子域名；不写 http:// 和端口。内网域名必须写在这里，否则解析会交给公网。", "Includes all subdomains; no scheme or port. Internal names must be listed here, otherwise they resolve publicly.")}</p>
        <div className="exempt-add">
          <input className="workspace-interval addconfig-input" aria-label={text("域名后缀", "Domain suffix")} value={domainDraft} placeholder="corp.example" disabled={disabled}
            onChange={(event) => setDomainDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDomain(); } }} />
          <button type="button" className="repair-button repair-button--quiet" onClick={addDomain} disabled={disabled}>{text("添加", "Add")}</button>
        </div>
        {domains.length > 0 && <ul className="exempt-list">
          {domains.map((domain) => <li key={domain} className="exempt-item">
            <span className="exempt-item__value">{domain}</span>
            <span className="exempt-item__note">{text("所有子域名都走直连", "All subdomains go direct")}</span>
            <button type="button" className="exempt-item__remove" aria-label={text(`移除 ${domain}`, `Remove ${domain}`)} disabled={disabled}
              onClick={() => setDomains((current) => removeFrom(current, domain))}>×</button>
          </li>)}
        </ul>}
        {checked && <div className="exempt-check-result" data-tone={checked.addresses.length && !checked.fakeIp ? "ok" : "warn"}>
          <p className="exempt-check-result__row">
            <code>{checked.name}</code>
            <span>{checked.addresses.length ? ` → ${checked.addresses.join(", ")}` : text(" → 没有解析结果", " → no answer")}</span>
            <span className="exempt-item__note">{checked.elapsedMs} ms{checked.restarted ? text("（已按新配置重启内核）", " (kernel restarted with new settings)") : ""}</span>
          </p>
          <p className="exempt-item__note">{checked.fakeIp
            ? text("解析到假地址（198.18.x）：这个域名仍在走代理，检查是否填对域名。", "Resolved to a fake address: this domain is still proxied. Check the domain.")
            : checked.addresses.length
              ? text("解析成功：内网域名已豁免，可以正常访问。", "Resolved: the internal domain is exempt.")
              : text("没有解析结果（NXDOMAIN）：需要填写内网 DNS，或域名写错了。", "No answer (NXDOMAIN): provide the internal DNS, or check the domain.")}</p>
        </div>}
        {checkError && <p className="netcore-alert" role="alert">{checkError}</p>}
      </section>

      <section className="exempt-section" aria-labelledby="exempt-addresses">
        <h3 id="exempt-addresses" className="exempt-heading">{text("IP / CIDR", "IP / CIDR")}</h3>
        <p className="netcore-detail">{text("只对裸 IP 访问生效；私网段已默认放行，这里主要用于公网固定 IP。", "Applies to raw-IP access only; private ranges are already exempt. Use this for public fixed IPs.")}</p>
        <div className="exempt-add">
          <input className="workspace-interval addconfig-input" aria-label={text("IP 或 CIDR", "IP or CIDR")} value={addressDraft} placeholder="203.0.113.7 或 100.64.0.0/10" disabled={disabled}
            onChange={(event) => setAddressDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addAddress(); } }} />
          <button type="button" className="repair-button repair-button--quiet" onClick={addAddress} disabled={disabled}>{text("添加", "Add")}</button>
        </div>
        {addresses.length > 0 && <ul className="exempt-list">
          {addresses.map((address) => {
            const coveredBy = redundantOf(address);
            return <li key={address} className="exempt-item">
              <span className="exempt-item__value">{address}</span>
              {coveredBy
                ? <span className="exempt-item__note">{text(`已由默认私网规则覆盖（${coveredBy}）`, `Already covered by ${coveredBy}`)}</span>
                : <span className="exempt-item__note">{text("直连，不进隧道", "Direct, bypasses the tunnel")}</span>}
              <button type="button" className="exempt-item__remove" aria-label={text(`移除 ${address}`, `Remove ${address}`)} disabled={disabled}
                onClick={() => setAddresses((current) => removeFrom(current, address))}>×</button>
            </li>;
          })}
        </ul>}
      </section>

      <section className="exempt-section" aria-labelledby="exempt-dns">
        <h3 id="exempt-dns" className="exempt-heading">{text("DNS 解析", "DNS resolution")}</h3>
        <div className="exempt-choice" role="group" aria-label={text("DNS 来源", "DNS source")}>
          <label><input type="radio" name="dns-mode" checked={dnsMode === "system"} disabled={disabled} onChange={() => setDnsMode("system")} />{text("跟随系统", "Follow system")}</label>
          <label><input type="radio" name="dns-mode" checked={dnsMode === "custom"} disabled={disabled} onChange={() => setDnsMode("custom")} />{text("指定内网 DNS", "Custom internal DNS")}</label>
        </div>
        {dnsMode === "custom" && <>
          <div className="exempt-add">
            <input className="workspace-interval addconfig-input" aria-label={text("DNS 服务器", "DNS server")} value={dnsDraft} placeholder="10.10.10.5" disabled={disabled}
              onChange={(event) => setDnsDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDns(); } }} />
            <button type="button" className="repair-button repair-button--quiet" onClick={addDns} disabled={disabled}>{text("添加", "Add")}</button>
          </div>
          {dnsServers.length > 0 && <ul className="exempt-list">
            {dnsServers.map((server) => <li key={server} className="exempt-item">
              <span className="exempt-item__value">{server.split("#")[0]}</span>
              <span className="exempt-item__note">{text("内网 DNS", "Internal DNS")}</span>
              <button type="button" className="exempt-item__remove" aria-label={text(`移除 ${server}`, `Remove ${server}`)} disabled={disabled}
                onClick={() => setDnsServers((current) => removeFrom(current, server))}>×</button>
            </li>)}
          </ul>}
        </>}
      </section>

      <section className="exempt-section" aria-labelledby="exempt-nic">
        <h3 id="exempt-nic" className="exempt-heading">{text("网卡", "Network interface")}</h3>
        <div className="addconfig-grid">
          <label>{text("直连网卡", "Direct NIC")}
            <select className="workspace-interval" value={directInterface} disabled={disabled} onChange={(event) => setDirectInterface(event.target.value)}>
              <option value="">{text("自动", "Automatic")}</option>
              {interfaces.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.address}</option>)}
            </select>
          </label>
          <label>{text("DNS 网卡", "DNS NIC")}
            <select className="workspace-interval" value={dnsInterface} disabled={disabled} onChange={(event) => setDnsInterface(event.target.value)}>
              <option value="">{text("跟随直连网卡", "Follow direct NIC")}</option>
              {interfaces.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.address}</option>)}
            </select>
          </label>
        </div>
        <label className="exempt-check">
          <input type="checkbox" checked={strictRoute} disabled={disabled} onChange={(event) => setStrictRoute(event.target.checked)} />
          <span>{text("严格路由（推荐）：阻止进程绕过隧道直连 DNS，关闭会削弱 DNS 防泄漏", "Strict route (recommended): blocks direct DNS outside the tunnel; disabling weakens leak protection")}</span>
        </label>
      </section>

      {effective && <details className="exempt-rule">
        <summary>{text("查看生成的规则（高级）", "Show generated rules (advanced)")}</summary>
        <ul>
          {[...effective.domainRules, ...effective.ipRules].map((rule) => <li key={rule}><code>{rule}</code></li>)}
          {Object.entries(effective.nameserverPolicy ?? {})
            .filter(([domain]) => domains.some((item) => domain === `+.${item}`))
            .map(([domain, servers]) => <li key={domain}><code>{domain} → {servers.join(", ")}</code></li>)}
        </ul>
      </details>}

      {error && <p className="netcore-alert" role="alert">{error}</p>}
      {notice && <p className="exempt-notice" role="status">{notice}</p>}
    </div>
    <footer className="repair-dialog__footer">
      <p className="netcore-detail">{text("保存后写入 ", "Writes ")}{state?.path ?? "net-core-network.json"}{text("；修改网络配置需要重启内核才会生效。", "; restart the kernel to apply network changes.")}</p>
      <button type="button" className="repair-button repair-button--quiet" onClick={() => void submit(false)} disabled={disabled}>{working === "save" ? text("保存中…", "Saving…") : text("保存", "Save")}</button>
      <button type="button" className="repair-button" onClick={() => void submit(true)} disabled={disabled || !state?.canRestart}>{working === "restart" ? text("重启中…", "Restarting…") : text("保存并重启内核", "Save & restart kernel")}</button>
    </footer>
  </dialog>;
}
