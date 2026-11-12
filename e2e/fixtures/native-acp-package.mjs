/** 本地 npm / binary 假包：只在临时目录生成，不下载、不运行真实工具。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export function makeNativeAcpPackage(dir, { name, bin, version = "1.0.0", expectedHome }) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, type: "module", bin: { [bin]: "cli.mjs" } }));
	writeFileSync(join(dir, "cli.mjs"), `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const home = process.env.GEMINI_CLI_HOME || process.env.CODEBUDDY_CONFIG_DIR || process.env.HOME;
if (!home || (${JSON.stringify(expectedHome ?? null)} && home !== ${JSON.stringify(expectedHome ?? null)})) throw new Error('fake ACP requires isolated home');
const marker = join(home, 'fake-login');
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
const reply = (id, result) => send({ id, result });
const fail = id => send({ id, error: { code: -32000, message: 'Authentication required' } });
const sid = 'ui-native';
let sessionCwd = process.cwd();
const update = u => send({ method: 'session/update', params: { sessionId: sid, update: u } });
const say = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const configOptions = [{ id: 'model', name: '模型', category: 'model', currentValue: 'fake-model', options: [{ value: 'fake-model', name: '本地测试模型' }] }];
let pending;
let authTimer;
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
 const m = JSON.parse(line);
 switch (m.method) {
 case 'initialize': return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: process.env.GEMINI_CLI_HOME ? 'oauth-personal' : 'fake-login', name: '本地测试登录', type: 'agent' }] });
 case 'authenticate':
  authTimer = setTimeout(() => { mkdirSync(home, { recursive: true }); writeFileSync(marker, 'test-only'); reply(m.id, {}); }, 1200);
  return;
 case 'session/new': case 'session/load': sessionCwd = m.params?.cwd || process.cwd(); return existsSync(marker) ? reply(m.id, { sessionId: sid, configOptions }) : fail(m.id);
 case 'session/set_config_option': return reply(m.id, { configOptions });
 case 'session/prompt':
  say('准备写入测试笔记。');
  update({ sessionUpdate: 'tool_call', toolCallId: 'write-note', title: '写入测试笔记', kind: 'edit', status: 'in_progress', rawInput: { path: 'test-note.txt' } });
  pending = m.id;
  return send({ id: 'permission', method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'write-note', title: '写入测试笔记', kind: 'edit', rawInput: { path: 'test-note.txt' } }, options: [{ optionId: 'once', kind: 'allow_once', name: '批准一次' }, { optionId: 'reject', kind: 'reject_once', name: '拒绝一次' }] } });
 case 'session/cancel': if (pending) { reply(pending, { stopReason: 'cancelled' }); pending = undefined; } return;
 }
 if (m.id === 'permission' && pending) {
  const allowed = m.result?.outcome?.optionId === 'once';
  if (allowed) writeFileSync(join(sessionCwd, 'test-note.txt'), '本地假 ACP 已获批准');
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'write-note', status: allowed ? 'completed' : 'failed', rawOutput: allowed ? '测试笔记已写入' : '未批准' });
  say(allowed ? '本地假 ACP 已获批准，测试笔记已写入。' : '操作未批准。');
  reply(pending, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 12 } }); pending = undefined;
 }
});
rl.on('close', () => { clearTimeout(authTimer); process.exit(0); });
` , { mode: 0o755 });
	return dir;
}

/** 仅临时测试进程 preload 注入安装器，生产服务没有任意安装源开关。 */
export function makeNativeInstallPreload(root, dir) {
	const dataDir = join(dirname(dir), "data");
	const packages = {};
	for (const [id, name, bin] of [["gemini", "@google/gemini-cli", "gemini"], ["codebuddy", "@tencent-ai/codebuddy-code", "codebuddy"]]) {
		const expectedHome = join(dataDir, "cli-agents", id, "home");
		const source = makeNativeAcpPackage(join(dir, id), { name, bin, expectedHome });
		const nextSource = makeNativeAcpPackage(join(dir, `${id}-next`), { name, bin, version: "2.0.0", expectedHome });
		packages[id] = { source, nextSource, packageName: name, bin, version: "1.0.0", integrity: `sha512-${createHash("sha512").update(`local-package:${id}`).digest("base64")}` };
	}
	// binary 复用同一个假 ACP。仅测试清单将 JS 入口声明为 Node 启动。
	const gooseSource = makeNativeAcpPackage(join(dir, "goose"), { name: "goose", bin: "goose", expectedHome: join(dataDir, "cli-agents", "goose", "home") });
	const archive = join(dir, "goose.tar.gz");
	writeFileSync(join(gooseSource, "goose"), readFileSync(join(gooseSource, "cli.mjs")));
	execFileSync("tar", ["czf", archive, "-C", gooseSource, "goose"]);
	const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
	const preload = join(dir, "install-preload.mjs");
	writeFileSync(preload, `
import { NativeInstaller } from ${JSON.stringify(pathToFileURL(join(root, "packages/server/src/cli-agents/native-install.ts")).href)};
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.PIA_MOCK !== '1' || process.env.PIA_DATA_DIR !== ${JSON.stringify(dataDir)}) throw new Error('local installer requires temporary Mock server');
for (const key of Object.keys(process.env)) if (/^PIA_.*_COMMAND$/.test(key)) delete process.env[key];
const packages = ${JSON.stringify(packages)};
const originalFetch = globalThis.fetch;
let gooseUrl;
globalThis.fetch = async (input, init) => {
 const address = String(input instanceof Request ? input.url : input);
 if (gooseUrl && address === gooseUrl) return new Response(readFileSync(${JSON.stringify(archive)}));
 if (new URL(address).hostname !== '127.0.0.1') throw new Error('unexpected external network: ' + address);
 return originalFetch(input, init);
};
const original = NativeInstaller.prototype.install;
NativeInstaller.prototype.checkUpdate = async function(id) {
 const pkg = packages[id];
 if (!pkg) throw new Error('unexpected update check');
 return { ...pkg, version: '2.0.0' };
};
NativeInstaller.prototype.install = function(id, release) {
 if (id === 'goose') {
  if (release) throw new Error('unexpected goose update');
  const known = this.options.releases[id];
  const asset = known?.assets?.[process.platform + '-' + process.arch];
  if (!asset || known.source !== 'binary') throw new Error('goose fixture requires supported binary release');
  gooseUrl = asset.url;
  const selected = { ...known, executable: 'node', integrity: ${JSON.stringify(sha256)}, assets: { ...known.assets, [process.platform + '-' + process.arch]: { ...asset, archive: 'tar.gz', entry: 'goose', executable: 'node', args: [], sha256: ${JSON.stringify(sha256)} } } };
  this.options.releases[id] = selected;
  this.run = async () => { throw new Error('binary fixture must not run npm'); };
  return original.call(this, id, selected);
 }
 const pkg = packages[id];
 if (!pkg) throw new Error('unexpected install');
 this.options.releases[id] = pkg;
 const selected = release ?? pkg;
 this.run = async request => {
  if (request.args[0] === 'view') return JSON.stringify({ name: pkg.packageName, version: pkg.version, dist: { integrity: pkg.integrity } });
  if (request.args[0] === 'pack') { writeFileSync(join(request.cwd, 'local.tgz'), 'local-package:' + id); return JSON.stringify([{ filename: 'local.tgz' }]); }
  if (request.args[0] !== 'install') throw new Error('unexpected local npm command');
  const target = join(request.cwd, 'node_modules', pkg.packageName);
  mkdirSync(target, { recursive: true }); cpSync(selected.version === '2.0.0' ? pkg.nextSource : pkg.source, target, { recursive: true }); return '';
 };
 return original.call(this, id, selected);
};
`);
	return preload;
}
