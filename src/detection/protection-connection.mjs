// Browser events also cover the web build; the desktop sends the same wake signal.
export function watchProtectionConnection(onWake, {
  target = window, page = document, now = Date.now,
  later = setTimeout, cancel = clearTimeout, every = setInterval, stop = clearInterval,
} = {}) {
  let timer = null;
  let resume = false;
  let lastTick = now();
  const wake = event => {
    if (event === true || event?.type === 'online' || event?.type === 'checkcc:resume') resume = true;
    if (timer !== null) return;
    timer = later(() => { timer = null; const requested = resume; resume = false; onWake({ resume: requested }); }, 1000);
  };
  const visible = () => { if (page.visibilityState === 'visible') wake(); };
  const events = ['online', 'focus', 'pageshow', 'checkcc:resume'];
  for (const event of events) target.addEventListener(event, wake);
  page.addEventListener('visibilitychange', visible);
  const heartbeat = every(() => {
    const current = now();
    if (current - lastTick > 15000 || current < lastTick) wake(true);
    lastTick = current;
  }, 5000);
  return () => {
    for (const event of events) target.removeEventListener(event, wake);
    page.removeEventListener('visibilitychange', visible);
    if (timer !== null) cancel(timer);
    stop(heartbeat);
  };
}
