import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function releasePlan(scope, intel = false) {
  // 发布范围：`mac-arm64`（仅 Apple 芯片 Mac）/ `all`（Mac arm64 + Windows + Linux x64/arm64）/ `all-intel`（在 `all` 基础上加 Intel Mac x64）。
  // `all-intel` 是显式可审计的写法：tag 触发也照它执行，不依赖仓库变量 BUILD_INTEL。
  const wantIntel = scope === 'all-intel';
  const base = wantIntel ? 'all' : scope;
  if (!['mac-arm64', 'all'].includes(base)) throw new Error(`未知发布范围：${scope}`);
  const macOnly = base === 'mac-arm64';
  const withIntel = !macOnly && (wantIntel || intel);
  const matrix = [{ os: 'macos-14', target: 'aarch64-apple-darwin', label: 'macOS-arm64' }];
  if (withIntel) matrix.push({ os: 'macos-15-intel', target: 'x86_64-apple-darwin', label: 'macOS-x64' });
  if (!macOnly) matrix.push({ os: 'windows-latest', target: 'x86_64-pc-windows-msvc', label: 'Windows-x64' });
  return { scope: base, matrix, linux: !macOnly, windows: !macOnly, intel: withIntel };
}

export function validateRelease(plan, assets, latest, tag) {
  const patterns = [/aarch64\.dmg$/, /^latest\.json$/, /\.app\.tar\.gz$/, /\.app\.tar\.gz\.sig$/];
  if (plan.windows) patterns.push(/x64-setup\.exe$/);
  if (plan.linux) patterns.push(/linux-x64\.tar\.gz$/, /linux-arm64\.tar\.gz$/);
  if (plan.intel) patterns.push(/x64\.dmg$/);
  for (const p of patterns) if (!assets.some((a) => p.test(a))) throw new Error(`草稿缺少 ${p}`);
  if (latest.version !== tag.slice(1)) throw new Error('更新清单版本与 tag 不一致');
  const platforms = Object.entries(latest.platforms ?? {});
  if (!platforms.some(([key]) => key === 'darwin-aarch64')) throw new Error('更新清单缺少 darwin-aarch64');
  for (const [key, item] of platforms) {
    if (plan.scope === 'mac-arm64' && !/^darwin-aarch64(?:-.*)?$/.test(key)) throw new Error(`本轮未构建平台：${key}`);
    if (!plan.intel && key.startsWith('darwin-x86_64')) throw new Error('未构建 Intel 却存在更新项');
    if (!item.signature || typeof item.url !== 'string') throw new Error(`更新项不完整：${key}`);
    const url = new URL(item.url);
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (!assets.includes(name)) throw new Error(`更新项资产不存在：${name}`);
    if (plan.scope === 'mac-arm64' && !/aarch64.*\.app\.tar\.gz$/.test(name)) throw new Error(`arm 更新项指向错误资产：${name}`);
    url.pathname = url.pathname.replace(/\/releases\/download\/[^/]+\//, `/releases/download/${tag}/`);
    item.url = url.href;
  }
  if (plan.scope === 'mac-arm64' && assets.some((a) => /(?:x64\.dmg|\.exe|linux-.*\.tar\.gz)$/.test(a))) throw new Error('仅 Mac arm64 的草稿混入其他平台安装包');
  return latest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scope = process.env.RELEASE_SCOPE || JSON.parse(readFileSync('.github/release-scope.json', 'utf8')).scope;
  const plan = releasePlan(scope, process.env.BUILD_INTEL === 'true');
  if (process.argv[2] === 'validate') {
    const assets = readFileSync('assets.txt', 'utf8').trim().split('\n');
    const latest = validateRelease(plan, assets, JSON.parse(readFileSync('latest.json', 'utf8')), process.env.REL_TAG);
    const { writeFileSync } = await import('node:fs');
    writeFileSync('latest.json', JSON.stringify(latest, null, 2));
  } else {
    // 输出原始 scope（含 `all-intel`），让 publish 阶段按同一配置重新推导，不依赖仓库变量
    console.log(`scope=${scope}\nbuild_matrix=${JSON.stringify(plan.matrix)}\nbuild_linux=${plan.linux}\nbuild_windows=${plan.windows}\nbuild_intel=${plan.intel}`);
  }
}
