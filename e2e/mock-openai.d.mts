export interface MockOpenAI {
	server: import("node:http").Server;
	seen: { method?: string; url?: string; headers: import("node:http").IncomingHttpHeaders; body: string }[];
	url: string;
	close(): void;
}
export function startMockOpenAI(o?: { port?: number; key?: string; requiredHeader?: [string, string] | null }): Promise<MockOpenAI>;
