/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node child-process entry point. */
// 父应用即使被 SIGKILL，写管道也会关闭；守护进程收到 EOF 后回收内核。
const { spawn } = require('node:child_process');
const [binary, ...args] = process.argv.slice(2);
if (!binary) process.exit(1);
const kernel = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
let stopping = false;
let timer;
function stop() {
  if (stopping) return;
  stopping = true;
  kernel.kill('SIGTERM');
  timer = setTimeout(() => kernel.kill('SIGKILL'), 1500);
}
kernel.once('spawn', () => {
  if (!process.connected) { stop(); return; }
  process.send({ type: 'kernel-pid', pid: kernel.pid }, error => { if (error) stop(); });
});
kernel.once('error', error => { console.error(error.message); process.exit(1); });
kernel.once('exit', code => { clearTimeout(timer); process.exit(stopping ? 0 : (code ?? 1)); });
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
