# beta.32 发布后只读核验证据

- 核验时间：2026-10-18T08:37Z（Asia/Shanghai 16:37）
- repo：MyMiMang/pi-assistant，tag：`v0.1.0-beta.32`，版本：`0.1.0-beta.32`
- tag 指向源码提交：`a08e041b4f5d857afe1a62e7dc8b1faa05e0ef7b`（本地 `git rev-list -n1 v0.1.0-beta.32` 一致；正式 main 当前 HEAD `da516b6` 为文档提交，工作树干净）
- 发布页：https://github.com/MyMiMang/pi-assistant/releases/tag/v0.1.0-beta.32
- 发布时间：`2026-10-18T08:29:18Z`
- Latest = true，draft = false，prerelease = false，资产 13 个且全部非零

## 文件

- `published-verification.json`：本次脚本 `tools/verify-beta32-release.mjs` 生成（发布/资产/更新清单/签名文本/Linux checksum 核验）
- `workflow-verification.json`：`gh run view 39109851436` 原样输出（status/conclusion/headSha/jobs/时间）
- `actions-run.json`、`latest-pointer.json`：核验目录中已存在的同批次辅助证据（非本次脚本产出），内容与 beta.32 一致（run 39109851436 / headSha a08e041 / latest.json version 0.1.0-beta.32、6 个别名）

## 结果

- Actions run 39109851436：status completed，conclusion success，headSha = `a08e041b4f5d857afe1a62e7dc8b1faa05e0ef7b`（精确匹配）
- 五个构建 job 全部 success：`build (macos-14, aarch64-apple-darwin, macOS-arm64)`、`build (macos-15-intel, x86_64-apple-darwin, macOS-x64)`、`build (windows-latest, x86_64-pc-windows-msvc, Windows-x64)`、`linux (ubuntu-24.04, x64)`、`linux (ubuntu-24.04-arm, arm64)`
- 两个冒烟 job success：`mac-smoke`、`windows-smoke / smoke`
- `publish` success（08:29:10Z → 08:29:20Z）；`cleanup-dry-run` 为设计内 skipped
- 更新清单 `latest.json`：version `0.1.0-beta.32`，6 个别名（darwin-aarch64、darwin-aarch64-app、darwin-x86_64、darwin-x86_64-app、windows-x86_64、windows-x86_64-nsis）齐全；每个别名的 URL 指向本 tag 的已发布资产，签名字段与对应 `.sig` 文本逐字一致
- Linux：
  - x64 `pi-assistant-0.1.0-beta.32-linux-x64.tar.gz`（170,258,846 B）sha256 `2bb653748a12d0cb8162e22e29d6296623108df2e7ee3d0fa6a651ddc2ce339d`
  - arm64 `pi-assistant-0.1.0-beta.32-linux-arm64.tar.gz`（166,816,451 B）sha256 `14f01870c9dbe904443a788314a35e1bf4a766ff687ea1f6d1ba1d842a16b63f`
  - 两者 checksum 文本中的哈希与 GitHub 资产 digest 一致

## 边界（不得外推）

1. 签名核验只比较「更新清单 signature 字段」与「已发布 `.sig` 文件文本」是否一致，**未**用公钥做独立密码学验签。
2. Linux 只核对 checksum 文本与 GitHub 资产 digest 是否一致，**未**下载归档后重新计算哈希。
3. CI 中的 macOS / Windows 安装启动冒烟只证明安装与启动链路可用，**不代表**多平台完整任务验收；本次未在用户机器上安装或重启任何生产 App。
