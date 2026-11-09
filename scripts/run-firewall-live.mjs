// 系统授权只在原生弹窗中发生；不读取或接受账户密码。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { shellQuote } from "./net-core/host-install.mjs";

if (process.platform !== "darwin") throw new Error("此真实系统验收只支持 macOS。");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = `${shellQuote(process.execPath)} ${shellQuote(path.join(root, "scripts/test-firewall-live.mjs"))} --apply`;
try {
  const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-e", "on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run", command], { timeout: 180000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  const directory = path.join(root, "node_modules/.checkcc-dist");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "firewall-live.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  const detail = `${error.stderr ?? ""}\n${error.message}`;
  if (/User canceled|-128/i.test(detail)) throw new Error("系统授权已取消，真实断流测试未完成。");
  const reported = error.stderr?.match(/\{[\s\S]*\}/)?.[0];
  if (reported) {
    const result = JSON.parse(reported);
    const directory = path.join(root, "node_modules/.checkcc-dist");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "firewall-live.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
