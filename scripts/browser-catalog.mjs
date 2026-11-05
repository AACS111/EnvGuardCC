// 本地浏览器清单与接入偏好。
//
// 边界：已经在运行的浏览器无法被接管（没有调试端口）。这里能做的「直接接入」是——
// 用你选中的浏览器可执行文件拉起一个**受管实例**（独立 user-data-dir + 调试端口），
// 再在它的渲染进程里注入迷惑层。受管实例关闭后释放，不影响你日常用的那份配置。
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

// family 决定接入方式：chromium 走 CDP；firefox 不支持，列出来只是为了让人看见「为什么不接入」。
export const BROWSER_TABLE = {
  win32: [
    { id: "chrome", name: "Google Chrome", family: "chromium", paths: ["%ProgramFiles%/Google/Chrome/Application/chrome.exe", "%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe", "%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe"] },
    { id: "edge", name: "Microsoft Edge", family: "chromium", paths: ["%ProgramFiles(x86)%/Microsoft/Edge/Application/msedge.exe", "%ProgramFiles%/Microsoft/Edge/Application/msedge.exe"] },
    { id: "brave", name: "Brave", family: "chromium", paths: ["%ProgramFiles%/BraveSoftware/Brave-Browser/Application/brave.exe", "%LOCALAPPDATA%/BraveSoftware/Brave-Browser/Application/brave.exe"] },
    { id: "vivaldi", name: "Vivaldi", family: "chromium", paths: ["%LOCALAPPDATA%/Vivaldi/Application/vivaldi.exe", "%ProgramFiles%/Vivaldi/Application/vivaldi.exe"] },
    { id: "chromium", name: "Chromium", family: "chromium", paths: ["%LOCALAPPDATA%/Chromium/Application/chrome.exe", "%ProgramFiles%/Chromium/Application/chrome.exe"] },
    { id: "firefox", name: "Mozilla Firefox", family: "gecko", paths: ["%ProgramFiles%/Mozilla Firefox/firefox.exe", "%ProgramFiles(x86)%/Mozilla Firefox/firefox.exe"] },
  ],
  darwin: [
    { id: "chrome", name: "Google Chrome", family: "chromium", paths: ["/Applications/Google Chrome.app"] },
    { id: "edge", name: "Microsoft Edge", family: "chromium", paths: ["/Applications/Microsoft Edge.app"] },
    { id: "brave", name: "Brave", family: "chromium", paths: ["/Applications/Brave Browser.app"] },
    { id: "vivaldi", name: "Vivaldi", family: "chromium", paths: ["/Applications/Vivaldi.app"] },
    { id: "chromium", name: "Chromium", family: "chromium", paths: ["/Applications/Chromium.app"] },
    { id: "firefox", name: "Mozilla Firefox", family: "gecko", paths: ["/Applications/Firefox.app"] },
  ],
  linux: [
    { id: "chrome", name: "Google Chrome", family: "chromium", paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] },
    { id: "edge", name: "Microsoft Edge", family: "chromium", paths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"] },
    { id: "brave", name: "Brave", family: "chromium", paths: ["/usr/bin/brave-browser", "/usr/bin/brave"] },
    { id: "chromium", name: "Chromium", family: "chromium", paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"] },
    { id: "firefox", name: "Mozilla Firefox", family: "gecko", paths: ["/usr/bin/firefox"] },
  ],
};

const expand = (value, env, home) => value
  .replace(/%([A-Za-z0-9_()]+)%/g, (_, key) => env[key] ?? "")
  .replace(/^~(?=$|\/)/, home);

export function browserCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const table = BROWSER_TABLE[platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux"] ?? [];
  return table.map((entry) => ({
    id: entry.id, name: entry.name, family: entry.family,
    supported: entry.family === "chromium",
    paths: entry.paths.map((item) => expand(item, env, home)).filter(Boolean),
  }));
}

/** 只做存在性探测；不读浏览器配置、不启动进程。 */
export async function detectInstalledBrowsers({ platform, env, home, exists = defaultExists } = {}) {
  const browsers = [];
  for (const candidate of browserCandidates({ platform, env, home })) {
    let executable = null;
    for (const candidatePath of candidate.paths) {
      if (await exists(candidatePath)) { executable = candidatePath; break; }
    }
    browsers.push({
      id: candidate.id, name: candidate.name, family: candidate.family,
      supported: candidate.supported, installed: Boolean(executable), path: executable,
    });
  }
  return browsers;
}

async function defaultExists(target) {
  try { await access(target); return true; } catch { return false; }
}

/**
 * 选择一个可接入的浏览器：已安装、受支持、未被排除；preferred 优先，其余按清单顺序。
 * 无候选时返回 null（调用方必须如实报错，不许回退到「任意浏览器」）。
 */
export function pickBrowser(browsers, preference = {}) {
  const excluded = new Set(Array.isArray(preference.excluded) ? preference.excluded : []);
  const usable = browsers.filter((browser) => browser.installed && browser.supported && !excluded.has(browser.id));
  if (!usable.length) return null;
  return usable.find((browser) => browser.id === preference.preferred) ?? usable[0];
}

export function browserPreferencePath(stateDir) {
  return path.join(stateDir, "browser-cloak.json");
}

const VALID_IDS = new Set(Object.values(BROWSER_TABLE).flat().map((entry) => entry.id));

/** 偏好只接受已知 id 的数组/字符串；写坏的值被丢弃而不是让接入静默失败。 */
export function normalizeBrowserPreference(value) {
  const excluded = Array.isArray(value?.excluded) ? [...new Set(value.excluded.filter((id) => VALID_IDS.has(id)))] : [];
  const preferred = typeof value?.preferred === "string" && VALID_IDS.has(value.preferred) ? value.preferred : null;
  return { excluded, preferred };
}

export async function loadBrowserPreference(stateDir) {
  try { return normalizeBrowserPreference(JSON.parse(await readFile(browserPreferencePath(stateDir), "utf8"))); }
  catch { return { excluded: [], preferred: null }; }
}

export async function saveBrowserPreference(stateDir, value) {
  const preference = normalizeBrowserPreference(value);
  const file = browserPreferencePath(stateDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(preference, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return preference;
}

// 各浏览器的用户数据根目录：只用来取书签（Default/Bookmarks），不复制登录态与扩展。
export const BROWSER_USER_DATA = {
  win32: {
    chrome: "%LOCALAPPDATA%/Google/Chrome/User Data",
    edge: "%LOCALAPPDATA%/Microsoft/Edge/User Data",
    brave: "%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data",
    vivaldi: "%LOCALAPPDATA%/Vivaldi/User Data",
    chromium: "%LOCALAPPDATA%/Chromium/User Data",
  },
  darwin: {
    chrome: "~/Library/Application Support/Google/Chrome",
    edge: "~/Library/Application Support/Microsoft Edge",
    brave: "~/Library/Application Support/BraveSoftware/Brave-Browser",
    vivaldi: "~/Library/Application Support/Vivaldi",
    chromium: "~/Library/Application Support/Chromium",
  },
  linux: {
    chrome: "~/.config/google-chrome",
    edge: "~/.config/microsoft-edge",
    brave: "~/.config/BraveSoftware/Brave-Browser",
    vivaldi: "~/.config/vivaldi",
    chromium: "~/.config/chromium",
  },
};

export function browserUserDataRoot(browserId, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const table = BROWSER_USER_DATA[platform] ?? BROWSER_USER_DATA.linux;
  const template = table[browserId];
  return template ? expand(template, env, home) : null;
}

/**
 * 给受管实例补一份书签：受管实例默认是干净配置，带上 Daily 书签能少一次「怎么什么都没有」的困惑。
 * 只复制 Bookmarks 这一个纯 JSON 文件——登录态、扩展、Cookie 一律不碰（它们带完整性校验，复制了也不生效）。
 */
export async function seedManagedProfile({ browserId, profileDir, platform, env, home, exists = defaultExists, copy = defaultCopy } = {}) {
  const root = browserUserDataRoot(browserId, { platform, env, home });
  if (!root || !profileDir) return null;
  const source = path.join(root, "Default", "Bookmarks");
  const target = path.join(profileDir, "Default", "Bookmarks");
  // 统一用 / 表示，避免 Windows 上混出反斜杠导致路径判断不一致。
  const slash = (value) => value.split(String.fromCharCode(92)).join("/");
  if (await exists(slash(target))) return null;
  if (!(await exists(slash(source)))) return null;
  await copy(source, target);
  return "bookmarks";
}

async function defaultCopy(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}
