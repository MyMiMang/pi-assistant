import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
const root = new URL('..', import.meta.url).pathname;
const data = mkdtempSync(`${tmpdir()}/pia-delete-`);
const port = await new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const p=s.address().port; s.close(()=>resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import','tsx','packages/server/test/launch-memory.ts'], { cwd: decodeURIComponent(root), env:{...process.env,PIA_DATA_DIR:data,PIA_MOCK:'1',PIA_OFFLINE:'1',PIA_PORT:String(port)},stdio:['ignore','pipe','pipe'] });
let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json()};
let browser;
try {
  const end=Date.now()+30000; while(Date.now()<end){try{if((await fetch(base+'/api/system')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  await api('/api/settings','PUT',{onboarded:true});
  const provider=await api('/api/models/custom','POST',{name:'删除验证服务',api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',noKey:true,models:[{id:'delete-test'}]});
  const agent=await api('/api/agents','POST',{name:'删除验证助理'});
  await api(`/api/agents/${agent.id}`,'PATCH',{model:{provider:provider.id,id:'delete-test'}});
  browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  let nativeDialogs=0;page.on('dialog',d=>{nativeDialogs++;void d.dismiss()});
  await page.goto(base+'/?settings=models');
  await page.getByTestId(`service-toggle-${provider.id}`).click();
  const form=page.getByTestId(`relay-detail-${provider.id}`);
  const del=()=>page.getByTestId(`service-delete-${provider.id}`).click();
  await del();
  await page.getByTestId('confirm-dialog').waitFor();
  assert.match(await page.getByTestId('confirm-dialog').textContent(),/删除验证助理/);
  await page.getByTestId('confirm-cancel').click();
  assert.ok((await api('/api/models/custom')).providers.some(p=>p.id===provider.id));
  // 返回服务端失败时展示具体错误，服务仍在，用户可重试。
  await page.route(`**/api/models/custom/${provider.id}`,route=>route.request().method()==='DELETE'?route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'模拟删除失败'})}):route.continue());
  await del();await page.getByTestId('confirm-ok').click();
  await form.getByText(/删除失败.*模拟删除失败/).waitFor();
  assert.ok((await api('/api/models/custom')).providers.some(p=>p.id===provider.id));
  await page.unroute(`**/api/models/custom/${provider.id}`);
  await del();await page.getByTestId('confirm-ok').click();
  await form.waitFor({state:'detached'});
  assert.ok(!(await api('/api/models/custom')).providers.some(p=>p.id===provider.id));
  assert.equal((await api('/api/agents')).find(a=>a.id===agent.id).model.provider,'mock');
  assert.equal(nativeDialogs,0,'不得调用原生 confirm');
  console.log('通过：自定义服务添加、引用影响、取消、删除失败保留并显示原因、重试删除、清理模型引用；无原生 confirm。');
} catch(e){console.error(logs.slice(-4000));throw e;} finally {await browser?.close();server.kill('SIGTERM');}
