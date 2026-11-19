import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from './temp-server.mjs';

export const keyword = '蓝图';
export const mainName = '项目验收 · 单聊';
export const roomName = '项目验收 · 设计群';
export const roomBName = '项目验收 · 测试群';
export const drafts = { single: '单聊保留的草稿，不发送', room: '群聊保留的草稿，不发送' };

export async function wait(fn, label) {
	for (let i = 0; i < 160; i++) {
		if (await fn()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out: ${label}`);
}

export async function startSearchFixture() {
	const root = fileURLToPath(new URL('../..', import.meta.url));
	assert.ok(existsSync(join(root, 'apps/web/dist/index.html')), 'Build the web workspace first');
	const port = await new Promise((resolve, reject) => {
		const socket = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
			const { port } = socket.address();
			socket.close(() => resolve(port));
		});
	});
	const base = `http://127.0.0.1:${port}`;
	const run = makeTempRun('pia-chat-history-search-');
	const server = startTempServer({ root, port, run });
	const json = async (path, method = 'GET', body) => {
		const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		assert.ok(r.ok, `${method} ${path}: ${r.status} ${r.ok ? '' : await r.text()}`);
		return r.json();
	};
	const launchBrowser = () => chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, env: browserEnv(run) });
	const seedMessages = (body) => {
		const db = new DatabaseSync(join(run.data, 'data.db'));
		try {
			const insert = db.prepare('INSERT INTO messages (id, agent_id, conversation_id, room_id, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
			db.exec('BEGIN');
			body(
				({ id, agentId, conv = null, roomId = null, text, role = 'assistant', ts }) => insert.run(id, agentId, conv, roomId, role, text, ts, ts),
				(id) => db.prepare('DELETE FROM messages WHERE id = ?').run(id),
			);
			db.exec('COMMIT');
		} finally { db.close(); }
	};
	const seedBase = async ({ secondMember = false } = {}) => {
		await wait(async () => (await fetch(base + '/api/system').catch(() => null))?.ok, 'temporary Mock server');
		assert.equal((await json('/api/system')).mock, true);
		await json('/api/settings', 'PUT', { onboarded: true });
		const createAgent = (name) => json('/api/agents', 'POST', { name, model: { provider: 'mock', id: 'echo' } });
		const agent = await createAgent('验收助理');
		const member = secondMember ? await createAgent('验收同事') : null;
		const convs = `/api/agents/${agent.id}/conversations`;
		const alternate = await json(convs, 'POST', { title: '另一条对话' });
		const primary = await json(convs, 'POST', { title: mainName });
		const createRoom = (name, memberIds) => json('/api/rooms', 'POST', { name, memberIds, managerId: agent.id });
		const room = await createRoom(roomName, member ? [agent.id, member.id] : [agent.id]);
		const otherRoom = await createRoom(roomBName, [agent.id]);
		seedMessages((insert) => {
			const ts = Date.now() - 60000;
			const seed = (id, conv, roomId, text, role = 'assistant') => insert({ id, agentId: agent.id, conv, roomId, text, role, ts });
			for (let n = 1; n <= 34; n++) seed(`fixture-p-${n}`, primary.id, null, `${keyword} Milestone ${String(n).padStart(2, '0')}：准备交付材料，整理本周项目进度。`, n % 3 === 0 ? 'user' : 'assistant');
			seed('fixture-alt', alternate.id, null, `${keyword} · 另一对话`, 'user');
			seed('fixture-room', null, room.id, `${keyword} · 设计群：本周评审确认图纸，周五提交交付清单。`, 'user');
			seed('fixture-room-second', null, room.id, `${keyword} · 设计群：请在周四前更新试制说明。`);
			seed('fixture-room-b', null, otherRoom.id, `${keyword} · 测试群专属`, 'user');
			seed('fixture-late', null, room.id, '迟到响应：仅旧设计群可见', 'user');
		});
		return { agent, member, primary, alternate, room, otherRoom };
	};
	return { base, server, json, launchBrowser, seedBase, seedMessages, cleanup: () => cleanupTempRun(run) };
}

export function searchPage(page) {
	const trigger = page.getByTestId('chat-history-search-open');
	const modal = page.getByRole('dialog', { name: '搜索聊天记录' });
	const field = page.getByTestId('chat-history-search-input');
	const list = modal.getByRole('list', { name: '聊天记录搜索结果' });
	const rows = list.getByRole('listitem');
	const composer = page.getByTestId('main-conversation').locator('textarea');
	const open = async (q) => {
		await trigger.click();
		await modal.waitFor();
		await wait(() => field.evaluate((el) => el === document.activeElement), 'search autofocus');
		await field.fill(q);
	};
	const close = async () => {
		await page.keyboard.press('Escape');
		await modal.waitFor({ state: 'hidden' });
	};
	const count = (n) => wait(async () => await rows.count() === n, `result count ${n}`);
	const roomButton = (name) => page.getByTestId('sidebar-room').filter({ hasText: name });
	const chooseConversation = async (title) => {
		const menu = page.getByTestId('conv-menu');
		await menu.click();
		await page.getByRole('list').getByText(title, { exact: true }).click();
		await wait(async () => (await menu.innerText()).includes(title), `selected conversation ${title}`);
	};
	return { trigger, modal, field, list, rows, composer, open, close, count, roomButton, chooseConversation };
}
