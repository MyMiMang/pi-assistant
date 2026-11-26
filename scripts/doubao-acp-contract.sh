#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
image=docker.io/library/python@sha256:2b4f19dae3a777dfc3b76730bda1e82e1f66ab2a2686fa93ca78edbfb4f04ffe
sha=1d1133ba70e4911b4ee5e37baf8896443b9fc0503fd82c8a053554b3a69795ec
if [[ $(uname -sm) != 'Linux x86_64' || $(docker info --format '{{.OSType}}/{{.Architecture}}') != linux/x86_64 ]]; then
  printf '%s\n' '{"recorded":true,"handshake":false,"stage":"native_host_required"}'
  exit 1
fi
work=$(mktemp -d)
trap 'if [[ -s "$work/cid" ]]; then docker rm -f "$(< "$work/cid")" >/dev/null 2>&1 || true; fi; rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export DOCKER_CONFIG="$work/docker"
mkdir -p "$DOCKER_CONFIG"
curl -q --fail --silent --show-error --proto '=https' --max-time 120 \
  'https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao_cli/2.38.2/doubao-cli-2.38.2-linux-x64-signed.tar.gz' -o "$work/cli.tgz"
printf '%s  %s\n' "$sha" "$work/cli.tgz" | sha256sum --check
docker pull --platform linux/amd64 "$image"
docker run --rm -i --cidfile "$work/cid" --pull=never --platform linux/amd64 \
  --network=none --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=950m,mode=1777 \
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --entrypoint /usr/bin/env "$image" -i PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/python3 -I -B -c "$(< scripts/doubao-acp-contract.py)" < "$work/cli.tgz"
