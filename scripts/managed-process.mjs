// Only call with a child process created and retained by this EnvGuardCC instance.
export async function stopManagedProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed); };
    const exited = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => failed(new Error('受控客户端未退出，临时代理配置尚未释放。')), 5000);
    child.once('exit', exited); child.once('error', failed);
    try { child.kill(); }
    catch (error) { failed(error); }
  });
}
