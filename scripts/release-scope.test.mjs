import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { releasePlan, validateRelease } from './release-scope.mjs';

test('Mac 范围强制只构建 arm64，即使 Intel 开关开启', () => {
  for (const intel of [true, false]) {
    const p = releasePlan('mac-arm64', intel);
    assert.deepEqual(p.matrix.map(x => x.target), ['aarch64-apple-darwin']);
    assert.equal(p.linux || p.windows || p.intel, false);
  }
  assert.equal(releasePlan('all', false).matrix.length, 2);
  assert.equal(releasePlan('all', true).matrix.length, 3);
  assert.throws(() => releasePlan('typo'));
});
const tag = 'v0.1.0-beta.19';
const assets = ['Pi.Assistant_0.1.0-beta.19_aarch64.dmg', 'Pi.Assistant_aarch64.app.tar.gz', 'Pi.Assistant_aarch64.app.tar.gz.sig', 'latest.json'];
const latest = () => ({ version: tag.slice(1), platforms: { 'darwin-aarch64': { signature: 'signed', url: 'https://github.com/MyMiMang/pi-assistant/releases/download/untagged-test/Pi.Assistant_aarch64.app.tar.gz' } } });
test('发布前验证实际平台与资产，不能把 arm 更新误送其他平台', () => {
  const p = releasePlan('mac-arm64');
  assert.match(validateRelease(p, assets, latest(), tag).platforms['darwin-aarch64'].url, /download\/v0.1.0-beta.19\//);
  for (const key of ['windows-x86_64', 'darwin-x86_64', 'linux-aarch64']) {
    const j = latest(); j.platforms[key] = j.platforms['darwin-aarch64'];
    assert.throws(() => validateRelease(p, assets, j, tag));
  }
  const j = latest(); j.platforms['darwin-aarch64'].url = 'https://example.com/Windows.exe';
  assert.throws(() => validateRelease(p, assets, j, tag));
  assert.throws(() => validateRelease(p, assets.filter(a => !a.endsWith('.sig')), latest(), tag));
  assert.throws(() => validateRelease(p, [...assets, 'setup.exe'], latest(), tag));
});
test('工作流跳过的 Windows/Linux 不阻塞发布，但构建或 Mac 安装冒烟失败必阻塞', () => {
  const w = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  assert.match(w.jobs.linux.if, /build_linux/);
  assert.match(w.jobs['windows-smoke'].if, /build_windows/);
  assert.ok(w.jobs.publish.needs.includes('prepare'));
  assert.match(w.jobs.publish.if, /always\(\)/);
  assert.match(w.jobs.publish.if, /needs.build.result == 'success'/);
  assert.match(w.jobs.publish.if, /needs.mac-smoke.result == 'success'/);
  assert.match(w.jobs.publish.if, /build_linux == 'false'.*needs.linux.result == 'skipped'/);
  assert.match(w.jobs.publish.if, /build_windows == 'false'.*needs.windows-smoke.result == 'skipped'/);
});
