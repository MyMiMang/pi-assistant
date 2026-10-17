// 撤下选择器后的有限回归：真实隔离服务/页面，不启动电脑、模型或外部服务。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from './fixtures/temp-server.mjs';
import { stableShot } from './fixtures/stable-shot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const run=makeTempRun('pia-removal-ui-');
const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const base=`http://127.0.0.1:${port}`;
const srv=startTempServer({root,port,run});
const out=process.env.SHOT_DIR??join(run.runDir,'shots');mkdirSync(out,{recursive:true});
let browser;
const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
try {
 const deadline=Date.now()+20000;
 while(true){try{if((await fetch(base+'/api/system')).ok)break;}catch{}if(Date.now()>deadline)throw Error('server startup timeout');await new Promise(r=>setTimeout(r,100));}
 await api('/api/settings','PUT',{onboarded:true});
 const a=await api('/api/agents','POST',{name:'直接操作回归'});
 const p=await api('/api/models/custom','POST',{name:'本地假模型',api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',noKey:true,models:[{id:'anthropic.claude-sonnet-5',reasoning:true}]});
 await api(`/api/agents/${a.id}`,'PATCH',{model:{provider:p.id,id:'anthropic.claude-sonnet-5'}});
 browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:browserEnv(run)});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 const failures=[];page.on('pageerror',e=>failures.push(e.message));
 for(const [setting,selector,file] of [['host','host-settings','host.png'],['computer','desktop-settings','desktop.png'],['models','model-services','models.png']]){
  await page.goto(`${base}/?settings=${setting}`);
  // 模型服务根节点名称由当前UI决定；设置弹窗在所有页面均存在。
  const panel=page.getByTestId(setting==='models'?'settings-dialog':selector);
  await panel.waitFor({state:'visible'});
  await page.waitForTimeout(350);
  for(const id of ['host-fast-computer','fast-computer-hostpc','desktop-fast-computer','host-local-laya','local-laya-card','benchmark-open'])assert.equal(await page.getByTestId(id).count(),0,`${setting}: removed ${id}`);
  assert.ok(!/快速操作模型|实际操作测试/.test(await panel.innerText()),`${setting}: removed copy`);
  if(setting==='host')assert.ok(await page.getByTestId('host-tiers').count());
  if(setting==='computer')assert.equal(await page.getByTestId('desktop-enabled').count(),1);
  await stableShot(page,panel,join(out,file));
  console.log(`PASS ${setting}: direct settings retained; selector absent`);
 }
 const downloads=await api('/api/downloads');assert.ok(!(downloads.items??[]).some(x=>x.id==='local-laya'));
 // SPA可能对已撤API返回index.html；不能仅以HTTP200判断API仍存在。
 for(const path of ['/api/fast-computer/settings','/api/fast-computer/benchmark','/api/local-models/laya/status']){
  const r=await fetch(base+path);const ct=r.headers.get('content-type')??'';assert.ok(r.status===404||!ct.includes('application/json'),`${path}: unexpectedly mounted`);
 }
 await page.goto(`${base}/?agent=${a.id}`);
 const chip=page.getByTestId('model-picker');await chip.waitFor();await chip.click();
 await page.getByTestId('model-picker-compact').waitFor();
 assert.equal(await page.getByRole('slider').count(),1);
 assert.equal(await page.getByTestId('thinking-fast').count(),1);
 await stableShot(page,page.getByTestId('model-picker-compact'),join(out,'chat-fast-retained.png'));
 assert.deepEqual(failures,[]);
 console.log('PASS removed HTTP/download registration; chat Fast/slider retained; no page errors');
} finally {await browser?.close();await srv.stop();cleanupTempRun(run);}
