/** 三家受管CLI安装测试：本地假包与官方登录命令形状，不联网。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export function makeManagedInstallPreload(root, dir, id) {
 mkdirSync(dir, { recursive: true });
 const specs = { "claude-code": ["@anthropic-ai/claude-code", "claude", "CLAUDE"], codex: ["@openai/codex", "codex", "CODEX"], opencode: ["opencode-ai", "opencode", "OPENCODE"] };
 const [name, bin, key] = specs[id];
 const fake = join(root, "packages/server/test/fixtures", id === "claude-code" ? "fake-claude.mjs" : id === "codex" ? "fake-codex.mjs" : "fake-opencode.mjs");
 const source = join(dir, "package"); mkdirSync(source);
 writeFileSync(join(source, "package.json"), JSON.stringify({ name, version: "1.0.0", bin: { [bin]: "entry.cjs" } }));
 writeFileSync(join(source, "entry.cjs"), `const {existsSync,mkdirSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const {spawn}=require('node:child_process');
const args=process.argv.slice(2);
const home=process.env.CLAUDE_CONFIG_DIR||process.env.CODEX_HOME||process.env.HOME;
const marker=join(home,'fake-managed-login');
if(args.join(' ')==='auth login'||args.join(' ')==='login'){
 setTimeout(()=>{mkdirSync(home,{recursive:true});writeFileSync(marker,'test');if(${JSON.stringify(id)}==='opencode'){const p=join(process.env.XDG_DATA_HOME,'opencode');mkdirSync(p,{recursive:true});writeFileSync(join(p,'auth.json'),'{}');}process.exit(0);},1200);
}else{
 const env={...process.env,FAKE_CLAUDE_LOGGED_IN:existsSync(marker)?'1':'0',FAKE_CODEX_LOGGED_IN:existsSync(marker)?'1':'0',FAKE_CLAUDE_MODELS:'dup',FAKE_CLAUDE_SCENARIO:require('node:fs').readFileSync(${JSON.stringify(join(dir, "..", "scenario"))},'utf8'),FAKE_CODEX_SCENARIO_FILE:${JSON.stringify(join(dir, "..", "scenario"))},FAKE_OPENCODE_SCENARIO_FILE:${JSON.stringify(join(dir, "..", "scenario"))}};
 const child=spawn(process.execPath,[${JSON.stringify(fake)},...args],{env,stdio:'inherit'});
 child.on('close',code=>process.exit(code??1));
}
`);
 const bytes = `managed:${id}`;
 const release = { packageName: name, version: "1.0.0", bin, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
 const preload = join(dir, "preload.mjs");
 const url = p => JSON.stringify(pathToFileURL(join(root, p)).href);
 writeFileSync(preload, `
import {NativeInstaller} from ${url("packages/server/src/cli-agents/native-install.ts")};
import {managedAuthRunner} from ${url("packages/server/src/cli-agents/managed-actions.ts")};
import {runManagedLogin} from ${url("packages/server/src/cli-agents/managed-auth.ts")};
import {cpSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.PIA_MOCK!=='1'||!process.env.PIA_DATA_DIR?.startsWith(${JSON.stringify(dir.slice(0,dir.lastIndexOf('/')))}))throw new Error('requires temporary Mock server');
delete process.env.PIA_${key}_COMMAND;
managedAuthRunner.login=i=>runManagedLogin({...i,terminalLaunch:script=>({command:'/bin/sh',args:[script]})});
const original=NativeInstaller.prototype.install;
NativeInstaller.prototype.install=function(id,selected){
 if(id!==${JSON.stringify(id)})throw new Error('unexpected tool');
 const release=${JSON.stringify(release)};
 this.options.releases[id]=release;
 this.run=async r=>{
  if(r.args[0]==='pack'){writeFileSync(join(r.cwd,'fake.tgz'),${JSON.stringify(bytes)});return JSON.stringify([{filename:'fake.tgz'}]);}
  if(r.args[0]!=='install')throw new Error('unexpected network request');
  const dest=join(r.cwd,'node_modules',release.packageName);mkdirSync(dest,{recursive:true});cpSync(${JSON.stringify(source)},dest,{recursive:true});return '';
 };
 return original.call(this,id,selected??release);
};
`);
 return preload;
}
