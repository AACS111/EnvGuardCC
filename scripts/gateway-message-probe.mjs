import http from "node:http";
import { randomUUID } from "node:crypto";

export const PROBE_SIGNAL_IDS = ["language", "languageVariant", "locale", "requestHeaders", "httpLanguage", "secFetch", "clientHints", "deviceLineage", "claudeTrigger", "claudeLatency"];

// 路由只由服务端创建，调用方不能传入目标地址；令牌从不返回给页面。
export async function probeLiveGateway(server, targets) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("网关未就绪，无法模拟发消息。");
  const token = randomUUID();
  const body = JSON.stringify({ model: "checkcc-local-simulation", max_tokens: 16, messages: [{ role: "user", content: "本地模拟消息验证" }] });
  let received;
  const receiver = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const safeKeys = ["accept-language", "x-checkcc-target-locale", "user-agent", "anthropic-version", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-platform", "x-stainless-os", "x-stainless-runtime", "x-stainless-arch"];
    received = { headers: Object.fromEntries(safeKeys.filter((key) => typeof request.headers[key] === "string").map((key) => [key, request.headers[key]])), headersIntegrity: request.headers["x-api-key"] === "checkcc-local-dummy-key" && request.headers["anthropic-version"] === "2023-06-01" && !request.headers["x-checkcc-simulation"], language: request.headers["accept-language"] ?? "", locale: request.headers["x-checkcc-target-locale"] ?? "", body: text };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "local simulation received" }] }));
  });
  try {
    await new Promise((resolve, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", resolve);
    });
    targets.set(token, new URL(`http://127.0.0.1:${receiver.address().port}`));
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "checkcc-local-dummy-key", "accept-language": "zh-CN,zh;q=0.9", "x-checkcc-target-locale": "zh-CN", "x-checkcc-simulation": token, "user-agent": "EnvGuardCC-Local-Message-Probe/1.0", "x-stainless-os": process.platform, "x-stainless-runtime": "node", "x-stainless-arch": process.arch }, body,
    });
    await response.arrayBuffer();
    return { viaLiveGateway: true, method: "POST", path: "/v1/messages", status: response.status, elapsedMs: Date.now() - started, headersIntegrity: received?.headersIntegrity === true, receivedHeaders: received?.headers ?? {},
      sentLanguage: "zh-CN,zh;q=0.9", receivedLanguage: received?.language ?? "", sentLocale: "zh-CN", receivedLocale: received?.locale ?? "", bodyUnchanged: received?.body === body };
  } finally {
    targets.delete(token);
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
  }
}
