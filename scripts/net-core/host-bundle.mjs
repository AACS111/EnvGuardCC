// 安装时复制独立宿主运行包，禁止系统服务持续执行用户目录里的可替换脚本。
import { cp, mkdir, readFile, writeFile, lstat, realpath, chmod, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const FILES = ["scripts/net-core/host.mjs", "scripts/net-core.mjs", "scripts/net-core/config.mjs", "scripts/net-core/public-dns.mjs", "scripts/net-core/ports.mjs", "scripts/net-core/guardian.cjs", "scripts/net-core/firewall.mjs", "scripts/net-core/system-ipv6.mjs"];

export function protectedHostRoot(platform = process.platform) {
  if (platform === "darwin") return "/Library/PrivilegedHelperTools/com.envguardcc.kernelhost.bundle";
  if (platform === "win32") return path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "EnvGuardCC", "KernelHost");
  throw new Error("当前平台没有可安装的特权宿主。");
}

async function rejectSymlinkParents(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("特权宿主安装目录不能包含符号链接。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function stageHostBundle({ nodePath = process.execPath, hostScript, binary, destination = protectedHostRoot(), platform = process.platform, run = execute } = {}) {
  if (!hostScript || !binary) throw new Error("宿主安装缺少程序来源。");
  await rejectSymlinkParents(destination);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const secure = async directory => {
    if (platform === "win32") {
      await run("icacls.exe", [directory, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/Q"]);
      await run("icacls.exe", [directory, "/setowner", "*S-1-5-32-544", "/T", "/Q"]);
    } else if (platform === "darwin") {
      await run("/bin/chmod", ["-RN", directory]);
      await run("/usr/sbin/chown", ["-R", "root:wheel", directory]);
      await run("/bin/chmod", ["-R", "go-w", directory]);
    } else throw new Error("当前平台不支持宿主权限设置。");
  };
  // 先保护父目录，再在其中暂存；旧版本仍在运行时保留其不可变文件。
  await secure(destination);
  const stage = path.join(destination, `.install-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const root = path.resolve(path.dirname(hostScript), "../..");
    for (const relative of FILES) {
      const target = path.join(stage, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await cp(path.join(root, relative), target, { dereference: true });
      await chmod(target, 0o644);
    }
    const yamlPackage = createRequire(path.join(root, "package.json")).resolve("yaml/package.json");
    await mkdir(path.join(stage, "node_modules"));
    await cp(await realpath(path.dirname(yamlPackage)), path.join(stage, "node_modules/yaml"), { recursive: true, dereference: true });
    const executable = platform === "win32" ? "node.exe" : "node";
    const kernel = platform === "win32" ? "mihomo.exe" : "mihomo";
    await cp(await realpath(nodePath), path.join(stage, executable));
    await cp(await realpath(binary), path.join(stage, kernel));
    await cp(path.join(root, "third_party/mihomo"), path.join(stage, "third_party/mihomo"), { recursive: true, dereference: true });
    await chmod(path.join(stage, executable), 0o755);
    await chmod(path.join(stage, kernel), 0o755);
    await writeFile(path.join(stage, "package.json"), JSON.stringify({ name: "envguardcc-kernel-host", private: true, type: "module" }));
    const digest = createHash("sha256");
    for (const file of [...FILES, executable, kernel, "node_modules/yaml/package.json"]) digest.update(await readFile(path.join(stage, file)));
    const version = `${digest.digest("hex").slice(0, 20)}-${randomUUID().slice(0, 8)}`;
    await secure(stage);
    await chmod(stage, 0o755);
    const installed = path.join(destination, version);
    await rename(stage, installed);
    return { root: installed, nodePath: path.join(installed, executable), hostScript: path.join(installed, "scripts/net-core/host.mjs"), binary: path.join(installed, kernel) };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
