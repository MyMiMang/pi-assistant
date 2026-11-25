import { getRequestListener } from "@hono/node-server";
import { createServer, type ServerOptions } from "node:https";
import { TLSSocket } from "node:tls";

const origins = new WeakMap<Request, string>();
export const desktopPeerOrigin = (request: Request) => origins.get(request);

/** An explicit direct-TLS listener; never derives trusted context from forwarding headers. */
export function startDesktopPeerTls(opts: { hostname: string; port: number; origin: string; tls: Pick<ServerOptions, "key" | "cert">; handle: (request: Request, origin: string, incoming: import("node:http").IncomingMessage) => Response | Promise<Response> }) {
	const origin = new URL(opts.origin);
	if (origin.protocol !== "https:" || origin.origin !== opts.origin || (opts.port !== 0 && Number(origin.port || 443) !== opts.port)) throw new Error("Invalid desktop HTTPS origin");
	const listener = getRequestListener(async (request, env) => {
		origins.set(request, origin.origin);
		try { return await opts.handle(request, origin.origin, env.incoming as import("node:http").IncomingMessage); }
		finally { origins.delete(request); }
	});
	const server = createServer({ key: opts.tls.key, cert: opts.tls.cert, minVersion: "TLSv1.2" }, (req, res) => {
		if (!(req.socket instanceof TLSSocket) || !req.socket.encrypted || (req.socket as TLSSocket & { servername?: string }).servername !== origin.hostname || req.headers.host !== origin.host || !req.url?.startsWith("/") || req.url.startsWith("//")) {
			res.writeHead(421, { "cache-control": "no-store" }).end();
			return;
		}
		void listener(req, res);
	});
	return server.listen(opts.port, opts.hostname);
}
