import test from "node:test";
import assert from "node:assert/strict";
import { classifyTakeoverProcesses, createNetworkTakeover } from "./net-core/takeover.mjs";

const gui = { pid: 101, uid: 501, executable: "/Applications/FlClash.app/Contents/MacOS/FlClash" };
const kernel = { pid: 102, uid: 0, executable: "/Applications/FlClash.app/Contents/MacOS/mihomo" };
const own = { pid: 103, uid: 0, executable: "/Library/PrivilegedHelperTools/com.envguardcc.kernelhost.bundle/version/mihomo" };
const macExec = async (file, args) => file === "/sbin/route" ? "interface: en0\n" : args[0] === "--proxy" ? "<dictionary> {}" : "";

test("自动退出只识别确切客户端与当前用户，不按模糊名称强杀内核", () => {
  const result = classifyTakeoverProcesses([gui, kernel, own,
    { ...gui, pid: 104, uid: 502 },
    { ...gui, pid: 105, executable: "/Applications/MyFlClashBackup.app/Contents/MacOS/FlClash" },
    { ...gui, pid: 106, executable: "/Applications/FlClash.app/Contents/MacOS/Browser" },
  ], { platform: "darwin", uid: 501 });
  assert.deepEqual(result.clients.map(c => c.pid), [101]);
  assert.deepEqual(result.kernels.map(c => c.pid), [102]);
  const windows = classifyTakeoverProcesses([
    { pid: 1, executable: "C:\\Apps\\FlClash.exe" },
    { pid: 2, executable: "C:\\Apps\\MyFlClash.exe" },
  ], { platform: "win32" });
  assert.deepEqual(windows.clients.map(c => c.pid), [1]);
});

test("先正常退出 GUI，等待后台内核消失，再检查路由、代理与端口", async () => {
  let scans = 0; const events = [];
  const takeover = createNetworkTakeover({ platform: "darwin", uid: 501,
    listProcesses: async () => ++scans === 1 ? [gui, kernel, own] : scans === 2 ? [kernel, own] : [own],
    exec: async (file, args) => { events.push(file); return macExec(file, args); },
    pause: async () => { events.push("wait"); },
    canBind: async port => { events.push(port); return true; },
  });
  const result = await takeover.prepare({ ports: [39080, 39090], proxyPort: 39080 });
  assert.equal(result.phase, "ready"); assert.deepEqual(result.closed, ["FlClash"]);
  assert.deepEqual(events, ["/usr/bin/osascript", "wait", "/usr/sbin/scutil", "/sbin/route", "/usr/sbin/scutil", 39080, 39090]);
});

test("退出失败、内核重启或扫描权限不足均阻止接管，不发送强杀命令", async () => {
  const calls = [];
  const takeover = createNetworkTakeover({ platform: "darwin", uid: 501, attempts: 2,
    listProcesses: async () => [gui, kernel], pause: async () => {},
    exec: async (file, args) => { calls.push([file, args]); return ""; },
  });
  await assert.rejects(takeover.prepare(), /仍未退出.*FlClash.*mihomo/);
  assert.equal(takeover.status().phase, "blocked");
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/usr/bin/osascript");
  const unavailable = createNetworkTakeover({ listProcesses: async () => { throw new Error("permission denied"); } });
  await assert.rejects(unavailable.prepare(), /permission denied/);
});

test("未知 VPN、默认隧道路由、残留系统代理与占用端口分别给出可操作错误", async () => {
  for (const [scenario, message] of [["vpn", /系统仍有/], ["route", /utun4/], ["proxy", /HTTP 代理/], ["pac", /PAC/], ["port", /39090/]]) {
    const takeover = createNetworkTakeover({ platform: "darwin", listProcesses: async () => [],
      exec: async (file, args) => {
        if (scenario === "vpn" && args[0] === "--nc") return '* (Connected) uuid "Company VPN"';
        if (scenario === "route" && file === "/sbin/route") return "interface: utun4\n";
        if (scenario === "proxy" && args[0] === "--proxy") return "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\n";
        if (scenario === "pac" && args[0] === "--proxy") return "ProxyAutoConfigEnable : 1\n";
        return macExec(file, args);
      }, canBind: async () => scenario !== "port",
    });
    await assert.rejects(takeover.prepare({ ports: [39090], proxyPort: 39080 }), message);
    assert.equal(takeover.status().phase, "blocked");
  }
});

test("Windows 使用窗口退出，进程路径改变时不关闭复用的 PID", async () => {
  let scans = 0, closes = 0;
  const takeover = createNetworkTakeover({ platform: "win32", listProcesses: async () => {
    scans++;
    if (scans === 1) return [{ pid: 10, executable: "C:\\Apps\\FlClash.exe" }];
    return [{ pid: 10, executable: "C:\\Apps\\Browser.exe" }];
  }, exec: async () => { closes++; return ""; } });
  assert.equal((await takeover.prepare()).phase, "ready");
  assert.equal(closes, 0);
});

test("独立代理服务不是客户端退出目标，未占用出口和端口时允许本机自托管节点继续运行", async () => {
  const takeover = createNetworkTakeover({ platform: "darwin", listProcesses: async () => [{ pid: 99, uid: 501, executable: "/usr/local/bin/xray" }], exec: macExec, canBind: async () => true });
  assert.equal((await takeover.prepare({ ports: [39090] })).phase, "ready");
});
