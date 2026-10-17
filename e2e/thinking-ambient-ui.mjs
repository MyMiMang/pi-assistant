// 构建后的真实CSS动画检查：时间采样，非仅查询keyframes字符串。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeTempRun,startTempServer,browserEnv,cleanupTempRun } from './fixtures/temp-server.mjs';
import { stableShot } from './fixtures/stable-shot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),run=makeTempRun('pia-think-ambient-');
const port=await new Promise(r=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const base=`http://127.0.0.1:${port}`,srv=startTempServer({root,port,run});
const out=process.env.SHOT_DIR??join(run.runDir,'shots');mkdirSync(out,{recursive:true});let browser;
const api=async(p,method='GET',body)=>{const r=await fetch(base+p,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${p}: ${r.status}`);return r.json();};
try{
 const until=Date.now()+20000;while(true){try{if((await fetch(base+'/api/system')).ok)break;}catch{}if(Date.now()>until)throw Error('startup timeout');await new Promise(r=>setTimeout(r,100));}
 await api('/api/settings','PUT',{onboarded:true});const a=await api('/api/agents','POST',{name:'动效检查'});
 const p=await api('/api/models/custom','POST',{name:'假模型',api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',noKey:true,models:[{id:'anthropic.claude-sonnet-5',reasoning:true}]});
 await api(`/api/agents/${a.id}`,'PATCH',{model:{provider:p.id,id:'anthropic.claude-sonnet-5'},thinking:'off'});
 browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:browserEnv(run)});
 const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(base+`/?agent=${a.id}`);await page.getByTestId('model-picker').click();
 const slider=page.getByRole('slider');await slider.waitFor();await slider.focus();
 const sample=()=>page.evaluate(()=>{
  const root=document.querySelector('.pa-think');const star=root.querySelector('.pa-think-star');const fill=getComputedStyle(root.querySelector('.pa-think-fill'),'::after');const glow=getComputedStyle(root.querySelector('.pa-think-energy'),'::before');
  return {level:root.dataset.paThinkLevel,star:star?{name:getComputedStyle(star).animationName,transform:getComputedStyle(star).transform,opacity:getComputedStyle(star).opacity,duration:getComputedStyle(star).animationDuration}:null,count:root.querySelectorAll('.pa-think-star').length,flow:{name:fill.animationName,transform:fill.transform,duration:fill.animationDuration},glow:{name:glow.animationName,transform:glow.transform,duration:glow.animationDuration}};
 });
 const levels=['off','minimal','low','medium','high','xhigh','max'];const counts=[];
 for(const level of levels){
  if(level!=='off'){
   await slider.focus();await slider.press('ArrowRight');
   await page.getByTestId('model-picker-compact').waitFor({state:'detached'});
   await page.getByTestId('model-picker').click();await slider.waitFor();
  }
  await page.waitForTimeout(900);
  const x=await sample();await page.waitForTimeout(500);const y=await sample();assert.equal(y.level,level);counts.push(y.count);
  if(level==='off'){assert.equal(y.flow.name,'none');assert.equal(y.glow.name,'none');}
  else{assert.notEqual(x.flow.transform,y.flow.transform,`${level}: flow frozen`);assert.notEqual(x.glow.transform,y.glow.transform,`${level}: glow frozen`);assert.ok(x.star.transform!==y.star.transform||x.star.opacity!==y.star.opacity,`${level}: particle frozen`);}
  console.log('PASS ambient',level,'particles',y.count,'duration',y.star?.duration);
 }
 assert.ok(counts.at(-1)>counts[1]);
 const original=await sample();await page.locator('.pa-think').evaluate(el=>el.style.setProperty('--mo-scale','1.2'));const scaled=await sample();
 for(const key of ['flow','glow','star'])assert.ok(Math.abs(parseFloat(scaled[key].duration)/parseFloat(original[key].duration)-1.2)<.03,`${key}: DIY scale`);
 await stableShot(page,page.getByTestId('model-picker-compact'),join(out,'ambient-max.png'));
 await page.evaluate(()=>document.querySelector('.pa-think').setAttribute('data-pa-mo-style','steps'));
 assert.match(await page.locator('.pa-think-star').first().evaluate(el=>getComputedStyle(el).animationTimingFunction),/steps/);
 await page.emulateMedia({reducedMotion:'reduce'});const reduced=await sample();assert.equal(reduced.flow.name,'none');assert.equal(reduced.glow.name,'none');assert.equal(reduced.star.name,'none');
 console.log('PASS all ambient layers honor DIY scale, steps and reduced motion');
}finally{await browser?.close();await srv.stop();cleanupTempRun(run);}
