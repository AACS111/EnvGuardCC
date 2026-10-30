import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildTrafficConfig, normalizeSites, splitRule } from './traffic-rules.mjs';
import { createTrafficLayer } from './traffic-layer.mjs';

const secret=randomBytes(32).toString('hex');
test('保留原节点和直连/拒绝规则，所有代理规则经拦截层并通过专用入口回原组',()=>{
  const original={proxies:[{name:'node',type:'ss',server:'example.org'}],'proxy-groups':[{name:'Overseas',type:'select',proxies:['node']}],rules:['DOMAIN,a.test,Overseas','GEOIP,CN,DIRECT,no-resolve','DOMAIN,b.test,REJECT','MATCH,Overseas']};
  const built=buildTrafficConfig(original,{secret,sites:{domains:['*.force.test'],ips:['8.8.8.8'],cidrs:['2001:db8::/32']}});
  assert.equal(original.proxies.length,1);assert.equal(built.routes.length,1);
  assert.ok(built.config.rules.includes('GEOIP,CN,DIRECT,no-resolve'));
  assert.ok(built.config.rules.includes('DOMAIN,b.test,REJECT'));
  assert.ok(built.config.rules.some(rule=>rule.startsWith('DOMAIN-SUFFIX,force.test,EnvGuardCC-')));
  assert.ok(built.config.rules.some(rule=>rule.startsWith('IP-CIDR,8.8.8.8/32,EnvGuardCC-')));
  assert.ok(built.config.rules.some(rule=>rule.startsWith('IP-CIDR6,2001:db8::/32,EnvGuardCC-')));
  assert.equal(built.config.listeners[0].proxy,'Overseas');
  assert.equal(built.config.proxies.at(-1).udp,false);
  assert.equal(built.config.rules.at(-1),`MATCH,${built.config.proxies.at(-1).name}`);
});
test('逻辑规则、子规则、IPv6 及错误配置不能绕过策略校验',()=>{
  assert.deepEqual(splitRule('AND,((NETWORK,TCP),(DOMAIN,a.test)),Overseas'),['AND','((NETWORK,TCP),(DOMAIN,a.test))','Overseas']);
  assert.throws(()=>normalizeSites({ips:['bad']}));assert.throws(()=>normalizeSites({cidrs:['::1/129']}));assert.throws(()=>normalizeSites({domains:['https://example.com/']}));
  const c={proxies:[{name:'Overseas'}],rules:['SUB-RULE,(NETWORK,TCP),sub'],'sub-rules':{sub:['MATCH,Overseas']}};
  const built=buildTrafficConfig(c,{secret});assert.match(built.config['sub-rules'].sub[0],/^MATCH,EnvGuardCC-/);
  assert.throws(()=>buildTrafficConfig({...c,'mixed-port':3011},{secret}),/冲突/);
});

async function fixture(run) {
  const received=[];
  const upstreamSockets=new Set();
  const upstream=http.createServer((req,res)=>{received.push({url:req.url,auth:req.headers['proxy-authorization']});res.end('through-original-group');});
  upstream.on('connection',socket=>{upstreamSockets.add(socket);socket.on('close',()=>upstreamSockets.delete(socket));});
  upstream.on('connect',(req,socket,head)=>{received.push({url:req.url,auth:req.headers['proxy-authorization']});socket.on('error',()=>{});socket.write('HTTP/1.1 200 OK\r\n\r\n');if(head.length)socket.write(head);socket.on('data',chunk=>socket.write(chunk));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const config={version:1,secret,listenPort:0,routes:[{id:'test',upstream:`http://127.0.0.1:${upstream.address().port}`}]};
  const layer=createTrafficLayer({loadConfig:async()=>config});
  await new Promise(resolve=>layer.server.listen(0,'127.0.0.1',resolve));config.listenPort=layer.server.address().port;
  const auth=`Basic ${Buffer.from(`test:${secret}`).toString('base64')}`;
  try {await run({config,port:config.listenPort,auth,received,layer});}
  finally {await layer.close();for(const socket of upstreamSockets)socket.destroy();await new Promise(resolve=>upstream.close(resolve));}
}
function request(port,auth,url='http://remote.test/') {
  return new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:url,headers:auth?{'Proxy-Authorization':auth}:{}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);});
}
test('HTTP 必须认证，原域名交给原组，拦截层密钥不转发给远端',async()=>fixture(async({port,auth,received})=>{
  assert.equal((await request(port)).status,407);
  assert.equal((await request(port,auth)).body,'through-original-group');
  assert.deepEqual(received,[{url:'http://remote.test/',auth:undefined}]);
  assert.equal((await request(port,auth,'http://127.0.0.1/')).status,400);
}));
test('CONNECT 原样转发加密字节，不解密 TLS、不把认证发往回程',async()=>fixture(async({port,auth,received})=>{
  const payload=Buffer.from([22,3,1,0,4,255,0,128,42]);
  await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method:'CONNECT',path:'unknown.test:443',headers:{'Proxy-Authorization':auth}});
    req.on('error',reject);
    req.on('connect',(res,socket)=>{assert.equal(res.statusCode,200);socket.once('data',data=>{try{assert.deepEqual(data,payload);socket.destroy();resolve();}catch(error){reject(error);}});socket.on('error',reject);socket.write(payload);});req.end();
  });
  assert.deepEqual(received,[{url:'unknown.test:443',auth:undefined}]);
}));
test('错误回程和自代理配置拒绝连接，不能自动绕过直连',async()=>fixture(async({port,auth,config})=>{
  config.routes[0].upstream=`http://127.0.0.1:${port}`;
  assert.equal((await request(port,auth)).status,407);
  config.routes[0].upstream='http://example.org:7890';
  assert.equal((await request(port,auth)).status,407);
}));
test('准备新的域名/IP 列表不改动已生效的配置及运行链路',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'checkcc-prepare-'));
  const app=path.join(directory,'flclash'),state=path.join(directory,'state');
  try {
    await mkdir(path.join(app,'profiles'),{recursive:true});
    await writeFile(path.join(app,'shared_preferences.json'),JSON.stringify({'flutter.config':'{"currentProfileId":370409826729070592}'}));
    const profile=JSON.stringify({proxies:[{name:'Overseas',type:'http',server:'example.com',port:443}],rules:['MATCH,Overseas']});
    await writeFile(path.join(app,'profiles/370409826729070592.yaml'),profile);
    const run=()=>promisify(execFile)(process.execPath,[new URL('./traffic-config.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),'prepare'],{env:{...process.env,CHECKCC_STATE_DIR:state,CHECKCC_FLCLASH_DIR:app}});
    await run();
    const activeFile=path.join(state,'traffic-layer.json');
    const active=JSON.parse(await readFile(activeFile,'utf8'));active.applied=true;active.appliedHash=createHash('sha256').update(profile).digest('hex');
    await writeFile(activeFile,JSON.stringify(active));
    const settingsFile=path.join(state,'traffic-settings.json'),settings=JSON.parse(await readFile(settingsFile,'utf8'));settings.sites.domains.push('new.example.com');
    await writeFile(settingsFile,JSON.stringify(settings));
    const before=await readFile(activeFile,'utf8');await run();
    assert.equal(await readFile(activeFile,'utf8'),before);
    assert.equal(await readFile(path.join(app,'profiles/370409826729070592.yaml'),'utf8'),profile);
    assert.ok(JSON.parse(await readFile(path.join(state,'traffic-layer.prepared.json'),'utf8')).sites.domains.includes('new.example.com'));
  } finally {await rm(directory,{recursive:true,force:true});}
});
