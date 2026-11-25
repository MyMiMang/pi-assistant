import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { agyAccountGate } from "../src/cli-agents/agy-account-gate.ts";
import { mountAgyRtImport } from "../src/routes/agy-rt-import.ts";
import type { Env } from "../src/routes/common.ts";
import { createAgyRtImport, type AgyAccount, type AgyAccountRow } from "../src/cli-agents/agy-rt-import.ts";

const a = { subject: "A", email: "a@fixture.test" }, b = { subject: "B", email: "b@fixture.test" };
const ma = "mock-material-aaaaa", mb = "mock-material-bbbbb";

test("账号添加与启用分开；受管状态可重开、失效不切换、移除仅作用于本地", async () => {
 const dir = await mkdtemp(join(tmpdir(), "agy-mock-"));
 const live = join(dir, "active"), staged = join(dir,"staged");
 const records = new Map<string,{row:AgyAccountRow; material:string}>();
 const read = async (p:string) => JSON.parse(await readFile(p,"utf8")) as AgyAccount;
 const signal = new AbortController().signal;
 let validB = true, incorrect = false, cancelled = false, failCommit = false;
 const abort = new AbortController();
 const backend: Parameters<typeof createAgyRtImport>[0] = {
  current: () => read(live), list: async () => [...records.values()].map(x=>x.row),
  verify: async m => m === ma ? a : m === mb && validB ? b : null,
  remember: async (account, material) => { records.set(account.subject,{row:{...account,state:"ready"},material}); },
  stored: async subject => records.get(subject)?.material ?? null,
  markInvalid: async s => { const r=records.get(s); if(r) r.row.state="invalid"; },
  stage: async (_, account) => {
   await writeFile(staged,JSON.stringify(incorrect ? a : account),{mode:0o600});
   return {readAccount: async () => { if(cancelled) abort.abort(); return read(staged); }, discard: async () => rm(staged,{force:true})};
  },
  activate: async (_, expected, s) => {
   s.throwIfAborted();
   if ((await read(live)).subject !== expected?.subject) return false;
   assert.equal(agyAccountGate.start(), null);
   s.throwIfAborted(); await rename(staged,live);
   if (failCommit) throw Error("synthetic partial commit");
   return true;
  },
  rollback: async (_, previous) => { assert.equal(agyAccountGate.start(),null); await writeFile(live,JSON.stringify(previous)); },
  removeInactive: async subject => (await read(live)).subject !== subject && records.delete(subject),
 };
 const app = new Hono<Env>();
 app.use("*", (c,next) => { c.set("caller", {local: true, deviceId: null, ip: "127.0.0.1"}); return next(); });
 mountAgyRtImport(app, backend);
 const server = serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});
 await once(server,"listening");
 const address = server.address(); assert.ok(address && typeof address !== "string");
 const base = `http://127.0.0.1:${address.port}`;
 const path = "/api/agy-rt-import";
 const post = (suffix:string, body:object, origin=base) => fetch(base+path+suffix,{method:"POST", headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)});
 try {
  await writeFile(live,JSON.stringify(a));
  const service = createAgyRtImport(backend), {mutate} = service;
  await assert.rejects(mutate("add",{refreshToken:"invalid-fixture-material"},signal), /invalid_account/);
  await mutate("add",{refreshToken:ma},signal);
  assert.equal((await post("",{refreshToken:mb},"https://wrong.test")).status,403);
  assert.equal((await post("",{refreshToken:"invalid-material-000"})).status,400);
  const added = await post("",{refreshToken:mb});
  assert.equal(added.status,200); assert.equal(added.headers.get("cache-control"),"no-store");
  assert.deepEqual(await added.json(),{email:b.email});
  await mutate("add",{refreshToken:mb},signal);
  assert.equal((await service.status(signal)).accounts.length,2);
  assert.deepEqual(await read(live),a);
  const running = agyAccountGate.start(); assert.ok(running);
  try { await assert.rejects(mutate("switch",{subject:"B"},signal),/occupied/); }
  finally { running(); }
  failCommit = true; assert.equal((await post("/switch",{subject:"B"})).status,502); failCommit = false;
  assert.deepEqual(await read(live),a);
  incorrect=true; await assert.rejects(mutate("switch",{subject:"B"},signal),/cli_unverified/); incorrect=false;
  cancelled=true; await assert.rejects(mutate("switch",{subject:"B"},abort.signal),/cancelled/); cancelled=false;
  await assert.rejects(readFile(staged),{code:"ENOENT"});
  assert.deepEqual(await read(live),a);
  assert.equal((await post("/switch",{subject:"B"})).status,200);
  const status = await fetch(base+path);
  assert.deepEqual((await status.json()).current,b);
  assert.deepEqual((await createAgyRtImport(backend).status(signal)).current,b);
  validB=false; await assert.rejects(mutate("switch",{subject:"B"},signal),/invalid_account/);
  assert.equal((await service.status(signal)).accounts.find(r=>r.subject==="B")?.state,"invalid");
  assert.deepEqual(await read(live),b);
  await assert.rejects(mutate("remove",{subject:"B"},signal),/occupied/);
  await mutate("switch",{subject:"A"},signal);
  await mutate("remove",{subject:"B"},signal);
  assert.deepEqual((await service.status(signal)).accounts.map(x=>x.subject),["A"]);
  assert.deepEqual(await read(live),a);
 } finally {
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(dir,{recursive:true,force:true});
 }
});
