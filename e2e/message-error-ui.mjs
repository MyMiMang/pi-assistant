// 失败轮和正常正文同时可见：静态构建+mock API，无生产数据/模型调用。
// 覆盖：Codex 额度耗尽 / 普通 429 / 未知对象错误 / 旧空记录兜底 / 工具占位不误插 / 390 窄屏。
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
 {role:'assistant',content:'这是正常回复，必须真实可见。',status:'done',meta:{}},
 {role:'assistant',content:'',status:'error',meta:{error:'Request timed out.'}},
 {role:'assistant',content:'',status:'error',meta:{thinking:'曾经有思考，但请求失败了',error:'Connection error.'}},
 {role:'assistant',content:'',status:'interrupted',meta:{}},
 // Codex 额度耗尽：旧实现归成「限流，可以重发」，这里必须说清额度，并给等额度恢复/换模型
 {role:'assistant',content:'',status:'error',meta:{error:'429 {"error":{"type":"usage_limit_reached","message":"You have hit your ChatGPT usage limit for gpt-5-codex"}}'}},
 // 普通 429：不能冒充额度耗尽
 {role:'assistant',content:'',status:'error',meta:{error:'429 rate_limit_exceeded: Too Many Requests'}},
 // 未知对象错误：不能 [object Object]，保留服务原文
 {role:'assistant',content:'',status:'error',meta:{error:{message:'some provider said no'}}},
 // 合法tool-only中间记录在步骤前，正常收尾在步骤后；不能因为本轮有工具就吞掉最终空失败。
 {role:'user',content:'帮我查一下目录'},
 {role:'assistant',content:'',status:'done',meta:{}},
 {role:'tool',content:'',status:'done',meta:{toolName:'ls',args:{path:'/tmp'},result:'a.txt'}},
 {role:'assistant',content:'目录已读取。',status:'done',meta:{}},
 // 旧记录空最终回合：必须兜底可见
 {role:'user',content:'再试一次'},
 {role:'assistant',content:'',status:'done',meta:{}},
 {role:'system',content:'后台任务「报告」失败：usage_limit_reached',status:'error',meta:{kind:'task-error',taskTitle:'报告',error:'usage_limit_reached: You have hit your ChatGPT usage limit.'}}
].map((m,i)=>({meta:{},...m,id:`m${i}`,agent_id:agent.id,conversation_id:'c1',task_id:null,created_at:now+i,updated_at:now+i}));
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
  else if(['/api/models','/api/rooms','/api/subagents','/api/skills','/api/devices'].includes(p))data=[];
  return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const skins=['noir','pixel'],modes=['light','dark'];
 for(const skin of skins)for(const mode of modes){
  await page.setViewportSize({width:1280,height:900});
  await page.goto(base);
  await page.evaluate(({skin,mode})=>{localStorage.setItem('pia.skin',skin);localStorage.setItem('pia.theme',mode);localStorage.setItem('pia.layout',JSON.stringify({sideCollapsed:true,info:false}));},{skin,mode});
  await page.goto(base+'/?agent=error-test');
  try{await page.getByTestId('msg-error').first().waitFor({timeout:10000});}catch(e){console.log('fixture pageerrors',errors);await page.screenshot({path:join(out,'fixture-failed.png')});throw e;}
  const errs=page.getByTestId('msg-error');
  assert.equal(await errs.count(),5,'超时/连接/额度/429/未知 各一条错误');
  assert.match(await errs.nth(0).innerText(),/模型服务超时/);
  assert.match(await errs.nth(1).innerText(),/连不上模型服务/);
  const quota=errs.nth(2);
  assert.equal(await quota.getAttribute('data-kind'),'quota');
  assert.match(await quota.innerText(),/额度/);
  assert.doesNotMatch(await quota.innerText(),/重发/,'额度耗尽不能只叫用户重发');
  assert.match(await quota.innerText(),/额度恢复|换一个可用模型/);
  await quota.getByTestId('msg-error-detail').locator('summary').click();
  assert.match(await quota.getByTestId('msg-error-detail').innerText(),/ChatGPT usage limit/,'详情里能看到服务返回信息');
  const rate=errs.nth(3);
  assert.equal(await rate.getAttribute('data-kind'),'rate_limit','普通 429 不能被归成额度');
  assert.match(await rate.innerText(),/限流/);
  assert.doesNotMatch(await rate.innerText(),/额度/);
  const unknown=errs.nth(4);
  assert.equal(await unknown.getAttribute('data-kind'),'unknown');
  assert.match(await unknown.innerText(),/some provider said no/,'未知错误保留服务原文');
  assert.doesNotMatch(await unknown.innerText(),/\[object Object\]/);
  await page.getByTestId('msg-interrupted').waitFor();
  // 旧空记录只有 1 条兜底；工具占位回合不能也插一条
  assert.equal(await page.getByTestId('msg-empty').count(),1,'旧空记录兜底可见且只插一次');
  assert.match(await page.getByTestId('msg-empty').innerText(),/未收到回复|没收到回复/);
  await page.getByText('这是正常回复，必须真实可见。',{exact:true}).waitFor();
  const background=page.getByTestId('system-model-error');
  await background.waitFor();
  assert.equal(await background.getAttribute('data-kind'),'quota');
  assert.match(await background.innerText(),/后台任务「报告」失败.*额度已用完/s);
  assert.doesNotMatch(await background.innerText(),/重发/,'后台额度失败也不能只叫用户重发');
  // 让主题自然入场完成，检查文字区域确有面积、颜色可见、祖先未隐藏。
  await quota.scrollIntoViewIfNeeded();
  await stableShot(page,quota,join(out,`message-${skin}-${mode}.png`));
  const hidden=await page.locator('.pa-md,[data-testid="msg-error"],[data-testid="msg-interrupted"],[data-testid="msg-empty"]').evaluateAll(els=>els.filter(el=>{
   const b=el.getBoundingClientRect();if(!b.width||!b.height)return true;
   for(let e=el;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return true;}
   const s=getComputedStyle(el);return s.color==='transparent'||s.color==='rgba(0, 0, 0, 0)';
  }).length);
  assert.equal(hidden,0,`${skin}/${mode}: text hidden`);
  // 390 宽手机：错误正文与详情仍可见、不横向溢出、不被只藏在 title 里
  await page.setViewportSize({width:390,height:844});
  await quota.scrollIntoViewIfNeeded();
  await stableShot(page,quota,join(out,`message-${skin}-${mode}-390.png`));
  assert.ok((await quota.innerText()).length>0,'窄屏错误正文可见');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  assert.ok(overflow<=1,`${skin}/${mode} 390: 横向溢出 ${overflow}px`);
  const quotaBox=await quota.boundingBox();
  assert.ok(quotaBox&&quotaBox.width>0&&quotaBox.width<=390,`${skin}/${mode} 390: 错误文本有可见宽度`);
  console.log(`PASS ${skin}/${mode}: 正常正文 + 超时/连接/额度/429/未知 + 中断 + 旧空记录（含 390 宽）`);
 }
 assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
