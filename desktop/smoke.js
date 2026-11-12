// Runs only when explicitly requested by the desktop smoke harness.
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, stage = 'startup controls') => {
    for (let i = 0; i < 600; i++) { const value = await read(); if (value) return value; await wait(100); }
    throw new Error('Desktop smoke check timed out: ' + stage);
  };
  try {
    await until(() => document.querySelector('.check-workspace') || document.querySelector('.protection-workspace'));
    await until(() => window.envGuardDesktop);
    const settings = await window.envGuardDesktop.getSettings();
    const settingsButton = await until(() => [...document.querySelectorAll('button')].find(button => (['设置', 'Settings'].includes(button.textContent.trim()) || ['设置', 'Settings'].includes(button.getAttribute('aria-label'))) && button.getClientRects().length > 0));
    settingsButton.click();
    await until(() => document.querySelector('dialog.workspace-settings[open]'));

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
    // Only this isolated smoke instance receives fixture data. Exercise the actual
    // WebView with all 30 particles and proxy/direct/blocked collection navigation.
    document.querySelector('dialog.workspace-settings[open] button[aria-label="关闭设置"], dialog.workspace-settings[open] button[aria-label="Close settings"]').click();
    const originalFetch = window.fetch;
    let flowLayout;
    const collectionQueries = [];
    window.fetch = async (...args) => {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
      if (url.pathname === '/__checkcc/net-core/connections' && url.searchParams.has('route')) collectionQueries.push(Object.fromEntries(url.searchParams));
      if (url.pathname !== '/__checkcc/net-core' || (args[1]?.method && args[1].method !== 'GET')) return originalFetch(...args);
      const sampledAt = new Date().toISOString();
      const netCore = { enabled:true,state:'running',tunEnabled:true,tunCaptured:true,mode:'global',nodes:[],selected:null,routing:{state:'verified',total:30,claude:2,pinned:2,direct:0,violations:[],sampledAt,traffic:{proxied:27,direct:1,blocked:0,unknown:0},paths:{proxied:29,direct:1,blocked:0,unknown:0}},connectionLog:{available:true,sampledAt,scope:'all',activeTotal:30,active:Array.from({length:30},(_,i)=>({id:`layout-${i}`,kind:'connection',host:i===0?'claude.ai':`fixture${i}.example.com`,route:'proxied',isClaude:i===0,chains:['Fixture',i===0?'CLAUDE-PIN':'AUTO-PROXY'],endedAt:null}))}};
      return new Response(JSON.stringify({netCore,exitHistory:null}), {headers:{'Content-Type':'application/json'}});
    };
    try {
      document.getElementById('tab-network').click();
      await until(() => !document.getElementById('panel-network').hidden, 'network panel');
      const recheck = [...document.querySelectorAll('#panel-network button')].find(button => ['复检路由', 'Recheck routing'].includes(button.textContent.trim()));
      recheck?.click();
      const flow = await until(() => { const element = document.querySelector('.workspace-flow'); return element?.querySelector('.workspace-flow__node--proxy')?.textContent.includes('29') && element.querySelectorAll('.workspace-flow__connection').length === 30 ? element : null; }, 'merged proxy fixture');
      if (flow.querySelector('.workspace-flow__node--overseas')) throw new Error('Claude still has a separate proxy exit');
      if (flow.querySelector('.workspace-flow__more')) throw new Error('Unexpected overflow control');
      const unhovered = [...flow.querySelectorAll('.workspace-flow__connection')].find(marker => !marker.matches(':hover') && !marker.matches(':focus-visible') && marker.dataset.revealed !== 'true');
      if (!unhovered) throw new Error('No unfocused particle available for label verification');
      const label = unhovered.querySelector('text');
      const animation = label.querySelector('animate[attributeName="opacity"]');
      if (animation) {
        // Labels now briefly appear during each staggered animation cycle. Test
        // both phases instead of assuming an arbitrary sampled frame is hidden.
        const svg = unhovered.ownerSVGElement;
        const savedTime = svg.getCurrentTime();
        const begin = parseFloat(animation.getAttribute('begin'));
        const duration = parseFloat(animation.getAttribute('dur'));
        svg.pauseAnimations();
        try {
          const sample = async phase => {
            svg.setCurrentTime(((begin + phase) % duration + duration) % duration);
            await wait(100);
            return Number(getComputedStyle(label).opacity);
          };
          if (await sample(0.8) < 0.9) throw new Error('Animated particle label did not appear');
          if (await sample(3) !== 0) throw new Error('Animated particle label did not hide after its display window');
        } finally { svg.setCurrentTime(savedTime); svg.unpauseAnimations(); }
      } else if (getComputedStyle(label).opacity !== '0') throw new Error('Stationary particle label must stay hidden until hover or focus');
      const collections = [];
      for (const item of [{node:'proxy',route:'proxied',state:'active',title:'代理出口连接'}, {node:'direct',route:'direct',state:'active',title:'直连连接'}, {node:'gateway',route:'blocked',state:'all',title:'已拦截连接'}]) {
        flow.querySelector(`.workspace-flow__node--${item.node}`).click();
        const modal = await until(() => {
          const element = document.querySelector('dialog.transfer-log-dialog[open]');
          return element?.querySelector('h2')?.textContent === item.title && collectionQueries.some(query => query.route === item.route && query.state === item.state && query.kind === 'connection') ? element : null;
        }, `${item.route} collection`);
        collections.push({route:item.route,state:item.state,opened:true,queryVerified:true});
        modal.querySelector('button[aria-label="关闭"], button[aria-label="Close"]').click();
        await until(() => !document.querySelector('dialog.transfer-log-dialog[open]'), 'closing collection');
      }
      flowLayout = { proxyConnections:29, visibleParticles:30, labelDisplayVerified:true, singleProxyExit:true, collections };
    } finally { window.fetch = originalFetch; }
    const result = { passed: true, title: document.title, stylesheets: document.styleSheets.length, helper: true, gateway: true, bridge: true, flowLayout, controls: { loginToggleEnabled: !loginToggle.disabled, startupToggleEnabled: !toggle.disabled, resetEnabled: !resetButton.disabled, savedAndRestored: true }, unrelatedPluginDenied: pluginDenied, nodeIntegration: false };
    await window.__TAURI_INTERNALS__.invoke('smoke_result', { result });
  } catch (error) {
    await window.__TAURI_INTERNALS__.invoke('smoke_result', { result: { passed: false, error: error.message } });
  }
})();
