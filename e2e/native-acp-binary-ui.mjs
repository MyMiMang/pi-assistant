/** 第六个 CLI 回归入口：仅 Goose 假 binary，复用原生 UI 流程，不重复 npm / 卡片边界测试。 */
import { runNativeAcpUi } from "./native-acp-ui.mjs";

await runNativeAcpUi({
 samples: [{ kind: "goose", name: "Goose", update: false }],
 artifactName: "native-acp-binary-ui",
 boundaries: false,
});
