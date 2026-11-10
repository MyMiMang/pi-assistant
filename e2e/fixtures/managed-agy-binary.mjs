/** Antigravity 离线假 binary：仍走统一下载、SHA、解压、current 和官方登录入口。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function makeManagedAgyPreload(root, dir, scenario) {
 mkdirSync(dir, { recursive: true });
 const entry = join(dir, "entry.cjs"), binary = join(dir, "antigravity"), archive = join(dir, "fake.tar.gz");
 const capture = join(dir, "env.jsonl"), update = join(dir, "update");
 writeFileSync(entry, `const {existsSync,mkdirSync,writeFileSync,appendFileSync}=require('node:fs');
const {join}=require('node:path');const {spawn}=require('node:child_process');
const args=process.argv.slice(2),home=process.env.HOME,marker=join(home,'fake-managed-login');
if(home!==${JSON.stringify(join(dir, "..", "data", "cli-agents", "antigravity", "home"))}||process.env.AGY_CLI_DISABLE_AUTO_UPDATE!=='true')throw new Error('environment escaped');
appendFileSync(${JSON.stringify(capture)},JSON.stringify({args,home,autoUpdate:process.env.AGY_CLI_DISABLE_AUTO_UPDATE})+'\\n');
if(args.join(' ')==='acp --login'){setTimeout(()=>{mkdirSync(home,{recursive:true});writeFileSync(marker,'fake');process.exit(0);},1600);}
else {const child=spawn(process.execPath,[${JSON.stringify(join(root,"packages/server/test/fixtures/fake-agy.mjs"))},...args],{stdio:'inherit',env:{...process.env,FAKE_AGY_LOGGED_IN:existsSync(marker)?'1':'0',FAKE_AGY_SCENARIO_FILE:${JSON.stringify(scenario)}}});child.on('close',code=>process.exit(code??1));}
`);
 writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${entry.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
 execFileSync("tar", ["czf", archive, "-C", dir, "antigravity"]);
 const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
 const release = version => ({ packageName: "antigravity-cli", version, integrity: sha, bin: "antigravity", executable: "binary", source: "binary", updateManifest: "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{platform}_{arch}.json", assets: { [`${process.platform}-${process.arch}`]: { url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}/${process.platform}-${process.arch === "arm64" ? "arm" : "x64"}/cli_fake.tar.gz`, sha256: sha, archive: "tar.gz", entry: "antigravity" } } });
 const url = p => JSON.stringify(pathToFileURL(join(root, p)).href);
 const preload = join(dir, "preload.mjs");
 writeFileSync(preload, `
import {NativeInstaller} from ${url("packages/server/src/cli-agents/native-install.ts")};
import {managedAuthRunner} from ${url("packages/server/src/cli-agents/managed-actions.ts")};
import {runManagedLogin} from ${url("packages/server/src/cli-agents/managed-auth.ts")};
import {readFileSync,existsSync} from 'node:fs';
if(process.env.PIA_MOCK!=='1'||!process.env.PIA_DATA_DIR?.startsWith(${JSON.stringify(join(dir,".."))}))throw new Error('requires temporary Mock');
delete process.env.PIA_AGY_COMMAND;
managedAuthRunner.login=i=>runManagedLogin({...i,terminalLaunch:script=>({command:'/bin/sh',args:[script]})});
const original=NativeInstaller.prototype.install;
NativeInstaller.prototype.install=function(id,selected){if(id!=='antigravity')throw new Error('unexpected install');this.options.releases[id]=${JSON.stringify(release("1.0.0"))};return original.call(this,id,selected??this.options.releases[id]);};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const address=String(input);
 if(address.startsWith('https://storage.googleapis.com/antigravity-public/antigravity-cli/'))return new Response(readFileSync(${JSON.stringify(archive)}));
 if(address.startsWith('https://antigravity-cli-auto-updater-'))return Response.json({version:'1.0.1',url:${JSON.stringify(release("1.0.1").assets[`${process.platform}-${process.arch}`].url)},...(existsSync(${JSON.stringify(update)})?{sha256:${JSON.stringify(sha)}}:{})});
 if(!address.startsWith('http://127.0.0.1:'))throw new Error('unexpected external network');
 return originalFetch(input,init);
};
`);
 return { preload, capture, update };
}
