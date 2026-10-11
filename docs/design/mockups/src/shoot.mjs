import { chromium } from '/workspace/pi-assistant/node_modules/playwright-core/index.mjs';
const b = await chromium.launch({ executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] });
const only = process.argv[2];
for (const s of (only?[only]:['linear','glass','warm','noir'])) {
  for (const [name,vp,theme,mob] of [['desktop-light',{width:1440,height:900},'light'],['desktop-dark',{width:1440,height:900},'dark'],['mobile',{width:390,height:844},'light',true]]) {
    const ctx = await b.newContext({ viewport:vp, deviceScaleFactor: mob?3:2, isMobile:!!mob, hasTouch:!!mob });
    const p = await ctx.newPage();
    await p.goto(`file:///workspace/ui-mockups/${s}/index.html?theme=${theme}&static=1`);
    await p.waitForTimeout(1300); if(!mob) await p.evaluate(()=>{const e=document.querySelector('.scroll');e.scrollTop=e.scrollHeight}); await p.waitForTimeout(150);
    await p.screenshot({ path:`/workspace/ui-mockups/shots/${s}-${name}.png` });
    await ctx.close();
  }
}
await b.close(); console.log('shot');
