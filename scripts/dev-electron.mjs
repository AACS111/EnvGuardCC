import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDev } from "./dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const url = "http://127.0.0.1:3030";

// npm is not always next to the node executable (notably Homebrew installs it
// under the shared prefix). Resolve an existing CLI before spawning process.execPath.
export function resolveNpmCli({
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  env = process.env,
  exists = existsSync,
} = {}) {
  const nodeDir = path.dirname(execPath);
  const candidates = [];
  if (npmExecPath) candidates.push(npmExecPath);
  candidates.push(
    path.join(nodeDir, "npm"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  if (env.HOMEBREW_PREFIX) candidates.push(path.join(env.HOMEBREW_PREFIX, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  // Homebrew's Cellar path, /opt/homebrew/Cellar/node/<version>/bin/node, has npm
  // in the enclosing prefix rather than in the Cellar directory itself.
  let directory = nodeDir;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(path.join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const found = candidates.find(candidate => candidate && exists(candidate));
  if (found) return found;
  throw new Error("未找到 npm，无法安装 Electron。请先安装 npm，或使用 npm run dev:electron 启动。");
}

async function electronExecutable() {
  for (const resolver of [require, createRequire(path.join(root, "node_modules/.checkcc-desktop-build/package.json"))]) {
    try { return resolver("electron"); } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  // Match the isolated Electron installation used by desktop:package.
  const toolsDir = path.join(root, "node_modules/.checkcc-desktop-build");
  const npmCli = resolveNpmCli();
  console.log("[dev:electron] 首次启动，正在安装 Electron…");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, "install", "--prefix", toolsDir, "--save-exact", "electron@42.11.18"], {
      cwd: root, windowsHide: true, stdio: "inherit",
      env: { ...process.env, npm_config_cache: path.join(toolsDir, "cache"), ELECTRON_CACHE: path.join(toolsDir, "electron-cache") },
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Electron 安装失败：${code}`)));
  });
  return createRequire(path.join(toolsDir, "package.json"))("electron");
}

async function main() {
  const executable = await electronExecutable();
  // Explicit port prevents Next from silently switching to another port.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(3030, "127.0.0.1", () => probe.close(resolve));
  });
  const dev = await startDev(["--hostname", "127.0.0.1", "--port", "3030"], { handleSignals: false });
  let desktop, desktopExited, stopping;
  const report = error => process.stderr.write(`[dev:electron] ${error.message}\n`);
  const stop = (code = 0) => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        if (desktop && desktop.exitCode === null && desktop.signalCode === null && desktop.pid) {
          // Ask Electron to quit normally so its before-quit hooks can run.
          try { desktop.stdin.end("quit\n"); } catch { /* Electron may already be gone. */ }
          await desktopExited;
        }
      } finally {
        try { await dev.stop(code); }
        finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
      }
    })();
    return stopping;
  };
  const onSignal = () => { void stop().catch(report); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  dev.child.once("exit", (code, signal) => { void stop(code ?? (signal ? 1 : 0)).catch(report); });
  try {
    const deadline = Date.now() + 90000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      if (dev.child.exitCode !== null || dev.child.signalCode !== null) throw new Error("Next 开发服务已退出。");
      try { ready = (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* Wait for compilation. */ }
      if (ready) break;
      await delay(250);
    }
    if (stopping) return await stopping;
    if (!ready) throw new Error("等待 Next 开发服务超时。");
    const env = { ...process.env, CHECKCC_DESKTOP_DEV_URL: url };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = spawn(executable, [path.join(root, "desktop/main.mjs")], {
      cwd: root, env, windowsHide: false, stdio: ["pipe", "inherit", "inherit"],
    });
    desktop.stdin.on("error", () => { /* Electron may already have exited. */ });
    desktopExited = new Promise((resolve, reject) => {
      desktop.once("error", reject);
      desktop.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    await stop(await desktopExited);
  } catch (error) {
    try { await stop(1); } catch (cleanupError) { error.message += `；清理失败：${cleanupError.message}`; }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[dev:electron] ${error.message}`);
    process.exitCode = 1;
  });
}
