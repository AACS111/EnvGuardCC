// Keep the machine awake without preventing the display from switching off.
export function watchDesktopPower({ powerMonitor, powerSaveBlocker, readReport, notify,
  every = setInterval, stop = clearInterval }) {
  let blocker = null, reading = false, disposed = false;
  const release = () => {
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    blocker = null;
  };
  const refresh = async () => {
    if (disposed || reading) return;
    reading = true;
    try {
      const report = await readReport();
      if (disposed) return;
      if (report.enabled || report.desiredEnabled) {
        if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      } else release();
    } catch { /* Keep the current blocker during a transient helper outage. */ }
    finally { reading = false; }
  };
  const wake = () => { if (!disposed) { notify(); void refresh(); } };
  for (const event of ['resume', 'unlock-screen']) powerMonitor.on(event, wake);
  const timer = every(() => void refresh(), 2500);
  void refresh();
  return () => {
    disposed = true; stop(timer);
    for (const event of ['resume', 'unlock-screen']) powerMonitor.removeListener(event, wake);
    release();
  };
}
