import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { makeManagedAgyPreload } from './fixtures/managed-agy-binary.mjs';
import { cleanupTempRun, makeTempRun, startTempServer } from './fixtures/temp-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const route = '/api/models/antigravity';
const opts = { skip: process.platform === 'win32' || !['arm64', 'x64'].includes(process.arch) };

async function until(read, ready) {
 for (let i = 0; i < 120; i++) {
  const state = await read();
  if (ready(state)) return state;
  await delay(50);
 }
 assert.fail('status did not settle');
}

test('managed login: busy reads are observational; success, failure and cancellation resume probes', opts, async () => {
 const port = await new Promise((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
   const { port } = s.address();
   s.close(error => error ? reject(error) : resolve(port));
  });
 });
 const run = makeTempRun('pia-agy-busy-');
 let server;
 try {
  const fixture = join(run.runDir, 'scenario'), started = join(run.runDir, 'started'), outcome = join(run.runDir, 'outcome');
  writeFileSync(fixture, 'text');
  const fake = makeManagedAgyPreload(root, join(run.runDir, 'managed-agy'), fixture);
  const path = p => JSON.stringify(pathToFileURL(join(root, 'packages/server/src/cli-agents', p)).href);
  appendFileSync(fake.preload, `
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {agyAccountGate} from ${path('agy-account-gate.ts')};
managedAuthRunner.login=async ({signal,dataDir})=>{
 if(agyAccountGate.start()!==null) throw Error('expected exclusive login lease');
 writeFileSync(${JSON.stringify(started)}, 'holding');
 while (!existsSync(${JSON.stringify(outcome)})) await delay(25, null, {signal});
 if(readFileSync(${JSON.stringify(outcome)},'utf8')==='failure')throw Error('synthetic login failed');
 const home=join(dataDir,'cli-agents','antigravity','home');
 mkdirSync(home,{recursive:true});
 writeFileSync(join(home,'fake-managed-login'),'fake');
};
`);
  server = startTempServer({ root, port, run, extra: { PIA_HOST: '127.0.0.1', NODE_OPTIONS: `--import tsx --import ${JSON.stringify(fake.preload)}` } });
  const request = (path = route, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(5000) });
  const json = async (path, method) => { const r = await request(path, method); assert.equal(r.status, 200, server.logs()); return r.json(); };
  const status = () => json(route);
  const post = action => json(`${route}/${action}`, 'POST');
  const probes = () => existsSync(fake.capture) ? readFileSync(fake.capture, 'utf8').trim().split('\n').length : 0;
  const models = async () => (await json('/api/models')).filter(m => m.provider === 'antigravity').map(m => m.id).sort();
  await until(async () => { try { return (await request()).ok; } catch { return false; } }, Boolean);
  assert.equal((await status()).installed, false);
  assert.equal((await post('install')).started, true);
  const installed = await until(status, s => !s.operation);
  assert.equal(installed.installed, true);
  assert.equal(installed.loggedIn, false);
  for (const how of ['success', 'failure', 'cancel']) {
   const original = await status();
   const beforeModels = await models();
   assert.equal((await post('login')).started, true);
   await until(() => existsSync(started), Boolean);
   const count = probes();
   for (let i = 0; i < 3; i++) {
    const busy = await status();
    assert.equal(busy.operation, 'login');
    assert.equal(busy.statusPending, true);
    assert.equal(busy.installed, true);
    assert.equal(busy.loggedIn, false);
    assert.equal(busy.registered, original.registered);
    if (original.loggedIn) assert.equal(busy.previousLoggedIn, true);
   }
   assert.deepEqual(await models(), beforeModels);
   assert.equal(probes(), count);
   assert.equal((await post('login')).started, false);
   if (how === 'cancel') assert.equal((await post('cancel')).ok, true);
   else writeFileSync(outcome, how);
   const done = await until(status, s => !s.operation);
   assert.equal(done.statusPending, undefined);
   assert.equal(done.loggedIn, true);
   assert.equal(done.registered, true);
   assert.ok(probes() > count, `${how}: detection resumed after release`);
   if (how === 'failure') assert.match(done.error, /synthetic login failed/);
   unlinkSync(started);
   if (existsSync(outcome)) unlinkSync(outcome);
  }
 } finally {
  if (server) await server.stop();
  cleanupTempRun(run);
 }
});
