/**
 * 「本机命令行模型渠道」的通用服务：启动注册、检测、重新检测（装好后就地注册）、退出清理（方案 docs/design/cli-models.md §4.5）。
 * claude / codex / 以后的 agy 各给一份 `CliChannelAdapter`（见 `cli-services.ts`），流程只在这里写一份。
 *
 * 找得到命令才注册；Mock 模式和单测默认不注册（不因为开发机装了就改变模型列表），
 * 想在 e2e / 单测里启用就设 `PIA_<NAME>_COMMAND=<假命令的路径>`；设成空字符串表示明确关闭。
 */
import { existsSync } from "node:fs";
import { bus } from "./bus.ts";
import { config, env } from "./config.ts";
import type { PiModels } from "./pi-adapter/index.ts";

/** 每家要给的适配：怎么找命令、怎么检测、怎么注册 */
export interface CliChannelAdapter<S extends { installed: boolean; loggedIn: boolean }, C extends { disposeAll(): void }> {
	/** 接口 / 界面里的渠道名：`claude-code`、`codex` */
	id: string;
	/** 日志里的名字 */
	label: string;
	/** 指定命令路径的环境变量名（不含 `PIA_` 前缀），如 `CLAUDE_COMMAND` */
	envName: string;
	/** 在本机自己找命令 */
	find(): string | null;
	/** 没找到命令时的说明 */
	notFound: string;
	detect(command: string): Promise<S>;
	/** 创建并注册渠道（`command` 是取最新路径的函数） */
	register(models: PiModels, command: () => string | null): Promise<C>;
	/** 重新检测时刷新已注册渠道的模型列表（没有就不刷新） */
	refresh?(models: PiModels, channel: C): Promise<void>;
	/** true = 已登录才注册（codex 要先问模型列表）；false = 装了就注册，登录状态只在卡片里显示 */
	requireLogin: boolean;
	/** 检测结果里附带的额外信息（只读本机状态，不读凭证） */
	extra?(): Record<string, unknown>;
}

export type CliChannelInfo<S> = S & { registered: boolean } & Record<string, unknown>;

export function createCliChannelService<S extends { installed: boolean; loggedIn: boolean }, C extends { disposeAll(): void }>(a: CliChannelAdapter<S, C>) {
	let channel: C | undefined;
	/** 渠道注册在哪个模型目录上（initModels 可能被调用多次，每次换一个新目录，要重新注册） */
	let registeredOn: PiModels | undefined;

	/** 要用的命令路径：环境变量显式指定优先（空 = 关闭）；Mock 模式默认不找；否则在本机找。 */
	function command(): string | null {
		const forced = env(a.envName);
		if (forced !== undefined) return forced.trim() && existsSync(forced.trim()) ? forced.trim() : null; // 路径还不存在 = 还没装
		return config.mock ? null : a.find();
	}

	/** 正在进行的注册（启动时后台注册，界面同时点检测会撞上；合并成一次，别注册两遍） */
	let pending: { models: PiModels; p: Promise<boolean> } | undefined;

	/** 找得到命令（且按要求已登录）就注册；返回注册后是否可用。 */
	function ensure(models: PiModels, known?: S): Promise<boolean> {
		if (channel && registeredOn === models) return Promise.resolve(true);
		// 并入正在进行的那次；它没注册成（比如启动时命令还没装好）而现在可能装好了，就再按当前状态试一次
		if (pending?.models === models) return pending.p.then((ok) => ok || start(models, known));
		return start(models, known);
	}

	function start(models: PiModels, known?: S): Promise<boolean> {
		if (channel && registeredOn === models) return Promise.resolve(true);
		if (pending?.models === models) return pending.p;
		const p = (async () => {
			const cmd = command();
			if (!cmd) return false;
			if (a.requireLogin && !(known ?? (await a.detect(cmd))).loggedIn) return false;
			channel?.disposeAll();
			channel = await a.register(models, command);
			registeredOn = models;
			bus.emit({ type: "models.changed", provider: a.id }); // 这一家注册上了（后台注册 / 装好后重新检测），界面重新拉模型列表
			return true;
		})().finally(() => {
			if (pending?.p === p) pending = undefined;
		});
		pending = { models, p };
		return p;
	}

	/** 检测并（装好了就）注册，不用重启服务；`recheck` 时顺便刷新模型列表。 */
	async function check(models: PiModels, recheck = false): Promise<CliChannelInfo<S>> {
		const cmd = command();
		const status = cmd ? await a.detect(cmd) : ({ installed: false, loggedIn: false, error: a.notFound } as unknown as S);
		const wasRegistered = !!channel && registeredOn === models;
		if (status.installed) {
			try {
				if (await ensure(models, status)) {
					if (recheck && wasRegistered && channel && a.refresh) {
						await a.refresh(models, channel);
						bus.emit({ type: "models.changed", provider: a.id });
					}
				}
			} catch (e) {
				console.error(`[${a.id}] 注册模型渠道失败`, e);
			}
		}
		return { ...status, ...a.extra?.(), registered: !!channel && registeredOn === models };
	}

	return {
		id: a.id,
		command,
		registered: () => !!channel,
		/** 正在注册这一家的 Promise；没在注册返回 undefined */
		registering: (): Promise<boolean> | undefined => pending?.p,
		ensure,
		check,
		/** 服务关闭：结束还在跑的进程 */
		dispose: () => channel?.disposeAll(),
	};
}

export type CliChannelService = ReturnType<typeof createCliChannelService>;
