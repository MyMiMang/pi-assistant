/** ACP stdio MCP → 既有 HTTP 工具桥。只转发协议，不执行工具、不决定权限。 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { url, token } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const endpoint = new URL(url);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !/^\/internal\/tool-bridge\/[a-f0-9]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("工具桥必须是本机运行入口");
const pending = new Set();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function forward(line) {
 let message;
 try { message = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
 const controller = new AbortController();
 pending.add(controller);
 try {
  const response = await fetch(url, { method: "POST", redirect: "error", signal: controller.signal,
   headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(message) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (response.status !== 202) send(await response.json());
 } catch {
  if (message && (typeof message.id === "string" || typeof message.id === "number")) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "本机工具桥连接失败" } });
 } finally { pending.delete(controller); }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => { void forward(line); });
const close = () => { for (const controller of pending) controller.abort(); process.exit(0); };
input.on("close", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
