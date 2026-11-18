/** 真实模型设置复用/作用域与主题切换：仅临时Mock数据。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from './fixtures/temp-server.mjs';
import { infoTab, openAgentModelPop } from './fixtures/info-pane.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)), run=makeTempRun('pia-workspace-model-theme-');
const port=await new Promise(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`, server=startTempServer({root,port,run});
const out=join(root,'artifacts/right-workspace/model-theme');mkdirSync(out,{recursive:true});
const j=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
const wait=async(fn)=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn().catch(()=>false))return;await new Promise(r=>setTimeout(r,100));}throw Error('condition timed out');};
let browser;
try {
 await wait(async()=> (await fetch(base+'/api/system')).ok);await j('/api/settings','PUT',{onboarded:true});
 const a=await j('/api/agents','POST',{name:'工作区模型设置长名称测试助理',model:{provider:'mock',id:'echo-think'},thinking:'low'});
 const b=await j('/api/agents','POST',{name:'另一个对象',model:{provider:'mock',id:'echo'},thinking:'off'});
 browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:browserEnv(run)});
 const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}),errors=[],patches=[];
 const mockCatalog=await j('/api/models');
 await page.route('**/api/models',route=>route.fulfill({json:mockCatalog.map(m=>m.provider==='mock'?{...m,fast:{capability:'supported',reason:'临时Mock能力'}}:m)}));
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='PATCH'&&r.url().includes('/api/agents/'))patches.push({url:r.url(),body:r.postDataJSON()});});
 await page.goto(`${base}/?agent=${a.id}`);
 const openModel=async()=>{
  await page.locator('[data-testid="right-workspace"][data-scope*="conversation:"]:not([data-scope$="conversation:"])').waitFor({state:'attached'});
  await page.getByTestId('workspace-reopen').click();await page.getByTestId('workspace-model-open').click();
 };
 await openModel();
 const detail=page.locator(`[data-workspace-key="settings:agent:${a.id}"]`);
 const panel=detail.getByTestId('agent-model-settings');await panel.waitFor();
 await detail.getByTestId('agent-context').waitFor();
 const node=await panel.elementHandle();
 const modelInWorkspace='[data-testid=right-workspace] [data-testid=agent-model-settings]';
 const modelPop=()=>openAgentModelPop(page);
 let pop=await modelPop();await pop.getByRole('slider').waitFor();await pop.getByRole('slider').press('End');
 await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).thinking!=='low');
 pop=await modelPop();await pop.getByTestId('thinking-fast').click();await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).fast===true);
 const saved=(await j('/api/agents')).find(x=>x.id===a.id);assert.equal((await j('/api/agents')).find(x=>x.id===b.id).model.id,'echo');
 // Model control remains the existing picker; select a different real Mock catalog entry.
 if(await pop.getByTestId('thinking-model-name').count())await pop.getByTestId('thinking-model-name').click();
 else if(await pop.getByTestId('thinking-model').count())await pop.getByTestId('thinking-model').click();
 const search=page.getByTestId('model-search').last();await search.waitFor();await search.fill('echo');const option=page.locator('[data-testid=model-option][data-model="mock/echo"]').last();await option.click();await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).model.id==='echo');
 if(await page.getByTestId('model-picker-compact').isVisible())await page.keyboard.press('Escape');
 const n=patches.length;await page.getByTestId('workspace-expand').click();await page.getByTestId('workspace-restore').click();await page.getByTestId('workspace-collapse').click();await page.getByTestId('workspace-reopen').click();
 assert.equal(await node.evaluate((el,selector)=>el===document.querySelector(selector),modelInWorkspace),true);assert.equal(patches.length,n,'view lifecycle never saves');
 // Switch appearance through real settings controls without page reload; retained content stays mounted.
 await page.goto(`${base}/?settings=appearance&agent=${a.id}`);await page.locator('[data-theme-id="pixel"]').waitFor();
 await page.getByTestId('copy-pixel').click();await page.getByTestId('theme-designer').waitFor();
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 const custom=await page.evaluate(()=>JSON.parse(localStorage.getItem('pia.customThemes')||'[]')[0]?.id);assert.ok(custom,'formal copy creates valid DIY manifest');
 await openModel();await panel.waitFor();const stable=await panel.elementHandle();
 const colors=[];
 for(const skin of ['noir','glass','warm','pixel',`custom-${custom}`]){
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByTestId('settings-nav').locator('button[data-tab=appearance]').click();
  await page.locator(`button[data-theme-id="${skin}"]`).click();
  for(const [label, mode] of [['浅色','light'],['深色','dark']]){
   await page.getByRole('button',{name:label,exact:true}).click();await page.keyboard.press('Escape');
   assert.equal(await stable.evaluate((el,selector)=>el===document.querySelector(selector),modelInWorkspace),true);
   await page.getByTestId('workspace-new-tab').click();
   const field=page.getByRole('searchbox',{name:'筛选工作区入口'});
   await field.fill('大脑');
   await page.getByTestId('workspace-model-open').waitFor();
   const expected=await field.evaluate(el=>{
    const sample=document.createElement('span'); sample.style.cssText='background-color:var(--card);color:var(--fg)'; el.after(sample);
    const read=node=>{const s=getComputedStyle(node);return [s.backgroundColor,s.color];};
    const result=[read(el),read(sample),document.documentElement.dataset.mode];sample.remove(); return result;
   });
   assert.deepEqual(expected[0],expected[1],`${skin}/${mode} 入口输入沿用语义配色`);
   assert.equal(expected[2],mode);
   const workspace=page.getByTestId('right-workspace');
   colors.push(await workspace.evaluate(el=>getComputedStyle(el).backgroundColor));
   await page.setViewportSize({width:390,height:844});
   await wait(async()=> (await workspace.getAttribute('data-mode'))==='mobile');
   const box=await field.boundingBox(); assert.ok(box.x>=0 && box.x+box.width<=390,`${skin}/${mode} 筛选框不横溢`);
   await page.setViewportSize({width:1440,height:1000});
   await wait(async()=> (await workspace.getAttribute('data-mode'))==='docked');
   await page.getByTestId('workspace-close-tab').click();await panel.waitFor();
   if(mode==='light'){
    if(skin.startsWith('custom-'))await page.screenshot({path:join(out,'workspace-model-light-diy.png')});
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByTestId('settings-nav').locator('button[data-tab=appearance]').click();
   }
  }
 }
 assert.ok(new Set(colors).size>1,'workspace follows semantic theme colors');
 assert.equal(await stable.evaluate((el,selector)=>el===document.querySelector(selector),modelInWorkspace),true);await page.waitForTimeout(400);await page.screenshot({path:join(out,'workspace-model-dark.png')});
 await page.setViewportSize({width:390,height:844});await panel.waitFor();await wait(async()=> (await page.getByTestId('right-workspace').getAttribute('data-mode'))==='mobile');
 assert.ok((await page.getByTestId('right-workspace').boundingBox()).width<=390);
 await page.getByTestId('workspace-close-tab').focus();for(let i=0;i<35;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-testid=right-workspace]')),true,JSON.stringify(await page.evaluate(()=>({focus:document.activeElement?.outerHTML?.slice(0,300),modals:document.querySelectorAll('.pa-modal').length}))));}
 await page.getByTestId('right-workspace').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-testid=right-workspace]')),true);
 await page.mouse.move(385,840);await page.getByTestId('workspace-close-tab').focus();await page.waitForTimeout(100);
 assert.equal(await page.getByTestId('help-pop').count(),0,'moving pointer and focus dismisses old Help');
 await infoTab(page,'files');
 await detail.getByTestId('agent-workspace-details').locator('summary').click();
 const help=detail.getByTestId('agent-files').getByTestId('help').first();await help.focus();await page.getByTestId('help-pop').waitFor();await page.keyboard.press('Escape');
 assert.equal(await page.getByTestId('help-pop').count(),0,'Escape dismisses nested Help');assert.equal(await page.getByTestId('right-workspace').getAttribute('data-collapsed'),'0','nested Escape retains workspace');
 await infoTab(page,'models');
 await page.getByTestId('workspace-close-tab').focus();await page.waitForTimeout(400);await page.screenshot({path:join(out,'workspace-model-390.png')});
 await page.getByTestId('workspace-back-chat').click();await page.goto(`${base}/?agent=${b.id}`);await page.getByTestId('workspace-reopen').click();await page.getByTestId('workspace-model-open').waitFor();assert.equal(await panel.count(),0);
 assert.ok(patches.every(x=>x.url.endsWith('/'+a.id)),'all model writes remain bound to original object');assert.deepEqual(errors,[]);
 console.log('PASS model settings shared picker/immediate save/target ownership/view retention/themes/390; initial saved thinking='+saved.thinking);
} finally {await browser?.close();await server.stop();cleanupTempRun(run);}
