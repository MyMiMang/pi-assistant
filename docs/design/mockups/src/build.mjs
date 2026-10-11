import fs from 'node:fs';
import { markup, script } from './markup.mjs';
const base = fs.readFileSync(new URL('./base.css', import.meta.url), 'utf8');
const styles = { linear:'风格 A · Linear 极简', glass:'风格 B · 玻璃拟态', warm:'风格 C · 暖纸编辑', noir:'风格 D · 暗夜质感' };
for (const [k,label] of Object.entries(styles)) {
  const skin = fs.readFileSync(new URL(`./${k}.css`, import.meta.url), 'utf8');
  const def = k==='noir'?'dark':'light';
  const html = `<!doctype html><html lang="zh-CN" data-theme="${def}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Pi Assistant · ${label}</title><style>${base}\n${skin}</style></head><body>${markup(label)}<script>${script.replace("(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')", `'${def}'`)}</script></body></html>`;
  fs.mkdirSync(new URL(`../${k}/`, import.meta.url), { recursive:true });
  fs.writeFileSync(new URL(`../${k}/index.html`, import.meta.url), html);
}
console.log('built');
