// 真DOM主题卡片回归：不裁掉说明，检查每张卡内文字与换行后的高度，而不只检查页面总宽。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from './fixtures/temp-server.mjs';
import { stableShot } from './fixtures/stable-shot.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const run=makeTempRun('pia-theme-layout-');
const port=await new Promise(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`;
const srv=startTempServer({root,port,run});
const out=process.env.SHOT_DIR??join(run.runDir,'shots');mkdirSync(out,{recursive:true});
let browser;
try {
 const until=Date.now()+20000;
 while(true){try{if((await fetch(base+'/api/system')).ok)break;}catch{}if(Date.now()>until)throw Error('startup timeout');await new Promise(r=>setTimeout(r,100));}
 await fetch(base+'/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({onboarded:true})});
 browser=await chromium.launch({executablePath:process.env.CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,env:browserEnv(run)});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?settings=appearance');
 await page.locator('[data-theme-id="pixel"]').waitFor();
 assert.equal(await page.locator('button[data-theme-id]').first().getAttribute('data-theme-id'),'noir');
 assert.equal(await page.locator('button[data-theme-id="noir"]').getAttribute('aria-checked'),'true','fresh storage defaults to noir');
 // 用正式“另存”流程生成合法DIY主题，再把名字设成合法最大长度内无空格字符串。
 await page.getByTestId('copy-pixel').click();
 await page.getByTestId('theme-designer').waitFor();
 const name='LongDIYThemeNameNoSpaces';
 await page.evaluate(name=>{const k='pia.customThemes';const themes=JSON.parse(localStorage.getItem(k));themes[0].name=name;localStorage.setItem(k,JSON.stringify(themes));},name);
 let checks=0;
 for(const width of [1280,760,390])for(const mode of ['light','dark'])for(const skin of ['glass','warm','pixel','noir']){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(({skin,mode})=>{localStorage.setItem('pia.skin',skin);localStorage.setItem('pia.theme',mode);},{skin,mode});
  await page.reload();await page.locator('[data-theme-id="pixel"]').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-theme-id]')].some(x=>x.getAttribute('data-theme-id').startsWith('custom-')));
  await page.evaluate(()=>document.fonts.ready);
  const failures=await page.locator('[role="radiogroup"][aria-label="主题"]').evaluate(group=>{
   const failures=[];
   for(const card of group.querySelectorAll('button[data-theme-id]')){
    const b=card.getBoundingClientRect();
    for(const child of [...card.children].filter(x=>!x.classList.contains('pa-preview'))){
     const box=child.getBoundingClientRect();
     if(child.scrollWidth>child.clientWidth+1||box.right>b.right+1||box.bottom>b.bottom+1)failures.push(`${card.dataset.themeId}: text box overflow`);
     const walker=document.createTreeWalker(child,NodeFilter.SHOW_TEXT);
     while(walker.nextNode()){
      const range=document.createRange();range.selectNodeContents(walker.currentNode);
      for(const rect of range.getClientRects())if(rect.left<b.left-1||rect.right>b.right+1||rect.bottom>b.bottom+1)failures.push(`${card.dataset.themeId}: painted text outside card`);
     }
    }
   }
   return failures;
  });
  assert.deepEqual(failures,[],`${width}/${mode}/${skin}`);checks++;
  if(mode==='dark'&&skin==='noir'&&width!==760)await stableShot(page,page.getByTestId('settings-dialog'),join(out,`theme-cards-${width}.png`));
 }
 assert.deepEqual(errors,[]);console.log(`PASS ${checks} theme/viewport/mode combinations; long DIY name and all taglines stay inside each card`);
}finally{await browser?.close();await srv.stop();cleanupTempRun(run);}
