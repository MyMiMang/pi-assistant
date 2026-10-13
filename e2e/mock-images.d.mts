export interface MockImages {
	server: import("node:http").Server;
	seen: { method?: string; path: string; headers: import("node:http").IncomingHttpHeaders; body: string; json: any }[];
	base: string;
	url: string;
	close(): void;
}
export function makePng(w?: number, h?: number, seed?: number): Buffer;
export function startMockImages(o?: { port?: number; key?: string }): Promise<MockImages>;
