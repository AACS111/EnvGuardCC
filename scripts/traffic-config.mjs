import { readFile, writeFile, mkdir, copyFile, rename, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { buildTrafficConfig } from './traffic-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.CHECKCC_STATE_DIR ?? path.join(root, 'node_modules/.check-cc-local');
const stateFile = path.join(state, 'traffic-layer.json');
const pendingFile = path.join(state, 'traffic-layer.prepared.json');
const settingsFile = path.join(state, 'traffic-settings.json');
const app = process.env.CHECKCC_FLCLASH_DIR ?? path.join(process.env.APPDATA ?? '', 'com.follow/clash');
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async file => { try { await access(file); return true; } catch { return false; } };
async function atomic(file, value) { const temp = `${file}.checkcc-tmp`; await writeFile(temp, value, {mode:0o600}); await rename(temp,file); }
async function profilePath() {
  const prefs = JSON.parse(await readFile(path.join(app,'shared_preferences.json'),'utf8'));
  // IDs exceed the JS safe integer range: extract the exact decimal text.
  const match = prefs['flutter.config'].match(/"currentProfileId"\s*:\s*(?:"(\d+)"|(\d+))/);
  if (!match) throw new Error('无法确定 FlClash 当前配置');
  return path.join(app,'profiles',`${match[1] ?? match[2]}.yaml`);
}

export async function prepareTrafficConfig() {
  await mkdir(state,{recursive:true});
  if (!(await exists(settingsFile))) await atomic(settingsFile, JSON.stringify({listenPort:3011,upstreamBasePort:39100,defaultPolicy:'Overseas',allOverseas:true,sites:{domains:['claude.ai','anthropic.com'],ips:[],cidrs:[]}},null,2));
  const settings = JSON.parse(await readFile(settingsFile,'utf8'));
  if (settings.allOverseas !== true) throw new Error('当前版本要求所有海外代理策略经过拦截层');
  const profile = await profilePath(), backup = path.join(state,'traffic-original-profile.yaml');
  let previous = null;
  if (await exists(stateFile)) previous = JSON.parse(await readFile(stateFile,'utf8'));
  if(previous?.applied && (previous.listenPort!==settings.listenPort || Number(new URL(previous.routes[0].upstream).port)!==settings.upstreamBasePort)) throw new Error('已运行时不能直接更换监听端口，请先恢复后重新配置');
  if (previous?.profile && previous.profile !== profile) throw new Error('FlClash 已切换订阅，请先恢复旧配置再准备新配置');
  const current = await readFile(profile,'utf8');
  const original = previous?.applied ? await readFile(backup,'utf8') : current;
  if (previous?.applied && hash(current) !== previous.appliedHash) throw new Error('FlClash 配置已被外部更新；请先核对变化，不覆盖新的订阅');
  const secret = previous?.secret ?? randomBytes(32).toString('hex');
  const built = buildTrafficConfig(yaml.load(original), {...settings,secret});
  const generated = yaml.dump(built.config,{lineWidth:-1,noRefs:true});
  const prepared = {...built,config:undefined,allOverseas:true,profile,originalHash:hash(original),generatedHash:hash(generated),applied:previous?.applied??false,appliedHash:previous?.appliedHash};
  if (!previous?.applied) await atomic(backup,original);
  await atomic(path.join(state,'traffic-prepared-profile.yaml'),generated);
  await atomic(pendingFile,JSON.stringify(prepared,null,2));
  if(!previous?.applied) await atomic(stateFile,JSON.stringify(prepared,null,2));
  console.log(JSON.stringify({state:'prepared',routes:built.routes.map(({id,policy,upstream})=>({id,policy,upstream})),sites:built.sites,settingsFile,profile,config:path.join(state,'traffic-prepared-profile.yaml')}));
  return prepared;
}

async function apply() {
  const config = JSON.parse(await readFile(await exists(pendingFile)?pendingFile:stateFile,'utf8'));
  const current = await readFile(config.profile,'utf8');
  if (hash(current) !== (config.applied ? config.appliedHash : config.originalHash)) throw new Error('原配置发生变化，拒绝覆盖');
  // A listening port is insufficient: verify the authenticated EnvGuardCC service.
  const auth=`Basic ${Buffer.from(`${config.routes[0]?.id}:${config.secret}`).toString('base64')}`;
  const response=await fetch(`http://127.0.0.1:${config.listenPort}/__checkcc/traffic/status`,{headers:{'Proxy-Authorization':auth},signal:AbortSignal.timeout(2000)});
  const report=await response.json();
  if(!response.ok || report.kind!=='checkcc-traffic-layer' || report.version!==1) throw new Error('拦截入口未验证，拒绝应用');
  const generated = await readFile(path.join(state,'traffic-prepared-profile.yaml'),'utf8');
  if (hash(generated) !== config.generatedHash) throw new Error('待应用配置已被修改，请重新准备');
  if(process.platform==='win32') {
    const startup=path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup/EnvGuardCC Traffic Layer.vbs');
    const quote=value=>value.replaceAll('"','""');
    const source=`Set shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & "${quote(process.execPath)}" & Chr(34) & " " & Chr(34) & "${quote(path.join(root,'scripts/traffic-layer.mjs'))}" & Chr(34) & " " & Chr(34) & "${quote(stateFile)}" & Chr(34), 0, False\r\n`;
    if(await exists(startup) && hash(await readFile(startup,'utf8'))!==hash(source)) throw new Error('自启动入口已有其他内容，拒绝覆盖');
    await atomic(startup,source);config.startup={file:startup,hash:hash(source)};
  }
  await atomic(config.profile,generated);
  config.applied=true;config.appliedHash=hash(generated);
  await atomic(stateFile,JSON.stringify(config,null,2));
  await atomic(pendingFile,JSON.stringify(config,null,2));
  console.log('已写入当前 FlClash 配置；须在 FlClash 重新应用当前配置后核对生效状态。尚不代表运行中内核已重载。');
}
async function restore() {
  const config = JSON.parse(await readFile(stateFile,'utf8'));
  if (!config.applied) {console.log('未应用，无需恢复');return;}
  if (hash(await readFile(config.profile,'utf8')) !== config.appliedHash) throw new Error('当前配置被其他程序修改，拒绝覆盖');
  await copyFile(path.join(state,'traffic-original-profile.yaml'),config.profile);
  if(config.startup && await exists(config.startup.file) && hash(await readFile(config.startup.file,'utf8'))===config.startup.hash) await unlink(config.startup.file);
  config.applied=false;delete config.appliedHash;
  await atomic(stateFile,JSON.stringify(config,null,2));
  if(await exists(pendingFile)) await unlink(pendingFile);
  console.log('已恢复原配置；请在 FlClash 重新应用当前配置。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command=process.argv[2]??'prepare';
    if(command==='prepare') await prepareTrafficConfig();
    else if(command==='apply') await apply();
    else if(command==='restore') await restore();
    else if(command==='status') {
      const c=JSON.parse(await readFile(stateFile,'utf8'));
      console.log(JSON.stringify({applied:c.applied,listenPort:c.listenPort,sites:c.sites,routes:c.routes.map(({id,policy,upstream})=>({id,policy,upstream})),settingsFile}));
    } else throw new Error('支持 prepare / apply / restore / status');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
