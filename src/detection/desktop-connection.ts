export const desktopReadyEvent = 'envguardcc:desktop-ready';

type DesktopSettingsTarget<T> = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
  envGuardDesktop?: { getSettings: () => Promise<T> };
};

// Native injection and React hydration can finish in either order. A page-ready
// event retries an early read; older replies must not overwrite the latest state.
export function observeDesktopSettings<T>({ target, onSettings, onError }: {
  target: DesktopSettingsTarget<T>;
  onSettings: (settings: T) => void;
  onError: (message: string) => void;
}) {
  let active = true, revision = 0;
  const load = () => {
    const bridge = target.envGuardDesktop;
    if (!active || !bridge) return;
    const request = ++revision;
    void Promise.resolve().then(() => bridge.getSettings()).then(settings => {
      if (active && revision === request) onSettings(settings);
    }).catch(error => {
      if (active && revision === request) onError(error instanceof Error ? error.message : String(error));
    });
  };
  target.addEventListener(desktopReadyEvent, load);
  load();
  return () => {
    active = false; revision++;
    target.removeEventListener(desktopReadyEvent, load);
  };
}
