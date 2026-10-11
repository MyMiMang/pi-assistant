#!/usr/bin/env bash
# 部署 Rendezvous + PWA 外壳到 Cloudflare。
# 需要环境变量：CLOUDFLARE_API_TOKEN（权限见 README）、CLOUDFLARE_ACCOUNT_ID
# 可选：HUHAO_ENTRY_DOMAIN（默认 app.dengdengyun.shop，必须是该账号下已托管的域名的子域名）
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?请设置 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?请设置 CLOUDFLARE_ACCOUNT_ID}"
DOMAIN="${HUHAO_ENTRY_DOMAIN:-app.dengdengyun.shop}"
WR="npx --yes wrangler@4"

echo "▶ 构建 PWA 外壳"
(cd ../.. && npm run build -w @huhao/web)

if grep -q REPLACE_WITH_KV_NAMESPACE_ID wrangler.toml; then
  echo "▶ 创建 KV 命名空间"
  ID=$($WR kv namespace create SERVERS 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$ID" ] || { echo "创建 KV 失败"; exit 1; }
  sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/" wrangler.toml && rm -f wrangler.toml.bak
fi
sed -i.bak "s#pattern = \"[^\"]*\"#pattern = \"$DOMAIN\"#" wrangler.toml && rm -f wrangler.toml.bak

echo "▶ 部署到 https://$DOMAIN"
$WR deploy
echo "✅ 完成：curl https://$DOMAIN/api/servers/00000000-0000-0000-0000-000000000000 应返回 not_found"
