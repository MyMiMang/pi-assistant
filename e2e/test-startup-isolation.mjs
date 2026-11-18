import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRun, startTempServer, cleanupTempRun } from './fixtures/temp-server.mjs';

// POSIX fixture: never launch if we cannot put executable, counting stubs first in PATH.
assert.ok(['darwin', 'linux'].includes(process.platform), '系统后端替身只支持 POSIX 测试环境');
const root = fileURLToPath(new URL('..', import.meta.url));
const listen = (s) => new Promise((resolve, reject) => {
	s.once('error', reject).listen(0, '127.0.0.1', () => resolve(s.address().port));
});
const close = (s) => new Promise(resolve => s.close(resolve));
const stub = createServer((_req, res) => res.writeHead(404).end());
const stubPort = await listen(stub);
let total = 0;
try {
	for (const round of [1, 2]) {
		const run = makeTempRun('pia-test-startup-isolation-');
		let server;
		try {
			const bin = join(run.runDir, 'fake-bin'), count = join(run.runDir, 'system-calls'), startup = join(run.runDir, 'startup.json');
			mkdirSync(bin);
			writeFileSync(count, '');
			for (const command of ['security', 'powershell']) {
				const fake = join(bin, command);
				writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$PIA_TEST_SYSTEM_CALLS"\nexit 44\n`, { mode: 0o700 });
				accessSync(fake, constants.X_OK);
			}
			const probe = createServer(), port = await listen(probe);
			await close(probe);
			server = startTempServer({ root, port, run, extra: {
				PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, PIA_HOST: '127.0.0.1',
				PIA_WORKSPACE: join(run.data, 'workspace'), PIA_SECRETS: 'system', // deliberately conflicting; launcher must override
				PIA_TEST_SYSTEM_CALLS: count, PIA_TEST_STARTUP_FILE: startup,
			} });
			const base = `http://127.0.0.1:${port}`;
			const request = async (path, value, method = value ? 'POST' : 'GET') => {
				const res = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(3000), ...(value && { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
				assert.ok(res.ok, `${path}: HTTP ${res.status}`);
				return res.json();
			};
			const deadline = Date.now() + 15000;
			let storeCalls;
			while (storeCalls === undefined && Date.now() < deadline && server.child.exitCode === null) {
				try { ({ storeCalls } = JSON.parse(readFileSync(startup, 'utf8'))); }
				catch { await new Promise(resolve => setTimeout(resolve, 60)); }
			}
			assert.ok(storeCalls > 0, `内存模型存储未就绪：${server.logs()}`);
			const memoryPath = '/api/memory/hindsight';
			const before = await request(memoryPath);
			assert.equal(before.inUse, false);
			assert.equal(before.status.state, 'off');
			assert.equal(before.settings.mode, 'local');
			assert.equal(before.settings.mirror, 'auto');
			assert.deepEqual(await request(memoryPath, { mirror: 'official' }, 'PUT'), { ok: true, restarting: false, rebuild: false });
			const after = await request(memoryPath);
			assert.deepEqual(after.settings, { ...before.settings, mirror: 'official' });
			assert.equal(after.inUse, false);
			assert.equal(after.status.state, 'off');
			assert.equal(statSync(join(run.data, 'master.key')).mode & 0o777, 0o600, '高级记忆路径已使用临时文件密钥');
			assert.deepEqual(await request('/api/mcp'), [], '独立目录不含上一轮扩展');
			const input = { name: `isolated_extension_${round}`, enabled: false, config: { type: 'http', url: `http://127.0.0.1:${stubPort}/mcp`, description: `synthetic-${round}` } };
			const saved = await request('/api/mcp', input);
			const list = await request('/api/mcp');
			assert.equal(list.length, 1);
			assert.equal(list[0].id, saved.id);
			assert.equal(list[0].name, input.name);
			assert.deepEqual(list[0].config, input.config);
			assert.equal(statSync(join(run.data, 'master.key')).mode & 0o777, 0o600);
			await server.stop();
			const attempts = readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length;
			total += attempts;
			assert.equal(attempts, 0, '不应触发任何系统后端替身');
			console.log(`PASS run=${round}: Hindsight GET/PUT/GET (off), then MCP save/readback, memoryStoreCalls=${storeCalls}, systemBackendCalls=${attempts}`);
		} finally { await server?.stop(); cleanupTempRun(run); }
	}
	console.log(`PASS two isolated starts, totalSystemBackendCalls=${total}`);
} finally { await close(stub); }
