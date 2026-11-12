/** Amp 独立官方 runtime：复用安装器，绝不查找宿主命令或执行供应脚本。 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { NativeInstaller, type NativeRelease, type NpmRun } from "./native-install.ts";

const component = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../third-party.json"), "utf8")).components.find((entry: { name: string }) => entry.name === "amp-cli-runtime");
export function ampRuntimeInstaller(dataDir: string, release: NativeRelease = { ...component, packageName: component.name }, run?: NpmRun): NativeInstaller {
 return new NativeInstaller({ dataDir: join(dataDir, "runtimes", "amp"), downloadPrefix: "native-runtime", releases: { "amp-acp": release }, run });
}
export function ampRuntimeCommand(dataDir: string): string {
 const installed = ampRuntimeInstaller(dataDir).installed("amp-acp");
 if (!installed || !isAbsolute(installed.command) || installed.args.length) throw new Error("请先安装 Amp 官方私有运行程序与适配器");
 return installed.command;
}
