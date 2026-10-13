#!/usr/bin/env bash
# 生成本次发布的更新说明（GitHub Release 正文 + latest.json 的 notes，应用里「关于/更新」会显示）。
# 优先用 docs/release-notes/<tag>.md（手写的、给用户看的）；没有就用上一个 tag 以来的提交标题（每条截到 120 字）。
set -euo pipefail
TAG="${1:-${GITHUB_REF_NAME:-}}"
F="docs/release-notes/${TAG}.md"
if [ -n "$TAG" ] && [ -f "$F" ]; then cat "$F"; else
  PREV=$(git describe --tags --abbrev=0 "${TAG}^" 2>/dev/null || true)
  RANGE=${PREV:+$PREV..}${TAG:-HEAD}
  echo "本次更新："
  git log --no-merges --format='%s' "$RANGE" 2>/dev/null | head -30 | perl -CSDA -Mutf8 -pe 's/^(.{120}).+/$1…/; s/^/- /'
fi
echo
echo "安装说明见 docs/INSTALL.md（未签名构建：macOS 首次打开需右键 → 打开；Windows SmartScreen 选“仍要运行”）。"
