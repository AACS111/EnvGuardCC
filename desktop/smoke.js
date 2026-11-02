// Runs only when explicitly requested by the desktop smoke harness.
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async read => {
    for (let i = 0; i < 600; i++) { const value = await read(); if (value) return value; await wait(100); }
    throw new Error('Desktop smoke check timed out');
  };
  try {
    await until(() => document.querySelector('.check-workspace') || document.querySelector('.protection-workspace'));
    await until(() => window.envGuardDesktop);
    const settings = await window.envGuardDesktop.getSettings();
    const desktopToggle = () => [...document.querySelectorAll('input[role="switch"]')].find(input => ['启动后自动开启保护', 'Enable protection on startup'].includes(input.getAttribute('aria-label')));
    const toggle = await until(() => { const input = desktopToggle(); return input && !input.disabled ? input : null; });
    const resetButton = await until(() => [...document.querySelectorAll('button')].find(button => ['恢复初始化', 'Reset local data'].includes(button.textContent.trim()) && !button.disabled));
    // Exercise the actual React control, not just a direct bridge call. This profile
    // is isolated and startup has already completed; restore the setting immediately.
    toggle.click();
    await until(async () => toggle.checked && (await window.envGuardDesktop.getSettings()).autoStartProtection);
    toggle.click();
    await until(async () => !toggle.checked && !(await window.envGuardDesktop.getSettings()).autoStartProtection);
    const loginToggle = await until(() => [...document.querySelectorAll('input[role="switch"]')].find(input => ['开机自启动', 'Launch at login'].includes(input.getAttribute('aria-label'))));
    await until(() => !settings.canOpenAtLogin || !loginToggle.disabled);
    // Local permission for our fixed bridge must not grant plugin commands.
    let pluginDenied = false;
    try { await window.__TAURI_INTERNALS__.invoke('plugin:autostart|is_enabled'); }
    catch (error) { pluginDenied = /not allowed|not permitted|denied/i.test(String(error)); }
    if (!pluginDenied) throw new Error('Unrelated autostart plugin command was not denied by ACL');
    const ports = globalThis.__CHECKCC_PORTS__;
    const helper = await (await fetch(`http://127.0.0.1:${ports.helper}/protection`, { headers: { 'X-CheckCC-Client': 'repair-ui' } })).json();
    const gateway = await (await fetch(`http://127.0.0.1:${ports.gateway}/__checkcc/status`, { headers: { 'X-CheckCC-Client': 'gateway-ui' } })).json();
    if (typeof helper.enabled !== 'boolean' || gateway.version !== 1 || typeof settings.autoStartProtection !== 'boolean') throw new Error('Desktop services or native bridge unavailable');
    if (typeof require !== 'undefined' || globalThis.process?.versions?.electron) throw new Error('Renderer has Node integration');
    const result = { passed: true, title: document.title, stylesheets: document.styleSheets.length, helper: true, gateway: true, bridge: true, controls: { loginToggleEnabled: !loginToggle.disabled, startupToggleEnabled: !toggle.disabled, resetEnabled: !resetButton.disabled, savedAndRestored: true }, unrelatedPluginDenied: pluginDenied, nodeIntegration: false };
    await window.__TAURI_INTERNALS__.invoke('smoke_result', { result });
  } catch (error) {
    await window.__TAURI_INTERNALS__.invoke('smoke_result', { result: { passed: false, error: error.message } });
  }
})();
