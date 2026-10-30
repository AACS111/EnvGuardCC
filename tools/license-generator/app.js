const get = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="issuer-token"]').content;
let issued = null, publicKey = '';
async function request(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(10000),
    headers: { 'X-CheckCC-Issuer-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '生成器请求失败。');
  return value;
}
function error(message = '') { get('form-error').textContent = message; get('form-error').hidden = !message; }
function saveFile(filename, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function clearResult() {
  issued = null; get('result').hidden = true; get('license').value = ''; get('copy-status').textContent = '';
}
get('issue-form').addEventListener('input', () => { clearResult(); if (publicKey) error(); });
get('issue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (get('issue').disabled) return;
  clearResult(); error();
  const uuid = get('account').value.trim(), usageHours = Number(get('days').value) * 24;
  get('issue').disabled = true; get('issue').textContent = '正在生成…'; get('issue-form').setAttribute('aria-busy', 'true');
  // Prevent an edited form from showing a result signed for its previous values.
  get('account').readOnly = true; get('days').readOnly = true;
  try {
    issued = await request('/api/issue', { accountUuid: uuid, usageHours });
    get('license').value = issued.code; get('result-account').textContent = uuid.toLowerCase();
    get('issued-at').textContent = new Date(issued.issuedAt).toLocaleString();
    get('activate-before').textContent = new Date(issued.activateBefore).toLocaleString();
    get('usage').textContent = `${issued.usageHours / 24} 天`;
    get('result').hidden = false; get('license').focus();
  } catch (failure) { error(failure.message || '生成失败，请重试。'); }
  finally { get('issue').disabled = false; get('issue').textContent = '生成授权码'; get('issue-form').removeAttribute('aria-busy'); get('account').readOnly = false; get('days').readOnly = false; }
});
get('copy').addEventListener('click', async () => {
  if (!issued) return;
  get('copy').disabled = true;
  try { await navigator.clipboard.writeText(issued.code); get('copy-status').textContent = '授权码已复制。'; }
  catch { get('license').focus(); get('license').select(); get('copy-status').textContent = '无法自动复制，已选中授权码，请按 Ctrl+C。'; }
  finally { get('copy').disabled = false; }
});
get('download').addEventListener('click', () => {
  if (issued) saveFile(`EnvGuardCC-${issued.id}.license.json`, JSON.stringify(issued, null, 2), 'application/json');
});
get('public-key').addEventListener('click', () => { if (publicKey) saveFile('checkcc-license-public.pem', publicKey, 'application/x-pem-file'); });
async function connect() {
  try {
    const info = await request('/api/info'); publicKey = info.publicKey;
    get('fingerprint').textContent = `SHA-256：${info.fingerprint}`;
    get('public-key').disabled = false; get('issue').disabled = false; get('issue').textContent = '生成授权码';
  } catch { error('无法连接本机生成器，请确认进程正在运行，再刷新页面重试。'); get('fingerprint').textContent = '公钥尚未加载。'; get('issue').textContent = '生成器未连接'; }
}
void connect();
