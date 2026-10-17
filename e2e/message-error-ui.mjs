// 失败轮和正常正文同时可见：静态构建+mock API，无生产数据/模型调用。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { join,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { nativeLaunchBrowserEnv } from './fixtures/native-launch-env.mjs';
import { stableShot } from './fixtures/stable-shot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),dist=join(root,'apps/web/dist');
const out=process.env.SHOT_DIR??join(root,'evidence/beta31-message');await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://x').pathname;try{const b=await readFile(join(dist,path==='/'?'index.html':path));res.writeHead(200,{'content-type':mime[extname(path)]??'text/html'});res.end(b);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
const now=Date.now();const agent={id:'error-test',name:'回复显示检查',avatar:'测',color:'#888',status:'idle',unread:0,model:null};
const msgs=[
 {content:'这是正常回复，必须真实可见。',status:'done',meta:{}},
 {content:'',status:'error',meta:{error:'Request timed out.'}},
 {content:'',status:'error',meta:{thinking:'曾经有思考，但请求失败了',error:'Connection error.'}},
 {content:'',status:'interrupted',meta:{}}
].map((m,i)=>({...m,id:`m${i}`,agent_id:agent.id,conversation_id:'c1',role:'assistant',task_id:null,created_at:now+i,updated_at:now+i}));
try{
 browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:nativeLaunchBrowserEnv()});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',r=>{
  const p=new URL(r.request().url()).pathname;let data={};
  if(p==='/api/system')data={serverId:'fixture',local:true,owner:true,onboarded:true,modelSetupDone:true,mock:true,pi:{version:'1.3.0',compatible:true},sandbox:{mode:'workspace'},tunnel:{enabled:false,state:'off',rendezvous:{state:'off'},named:{}},seq:1};
  else if(p==='/api/agents')data=[agent];
  else if(p==='/api/agents/error-test')data=agent;
  else if(p.endsWith('/conversations'))data={current:'c1',items:[{id:'c1',agent_id:agent.id,title:'显示回归',created_at:now,updated_at:now}]};
  else if(p.endsWith('/messages'))data=msgs;
  else if(p==='/api/models/providers')data={providers:[]};
  else if(p==='/api/channels')data={items:[],publicUrl:null};
  else if(p==='/api/wechat')data={enabled:false,agentIds:[]};
  else if(p==='/api/host-control')data={settings:{enabled:false,agents:'all',apps:[],tiers:{},defaultTier:'bounded'},status:{enabled:false,tiers:{},paused:false,daemon:{state:'off'},platform:'darwin',installed:false},tiers:{},manifest:'',manifestHash:'',permissions:null,activity:{active:false,agent:null,summary:null}};
  else if(p==='/api/memory/providers')data={global:'basic',providers:[]};
  else if(p==='/api/skill-suggest')data={enabled:false};
  else if(p.startsWith('/api/usage/summary'))data={totals:{input:0,output:0,cacheRead:0,cacheWrite:0,cost:0,unknownCalls:0}};
  else if(p==='/api/downloads')data={items:[]};
  else if(p.startsWith('/api/proactive/inbox'))data={items:[],count:0,defaultLevel:'normal'};
  else if(p.endsWith('/computer'))data={separate:false,hasData:null,desktop:{enabled:false,state:'off'}};
  else if(p==='/api/models/picks')data={picks:{}};
  else if(['/api/models','/api/rooms','/api/tasks','/api/agents/error-test/tasks','/api/skills','/api/devices'].includes(p))data=[];
  return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 for(const skin of ['noir','pixel'])for(const mode of ['light','dark']){
  await page.goto(base);
  await page.evaluate(({skin,mode})=>{localStorage.setItem('pia.skin',skin);localStorage.setItem('pia.theme',mode);localStorage.setItem('pia.layout',JSON.stringify({sideCollapsed:true,info:false}));},{skin,mode});
  await page.goto(base+'/?agent=error-test');
  try{await page.getByTestId('msg-error').first().waitFor({timeout:10000});}catch(e){console.log('fixture pageerrors',errors);await page.screenshot({path:join(out,'fixture-failed.png')});throw e;}
  assert.equal(await page.getByTestId('msg-error').count(),2);
  assert.match(await page.getByTestId('msg-error').first().innerText(),/模型服务超时/);
  assert.match(await page.getByTestId('msg-error').nth(1).innerText(),/连不上模型服务/);
  await page.getByTestId('msg-interrupted').waitFor();
  await page.getByText('这是正常回复，必须真实可见。',{exact:true}).waitFor();
  // 让主题自然入场完成，检查文字区域确有面积、颜色可见、祖先未隐藏。
  await stableShot(page,page.locator('.pa-msg.bot').first(),join(out,`message-${skin}-${mode}.png`));
  const hidden=await page.locator('.pa-md,[data-testid="msg-error"],[data-testid="msg-interrupted"]').evaluateAll(els=>els.filter(el=>{
   const b=el.getBoundingClientRect();if(!b.width||!b.height)return true;
   for(let e=el;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return true;}
   const s=getComputedStyle(el);return s.color==='transparent'||s.color==='rgba(0, 0, 0, 0)';
  }).length);
  assert.equal(hidden,0,`${skin}/${mode}: text hidden`);
  console.log(`PASS ${skin}/${mode}: normal body + 2 empty errors + interrupted visible`);
 }
 assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
