// Choose the protection policy before starting a kernel with a saved TUN state.
// Protection itself starts and verifies TUN when auto-start is enabled.
export async function startDesktopServices({ kernel, autoStartProtection, configureProtection, stopping = () => false, logger = () => {} }) {
  if (stopping()) return;
  if (kernel.enabled && !autoStartProtection) {
    if (!await kernel.start()) logger('[net-core] 内核未能启动，页面会显示未启用原因。');
    else kernel.connectionLog?.start();
    if (stopping()) return;
    kernel.startAutoRefresh?.();
    kernel.startPublicDnsSync?.();
  } else if (!kernel.enabled) {
    logger('[net-core] 未启用：' + kernel.reason);
  }
  if (stopping()) return;
  try { await configureProtection(autoStartProtection); }
  catch (error) {
    // Cancelled authorization or failed environment adaptation must not remove
    // the ordinary proxy that remains available when protection is disabled.
    if (autoStartProtection && kernel.enabled && !stopping()) {
      try { await kernel.start(); }
      catch (fallback) { logger('[net-core] 本机代理启动失败：' + fallback.message); }
    }
    throw error;
  }
}
