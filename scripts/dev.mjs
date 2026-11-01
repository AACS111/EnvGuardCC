import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./claude-gateway.mjs";
import { startRepairHelper } from "./local-repair.mjs";
import { startConfiguredTrafficLayer } from "./traffic-layer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

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
    await closeServer(server);
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
  const traffic = await startConfiguredTrafficLayer(path.join(process.env.CHECKCC_STATE_DIR || path.join(root,"node_modules/.check-cc-local"),"traffic-layer.json"));
  let gateway, helper, next;
  try {
    gateway = await startGateway();
    helper = await startRepairHelper();
  } catch (error) {
    // Release only listeners this launcher acquired; reused services stay untouched.
    try { await closeServer(gateway?.server); } catch { /* Preserve the startup error. */ }
    try { await traffic?.close(); } catch { /* Preserve the startup error. */ }
    throw error;
  }
  process.stdout.write(`[dev] 本机助手 ${helper.url}\n`);
  process.stdout.write(`[dev] ${gateway.server ? "已启动" : "复用已有"}网关 ${gateway.url}\n`);
  let stopping;
  const stopNext = async () => {
    if (!next?.pid || next.exitCode !== null || next.signalCode !== null) return;
    const exited = new Promise((resolve) => next.once("exit", resolve));
    let timer;
    try {
      if (process.platform === "win32") {
        // Next 会派生工作进程；Windows 上清理整棵子进程树。
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(next.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { try { next.kill(); } catch { /* The timeout below is the last resort. */ } resolve(); });
          killer.once("exit", resolve);
        });
      } else {
        try { next.kill("SIGTERM"); } catch { /* The timeout below is the last resort. */ }
      }
      timer = setTimeout(() => { try { next.kill("SIGKILL"); } catch { /* Already gone. */ } }, 5000);
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = (code = 0) => {
    if (stopping) return stopping;
    stopping = (async () => {
      const failures = [];
      const attempt = async (description, operation) => {
        try { await operation(); } catch (error) { failures.push(`${description}：${error.message}`); }
      };
      // Restoration still calls the live gateway and controlled pages.
      try { await helper.closeRuntime(); }
      catch (error) { stopping = null; throw error; }
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await attempt("关闭网关", () => closeServer(gateway.server));
      await attempt("关闭 Next", stopNext);
      await attempt("关闭流量层", () => traffic?.close());
      await attempt("关闭本机助手", () => closeServer(helper.server));
      process.exitCode = failures.length ? (code || 1) : code;
      if (failures.length) throw new Error(failures.join("；"));
    })();
    return stopping;
  };
  const reportStopFailure = error => process.stderr.write(`[dev] 自动恢复未完成：${error.message}\n`);
  const onSignal = () => { void stop().catch(reportStopFailure); };
  if (handleSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  gateway.server?.on("error", (error) => {
    process.stderr.write(`[dev] 网关异常：${error.message}\n`);
    void stop(1).catch(reportStopFailure);
  });
  try {
    next = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", ...args], {
      cwd: root, stdio: "inherit", windowsHide: true,
    });
    next.once("error", (error) => {
      process.stderr.write(`[dev] Next 启动失败：${error.message}\n`);
      void stop(1).catch(reportStopFailure);
    });
    next.once("exit", (code, signal) => { void stop(code ?? (signal ? 1 : 0)).catch(reportStopFailure); });
  } catch (error) {
    try { await stop(1); } catch (cleanupError) { error.message += `；清理失败：${cleanupError.message}`; }
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
