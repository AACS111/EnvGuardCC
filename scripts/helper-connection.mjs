export const HELPER_PROTOCOL = 7;

export function assertCurrentHelper(session) {
  if (!/^[a-f0-9]{64}$/.test(session?.token ?? '')) throw new Error('本机助手返回了无效会话。');
  if (session.helperProtocol !== HELPER_PROTOCOL || session.shutdown !== 1 || session.desktopLauncher !== 1) {
    throw new Error('本机助手版本过旧，不支持当前应用的退出恢复和 Claude 启动。请重新启动 EnvGuardCC 开发服务及旧的 repair:helper。');
  }
}

export async function shutdownHelper(url, origin, session, stopServer = false) {
  const headers = { Origin: origin, 'X-CheckCC-Client': 'repair-ui' };
  if (!session) {
    const response = await fetch(url + '/session', { headers, signal: AbortSignal.timeout(5000) });
    session = await response.json();
    if (!response.ok) throw new Error(session.error ?? '无法连接本机恢复服务。');
  }
  assertCurrentHelper(session);
  const response = await fetch(url + '/shutdown', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CheckCC-Token': session.token }, body: JSON.stringify({ stopServer }), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  if (!response.ok || result.restored !== true) throw new Error(result.error ?? '本机配置恢复未完成。');
}
