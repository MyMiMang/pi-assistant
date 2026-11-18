import type { BrowserContext, Page } from "playwright-core";

/** 宿主提供唯一的页归属与输入执行器；扩展不再缓存 current/owned/context。 */
export interface BrowserSessionPort {
	context(): Promise<BrowserContext>;
	page(create?: boolean): Promise<Page>;
	pages(): Promise<Page[]>;
	newPage(): Promise<Page>;
	select(page: Page): void;
	switchContext(mode: "shared" | "isolated"): Promise<void>;
	/** capture 在审批前取得的身份；check 须在每个异步间隙之后、输入之前再次执行。 */
	capture(page: Page): unknown;
	check(page: Page, lease: unknown): void;
	run<T>(page: Page, lease: unknown, action: (check: () => void) => Promise<T>): Promise<T>;
	takeover(page: Page): Promise<number>;
	giveBack(page: Page, expectedGeneration?: number): Promise<void>;
}
