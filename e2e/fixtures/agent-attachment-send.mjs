import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** One real upload at a time; hold the document request without altering the successful response. */
export async function checkAgentAttachmentSend(page, { base, agentId, image, sendText }) {
 const agent = `${base}/api/agents/${agentId}`;
 const input = page.locator('main [data-testid=attach-input]');
 const box = page.locator('main textarea:not(.pa-card textarea)');
 const send = page.locator('main button[aria-label="发送"]');
 const tray = page.locator('main [data-testid=attach-tray]');
 const progress = tray.getByTestId('attach-progress');
 const document = { name: 'upload-guard-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('附件回归：这是文档摘录。') };
 const picture = { name: 'icon-192.png', mimeType: 'image/png', buffer: readFileSync(image) };
 const text = '请看看这个附件';
 const receipt = page.locator('main').getByText(/看到 1 张图片，已看到文档文字/);
 const posts = [], deletes = [], completed = [];
 let mode = 'hold';
 let release;
 const held = new Promise(resolve => { release = resolve; });
 const observe = req => {
  if (req.url() === `${agent}/messages` && req.method() === 'POST') posts.push(req.postDataJSON());
  if (req.url().startsWith(`${agent}/upload/`) && req.method() === 'DELETE') deletes.push(req.url());
 };
 const upload = `${agent}/upload/**`;
 const intercept = async route => {
  const req = route.request();
  if (req.method() !== 'PUT') return route.continue();
  if (req.postDataBuffer()?.equals(document.buffer)) {
   if (mode === 'fail') return route.fulfill({ status: 500, json: { error: '测试上传失败' } });
   if (mode === 'hold') await held;
  }
  const response = await route.fetch();
  const { file } = await response.json();
  if (file) completed.push(file);
  await route.fulfill({ response });
 };
 const posted = () => page.waitForResponse(r => r.url() === `${agent}/messages` && r.request().method() === 'POST');
 page.on('request', observe);
 await page.route(upload, intercept);
 try {
  const count = await receipt.count();
  await input.setInputFiles([picture, document]);
  await tray.getByRole('progressbar', { name: `上传 ${document.name}` }).waitFor();
  await tray.getByRole('progressbar', { name: `上传 ${picture.name}` }).waitFor({ state: 'hidden' });
  assert.deepEqual(completed.map(f => f.name), [picture.name]);
  await box.fill(text);
  const disabled = await send.isDisabled();
  // HTMLElement.click respects native disabled, without Playwright waiting for it to become enabled.
  await send.evaluate(el => el.click());
 assert.equal(await box.inputValue(), text, '点击发送不应清空草稿');
 assert.equal(posts.length, 0);
  await box.press('Enter');
  assert.equal(await box.inputValue(), text, `上传中草稿被清空（按钮禁用=${disabled}）`);
  assert.equal(disabled, true, '上传中发送按钮必须禁用');
  assert.equal(await tray.getByTestId('attach-chip').count(), 2);
  assert.equal(await progress.count(), 1);
  assert.equal(posts.length, 0);
  assert.equal(deletes.length, 0);
  release();
  await progress.first().waitFor({ state: 'hidden' });
  assert.deepEqual(completed.map(f => f.name), [picture.name, document.name]);
  assert.equal(await send.isEnabled(), true);
  const response = posted();
  await send.click();
  assert.ok((await response).ok());
  await receipt.nth(count).waitFor({ timeout: 15_000 });
  assert.deepEqual(posts.map(p => p.attachments), [completed.map(f => f.fileId)]);
  assert.equal(deletes.length, 0);
  await page.locator("main img[alt='icon-192.png']").last().waitFor();

  mode = 'fail';
  await input.setInputFiles(document);
  await tray.locator('[data-testid=attach-chip][title*="测试上传失败"]').waitFor();
  await progress.first().waitFor({ state: 'hidden' });
  await tray.getByRole('button', { name: `移除 ${document.name}` }).click();
  const plain = '上传失败后发送纯文字';
  const plainResponse = posted();
  await sendText(plain);
  assert.ok((await plainResponse).ok());
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].attachments ?? [], []);

  // Hold the create response so the user can remove before completion; let upload.ts clean up its assigned id.
  let unhold;
  const pauseCreate = new Promise(resolve => { unhold = resolve; });
  const create = async route => { const res = await route.fetch(); await pauseCreate; await route.fulfill({ response: res }); };
  await page.route(`${agent}/upload`, create);
  try {
   await input.setInputFiles(document);
   await tray.getByRole('progressbar', { name: `上传 ${document.name}` }).waitFor();
   await box.fill('主动取消附件后仍可发送');
   assert.equal(await send.isDisabled(), true);
   const cancelled = page.waitForResponse(r => r.url().startsWith(`${agent}/upload/`) && r.request().method() === 'DELETE');
   await tray.getByRole('button', { name: `移除 ${document.name}` }).click();
   assert.equal(await send.isEnabled(), true);
   assert.equal(await box.inputValue(), '主动取消附件后仍可发送');
   assert.equal(posts.length, 2);
   unhold();
   assert.ok((await cancelled).ok());
   // Leave no draft from the guard assertions behind.
   await box.clear();
  } finally { unhold(); await page.unroute(`${agent}/upload`, create); }
 } finally {
  release();
  await page.unroute(upload, intercept);
  page.off('request', observe);
 }
}
