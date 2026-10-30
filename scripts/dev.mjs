import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./claude-gateway.mjs";
import { startRepairHelper } from "./local-repair.mjs";
import { startConfiguredTrafficLayer } from "./traffic-layer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export async function startGateway(port = 3010) {
  const url = `http://127.0.0.1:${port}`;
  const server = createGateway({ upstreamBase: process.env.CHECKCC_UPSTREAM || "https://api.anthropic.com" });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    server.removeAllListeners("error");
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  } catch (error) {
    server.close();
    if (error.code !== "EADDRINUSE") throw error;
    try {
      const response = await fetch(`${url}/__checkcc/status`, {
        headers: { "X-CheckCC-Client": "gateway-ui", Origin: "http://localhost:3000" },
        signal: AbortSignal.timeout(2000),
      });
      const report = await response.json();
      if (response.ok && report.version === 1 && ["node-native-direct", "node-native-proxy"].includes(report.transport) && typeof report.upstream === "string") {
        return { server: null, url };
      }
    } catch { /* 被其他服务占用或网关未就绪时明确报错。 */ }
    throw new Error(`端口 ${port} 已被占用，且不是可用的 EnvGuardCC 网关。请关闭占用程序后重试。`);
  }
}

export async function startDev(args = process.argv.slice(2), { handleSignals = true } = {}) {
  // 浏览器端固定访问 3010，避免沿用自定义端口后出现“网页正常、网关离线”。
  if (process.env.CHECKCC_GATEWAY_PORT && process.env.CHECKCC_GATEWAY_PORT !== "3010") {
    throw new Error("npm run dev 使用网关端口 3010，请移除 CHECKCC_GATEWAY_PORT 后重试。");
  }
  const traffic = await startConfiguredTrafficLayer(path.join(root,"node_modules/.check-cc-local/traffic-layer.json"));
  let gateway;
  try { gateway = await startGateway(); } catch(error) { await traffic?.close(); throw error; }
  let helper;
  try { helper = await startRepairHelper(); } catch (error) { gateway.server?.close(); await traffic?.close(); throw error; }
  process.stdout.write(`[dev] 本机助手 ${helper.url}\n`);
  process.stdout.write(`[dev] ${gateway.server ? "已启动" : "复用已有"}网关 ${gateway.url}\n`);
  let next;
  let stopping;
  const stop = (code = 0) => {
    if (stopping) return stopping;
    stopping = (async () => {
      // Restoration still calls the live gateway and controlled pages.
      await helper.closeRuntime();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      gateway.server?.closeAllConnections();
      const closeGateway = gateway.server
        ? new Promise((resolve) => gateway.server.close(resolve))
        : Promise.resolve();
      if (next?.pid && next.exitCode === null && next.signalCode === null) {
        const exited = new Promise((resolve) => next.once("exit", resolve));
        if (process.platform === "win32") {
          // Next 会派生工作进程；Windows 上清理整棵子进程树。
          await new Promise((resolve) => {
            const killer = spawn("taskkill", ["/PID", String(next.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.once("error", () => { next.kill(); resolve(); });
            killer.once("exit", resolve);
          });
        } else {
          next.kill("SIGTERM");
        }
        const timer = setTimeout(() => next.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(timer);
      }
      await closeGateway;
      await traffic?.close();
      if (helper.server) { helper.server.closeAllConnections(); await new Promise((resolve) => helper.server.close(resolve)); }
      process.exitCode = code;
    })().catch(error => { stopping = null; throw error; });
    return stopping;
  };
  const onSignal = () => { void stop().catch(error => console.error('[dev] 自动恢复未完成：' + error.message)); };
  if (handleSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  gateway.server?.on("error", (error) => {
    process.stderr.write(`[dev] 网关异常：${error.message}\n`);
    void stop(1);
  });
  try {
    next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", ...args], {
      cwd: root, stdio: "inherit", windowsHide: true,
    });
    next.once("error", (error) => {
      process.stderr.write(`[dev] Next 启动失败：${error.message}\n`);
      void stop(1);
    });
    next.once("exit", (code, signal) => { void stop(code ?? (signal ? 1 : 0)); });
  } catch (error) {
    await stop(1);
    throw error;
  }
  return { stop, child: next };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDev().catch((error) => {
    process.stderr.write(`[dev] ${error.message}\n`);
    process.exitCode = 1;
  });
}
