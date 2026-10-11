// 打包时预先下载第三方二进制到 $PIA_DATA_DIR/bin（复用服务端的下载 + SHA256 校验，版本以 third-party.json 为准）。
// 安装包把它们放进 app/bin-seed，首次启动时复制进用户数据目录，用户机器上不再联网下载。
import { ensureCloudflared } from "../packages/server/src/cloudflared-bin.ts";
import { ensureCua } from "../packages/server/src/host-control.ts";
import { ensureUv } from "../packages/server/src/memory/hindsight/uv-bin.ts";

const log = (m: string) => console.log(`[fetch-bins] ${m}`);
console.log("cloudflared →", await ensureCloudflared(log));
console.log("uv →", await ensureUv({ onProgress: log }));
console.log("cua-driver →", await ensureCua(log));
process.exit(0);
