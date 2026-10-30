import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulationCases } from "./simulation-catalog.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createSimulationRunner({ root = projectRoot, timeoutMs = 60000, messageProbe = async () => null } = {}) {
  let job = null;
  let child = null;
  const contextMatches = (context) => Boolean(context.profile && context.cloak.enabled && context.profile.updatedAt === job?.profileUpdatedAt && context.cloak.updatedAt === job?.cloakUpdatedAt);
  const snapshot = (context) => {
    if (!job) return { version: 1, kind: "local-simulation-only", state: "idle", running: false, scenarios: [], signalResults: {} };
    const current = contextMatches(context);
    const signalResults = {};
    for (const scenario of job.scenarios) for (const id of scenario.signals) {
      const result = signalResults[id] ?? { completed: 0, total: 0, failed: 0, state: "running" };
      result.total++;
      if (scenario.state === "passed" || scenario.state === "failed") result.completed++;
      if (scenario.state === "failed") result.failed++;
      result.state = !current ? "stale" : result.failed ? "failed" : result.completed === result.total ? "passed" : job.state === "failed" ? "failed" : "running";
      signalResults[id] = result;
    }
    return { ...job, state: !current ? "stale" : job.state, running: job.state === "running", current, completed: job.scenarios.filter((s) => s.state === "passed" || s.state === "failed").length, passed: job.scenarios.filter((s) => s.state === "passed").length, total: simulationCases.length, signalResults };
  };
  const start = async (context) => {
    if (job?.state === "running") return snapshot(context);
    if (!context.profile || !context.cloak.enabled) throw new Error("请先开启优化并配置出口目标。");
    const id = randomUUID();
    const output = path.join(process.env.CHECKCC_STATE_DIR || path.join(root, "node_modules", ".check-cc-simulation"), "runs", id);
    job = { version: 1, kind: "local-simulation-only", runId: id, state: "running", startedAt: new Date().toISOString(), finishedAt: null,
      profileUpdatedAt: context.profile.updatedAt, cloakUpdatedAt: context.cloak.updatedAt,
      target: { language: context.profile.language, locale: context.profile.locale, timezone: context.profile.timezone },
      scenarios: simulationCases.map((item) => ({ ...item, state: "pending" })), error: null,
      uncovered: ["浏览器字体与WebRTC", "真实TLS与出口路径", "真实账号鉴权与支付资格", "服务端风控决策"],
    };
    const run = job;
    let buffer = "";
    let settled = false;
    const finish = async (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const report = JSON.parse(await readFile(path.join(output, "latest.json"), "utf8"));
        for (const row of report.scenarios ?? []) {
          const item = run.scenarios.find((entry) => entry.id === row.id);
          if (item) item.state = row.passed ? "passed" : "failed";
        }
        let livePassed = false;
        try {
          run.messageProbe = await messageProbe(context);
          const probe = run.messageProbe;
          const expectedLanguage = context.profile.language === "en" ? "en-US" : context.profile.language;
          livePassed = Boolean(probe?.viaLiveGateway && probe.status === 200 && probe.bodyUnchanged && probe.headersIntegrity && probe.receivedLanguage.split(",")[0] === expectedLanguage && probe.receivedLocale === context.profile.locale);
        } catch { /* 活跃链路失败不能被隔离协议测试的通过结果覆盖。 */ }
        if (!livePassed) {
          const headers = run.scenarios.find((entry) => entry.id === "headers");
          if (headers) headers.state = "failed";
        }
        run.state = !error && code === 0 && report.allPassed && run.scenarios.every((row) => row.state === "passed") ? "passed" : "failed";
      } catch { run.state = "failed"; }
      run.error = run.state === "failed" ? error ?? "部分本地自检未通过，请重试或查看测试报告。" : null;
      run.finishedAt = new Date().toISOString();
      child = null;
    };
    let timer;
    try {
      await mkdir(output, { recursive: true });
      const environment = { ...process.env, CHECKCC_SIMULATION_OUTPUT: output, CHECKCC_SIMULATION_TARGET: JSON.stringify(run.target) };
      if (process.versions.electron && !process.env.CHECKCC_NODE_EXECUTABLE) environment.ELECTRON_RUN_AS_NODE = "1";
      delete environment.NODE_TEST_CONTEXT;
      child = spawn(process.env.CHECKCC_NODE_EXECUTABLE || process.execPath, ["--test", path.join(root, "scripts", "check-gateway-simulation.mjs")], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop().slice(-16384);
        for (const line of lines) {
          const marker = line.indexOf("CHECKCC_SIMULATION_EVENT ");
          if (marker < 0) continue;
          try {
            const event = JSON.parse(line.slice(marker + 25));
            const item = run.scenarios.find((entry) => entry.id === event.id);
            if (item && typeof event.passed === "boolean") item.state = event.passed ? "passed" : "failed";
          } catch { /* Ignore non-event test output. */ }
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", () => { void finish(1, "无法启动本地自检进程。"); });
      child.once("close", (code) => { void finish(code); });
      timer = setTimeout(() => { child?.kill(); void finish(1, "本地自检超时，请重试。"); }, timeoutMs);
    } catch { void finish(1, "无法启动本地自检进程。"); }
    return snapshot(context);
  };
  return { start, snapshot, dispose: () => { child?.kill(); } };
}
