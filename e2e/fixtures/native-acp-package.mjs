/** 本地 npm 假包：只在临时目录生成，不下载、不运行真实工具。 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export function makeNativeAcpPackage(dir, { name, bin, version = "1.0.0" }) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, type: "module", bin: { [bin]: "cli.mjs" } }));
	writeFileSync(join(dir, "cli.mjs"), `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const home = process.env.GEMINI_CLI_HOME || process.env.CODEBUDDY_CONFIG_DIR;
if (!home) throw new Error('fake ACP requires isolated home');
const marker = join(home, 'fake-login');
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
const reply = (id, result) => send({ id, result });
const fail = id => send({ id, error: { code: -32000, message: 'Authentication required' } });
const sid = 'ui-native';
const update = u => send({ method: 'session/update', params: { sessionId: sid, update: u } });
const say = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const configOptions = [{ id: 'model', name: '模型', category: 'model', currentValue: 'fake-model', options: [{ value: 'fake-model', name: '本地测试模型' }] }];
let pending;
let authTimer;
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
 const m = JSON.parse(line);
 switch (m.method) {
 case 'initialize': return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [{ id: process.env.GEMINI_CLI_HOME ? 'oauth-personal' : 'fake-login', name: '本地测试登录' }] });
 case 'authenticate':
  authTimer = setTimeout(() => { mkdirSync(home, { recursive: true }); writeFileSync(marker, 'test-only'); reply(m.id, {}); }, 1200);
  return;
 case 'session/new': case 'session/load': return existsSync(marker) ? reply(m.id, { sessionId: sid, configOptions }) : fail(m.id);
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
  if (allowed) writeFileSync(join(process.cwd(), 'test-note.txt'), '本地假 ACP 已获批准');
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
	const packages = {};
	for (const [id, name, bin] of [["gemini", "@google/gemini-cli", "gemini"], ["codebuddy", "@tencent-ai/codebuddy-code", "codebuddy"]]) {
		const source = makeNativeAcpPackage(join(dir, id), { name, bin });
		const nextSource = makeNativeAcpPackage(join(dir, `${id}-next`), { name, bin, version: "2.0.0" });
		packages[id] = { source, nextSource, packageName: name, bin, version: "1.0.0", integrity: `sha512-${createHash("sha512").update(`local-package:${id}`).digest("base64")}` };
	}
	const preload = join(dir, "install-preload.mjs");
	writeFileSync(preload, `
import { NativeInstaller } from ${JSON.stringify(pathToFileURL(join(root, "packages/server/src/cli-agents/native-install.ts")).href)};
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.env.PIA_MOCK !== '1' || !process.env.PIA_DATA_DIR?.startsWith(${JSON.stringify(dir.slice(0, dir.lastIndexOf("/")))})) throw new Error('local installer requires temporary Mock server');
delete process.env.PIA_GEMINI_COMMAND;
delete process.env.PIA_CODEBUDDY_COMMAND;
const packages = ${JSON.stringify(packages)};
const original = NativeInstaller.prototype.install;
NativeInstaller.prototype.checkUpdate = async function(id) {
 const pkg = packages[id];
 return { ...pkg, version: '2.0.0' };
};
NativeInstaller.prototype.install = function(id, release) {
 const pkg = packages[id];
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
