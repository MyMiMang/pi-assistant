/** 真实模型设置复用/作用域与主题切换：仅临时Mock数据。 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from './fixtures/temp-server.mjs';
import { infoTab } from './fixtures/info-pane.mjs';
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
 await page.getByRole('button',{name:'信息面板',exact:true}).click();await infoTab(page,'models');
 await page.getByTestId('model-settings-workspace-open').click();
 const panel=page.getByTestId('workspace-model-settings');await panel.waitFor();
 assert.equal(await panel.locator('[data-model-agent]').getAttribute('data-model-agent'),a.id);
 const content=panel.getByTestId('agent-models-tab');await content.getByTestId('agent-context').waitFor();
 const node=await panel.elementHandle();
 const modelPop=async()=>{const inline=content.getByTestId('model-picker-inline');if(await inline.count())return inline;await content.getByTestId('model-picker').click();return page.getByTestId('model-picker-compact');};
 let pop=await modelPop();await pop.getByRole('slider').waitFor();await pop.getByRole('slider').press('End');
 await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).thinking!=='low');
 pop=await modelPop();await pop.getByTestId('thinking-fast').click();await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).fast===true);
 const saved=(await j('/api/agents')).find(x=>x.id===a.id);assert.equal((await j('/api/agents')).find(x=>x.id===b.id).model.id,'echo');
 // Model control remains the existing picker; select a different real Mock catalog entry.
 if(await pop.getByTestId('thinking-model-name').count())await pop.getByTestId('thinking-model-name').click();
 else if(await pop.getByTestId('thinking-model').count())await pop.getByTestId('thinking-model').click();
 const search=page.getByTestId('model-search').last();await search.waitFor();await search.fill('echo');const option=page.locator('[data-testid=model-option][data-model="mock/echo"]').last();await option.click();await wait(async()=> (await j('/api/agents')).find(x=>x.id===a.id).model.id==='echo');
 await page.keyboard.press('Escape');
 await page.getByTestId('workspace-reopen').click();
 const n=patches.length;await page.getByTestId('workspace-expand').click();await page.getByTestId('workspace-restore').click();await page.getByTestId('workspace-collapse').click();await page.getByTestId('workspace-reopen').click();
 assert.equal(await node.evaluate(el=>el===document.querySelector('[data-testid=workspace-model-settings]')),true);assert.equal(patches.length,n,'view lifecycle never saves');
 // Switch appearance through real settings controls without page reload; retained content stays mounted.
 await page.goto(`${base}/?settings=appearance&agent=${a.id}`);await page.locator('[data-theme-id="pixel"]').waitFor();
 await page.getByTestId('copy-pixel').click();await page.getByTestId('theme-designer').waitFor();
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 const custom=await page.evaluate(()=>JSON.parse(localStorage.getItem('pia.customThemes')||'[]')[0]?.id);assert.ok(custom,'formal copy creates valid DIY manifest');
 // Reveal the existing detail pane after the retained workspace yields its space.
 if(await page.getByTestId('right-workspace').isVisible())await page.getByTestId('workspace-collapse').click();
 if(!(await page.getByTestId('info-tabs').isVisible()))await page.getByRole('button',{name:'信息面板',exact:true}).click();
 await page.getByTestId('info-tabs').waitFor();await infoTab(page,'models');
 await page.getByTestId('model-settings-workspace-open').click();await panel.waitFor();const stable=await panel.elementHandle();
 const colors=[];
 for(const skin of ['noir','glass','warm','pixel',`custom-${custom}`]){
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByTestId('settings-nav').locator('button[data-tab=appearance]').click();
  await page.locator(`button[data-theme-id="${skin}"]`).click();await page.getByRole('button',{name:'浅色',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal(await stable.evaluate(el=>el===document.querySelector('[data-testid=workspace-model-settings]')),true);
  colors.push(await page.getByTestId('right-workspace').evaluate(el=>getComputedStyle(el).backgroundColor));
 }
 assert.ok(new Set(colors).size>1,'workspace follows semantic theme colors');
 await page.screenshot({path:join(out,'workspace-model-light-diy.png')});
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByTestId('settings-nav').locator('button[data-tab=appearance]').click();await page.getByRole('button',{name:'深色',exact:true}).click();await page.keyboard.press('Escape');
 assert.equal(await stable.evaluate(el=>el===document.querySelector('[data-testid=workspace-model-settings]')),true);await page.waitForTimeout(400);await page.screenshot({path:join(out,'workspace-model-dark.png')});
 await page.setViewportSize({width:390,height:844});await panel.waitFor();await wait(async()=> (await page.getByTestId('right-workspace').getAttribute('data-mode'))==='mobile');
 assert.ok((await page.getByTestId('right-workspace').boundingBox()).width<=390);
 await page.getByTestId('workspace-close-tab').focus();for(let i=0;i<35;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-testid=right-workspace]')),true,JSON.stringify(await page.evaluate(()=>({focus:document.activeElement?.outerHTML?.slice(0,300),modals:document.querySelectorAll('.pa-modal').length}))));}
 await page.getByTestId('right-workspace').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-testid=right-workspace]')),true);
 await page.mouse.move(385,840);await page.getByTestId('workspace-close-tab').focus();await page.waitForTimeout(100);
 assert.equal(await page.getByTestId('help-pop').count(),0,'moving pointer and focus dismisses old Help');
 const help=panel.getByTestId('help').first();await help.focus();await page.getByTestId('help-pop').waitFor();await page.keyboard.press('Escape');
 assert.equal(await page.getByTestId('help-pop').count(),0,'Escape dismisses nested Help');assert.equal(await page.getByTestId('right-workspace').getAttribute('data-collapsed'),'0','nested Escape retains workspace');
 await page.getByTestId('workspace-close-tab').focus();await page.waitForTimeout(400);await page.screenshot({path:join(out,'workspace-model-390.png')});
 await page.getByTestId('workspace-back-chat').click();await page.goto(`${base}/?agent=${b.id}`);await page.getByTestId('workspace-reopen').waitFor();assert.equal(await page.getByTestId('workspace-reopen').isDisabled(),true);
 assert.ok(patches.every(x=>x.url.endsWith('/'+a.id)),'all model writes remain bound to original object');assert.deepEqual(errors,[]);
 console.log('PASS model settings shared picker/immediate save/target ownership/view retention/themes/390; initial saved thinking='+saved.thinking);
} finally {await browser?.close();await server.stop();cleanupTempRun(run);}
