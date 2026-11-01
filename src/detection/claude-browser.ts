import { helperRequest } from "./local-helper";
import { detectionConfig } from "./config";
import type { SignalResult } from "./types";
import type { LocaleCode } from "@/i18n/messages";

const states = ["unavailable", "route_changed", "loading", "challenge", "authentication_required", "access_denied", "rate_limited", "http_error", "network_error", "login_page", "app_ready", "page_loaded"] as const;
export type ClaudeBrowserReport = { state: typeof states[number]; status?: number | null; failureKind?: string; checkedAt: string };

export async function readClaudeBrowser(open = false): Promise<ClaudeBrowserReport> {
  const session = open ? await helperRequest("/session?tokenOnly=1") : null;
  const report = await helperRequest<ClaudeBrowserReport>("/claude-browser", session?.token, open ? { action: "open" } : undefined);
  if (!states.includes(report.state) || !Number.isFinite(Date.parse(report.checkedAt))) throw new Error("浏览器验证服务需要更新，请重启本机助手。");
  return report;
}

export function claudeBrowserSignal(report: ClaudeBrowserReport, locale: LocaleCode): SignalResult {
  const zh = locale.startsWith("zh");
  const labels: Record<ClaudeBrowserReport["state"], [string, string]> = {
    unavailable: ["受控浏览器未连接或目标页面已关闭", "Managed browser disconnected or page closed"],
    route_changed: ["代理配置已变更，请重新接入受控浏览器", "Proxy changed; reconnect the managed browser"],
    loading: ["页面加载中，请稍后复检", "Page loading; check again shortly"],
    challenge: ["网络已通，Cloudflare 要求浏览器验证", "Network connected; Cloudflare browser verification required"],
    authentication_required: ["网站要求身份验证", "Website authentication required"],
    access_denied: ["网站拒绝访问，具体原因未确认", "Website denied access; reason unconfirmed"],
    rate_limited: ["网站限制请求频率，请稍后复检", "Website rate limited the request; retry later"],
    http_error: ["网站返回错误响应", "Website returned an error response"],
    network_error: ["浏览器连接失败", "Browser connection failed"],
    login_page: ["Claude 登录页可访问；账号未验证", "Claude login page accessible; account unverified"],
    app_ready: ["已显示账号菜单和消息输入框；发送消息未验证", "Account menu and message input visible; messaging unverified"],
    page_loaded: ["Claude 页面已加载；账号和聊天功能未验证", "Claude page loaded; account and messaging unverified"],
  };
  const passed = ["login_page", "app_ready", "page_loaded"].includes(report.state);
  const failed = ["network_error", "http_error"].includes(report.state);
  const http = report.status ? ` · HTTP ${report.status}` : "";
  return {
    id: "claudeReachability", label: "claude.ai", value: labels[report.state][zh ? 0 : 1] + http,
    assessment: passed ? "ok" : failed ? "error" : "unknown",
    ...(!passed && !failed ? { observation: "inconclusive" as const, unscored: true } : {}),
    contribution: 0, score: 0, weight: detectionConfig.signals.claudeReachability.weight,
    source: "browser", environment: "browser", testedAt: report.checkedAt,
    detail: zh ? "来自受控浏览器正常打开 claude.ai 的页面与主文档响应，只代表该窗口当前的访问路径。验证页需在窗口内人工完成，再点击复检；不读取或转存 Cookie、账号资料和聊天内容，不自动发送消息。" : "Observed from normal navigation and the main-document response in the managed browser, covering only that window's route. Complete any challenge in the window, then check again. Cookies, account data and conversations are not collected; no messages are sent.",
  };
}
