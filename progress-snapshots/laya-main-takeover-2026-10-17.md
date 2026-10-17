# Laya 返回后主模型真实接管验收（2026-10-17）

本次主会话本人完成操作，测试代码基线 `8c99210`。只启动一个受外部 supervisor 监护的隔离会话，未重跑旧四题评分，未调整 0.6 门槛，未更换用户模型，未发布或安装。

## 实际结果

真实注册的 `fast_pick_action` handler 经生产 `buildChooser` 调用本机 Laya multilingual，每题调用一次，共三次。三次都返回 low_confidence。主会话读到真实返回后，主动读取新的 semantic_v2 快照，亲自选择 ref，经同一个 MCP session 的公开 browser_click 工具完成任务；桥接程序只负责送达明确命令，不按目标或预期答案自动选择。

| 任务 | Laya 比较值 | 主会话实际点击 | 机器证据 | 独立页面证据 |
|---|---:|---|---|---|
| 提交 | 0.5302 | p3:1 提交 | clicked=submit | status=提交完成 |
| 城市下拉 | 0.4036 | p7:3 城市；新快照 p8:9 北京 | selected=北京 | status=已选择 北京，combobox value=北京 |
| 动态两步 | 0.3558 | p12:5 下一步；新快照 p13:6 完成 | step=2, clicked=finish | status=流程完成 |

主模型接管 **3/3 完成**，共 5 次 trusted 点击，无重试，无程序固定下拉辅助。Laya 本次 **0/3 自行派发**；这三题就是此前低置信度的题，不能将本次接管结果算入 Laya 独立成功率。

报告条目 wall 分别 44.165 / 44.451 / 52.864 秒，含主会话推理、工具轮转和任务切换等待，不是模型纯推理耗时或自动化性能跑分。真实 handler wall 分别 1094 / 922 / 639 ms。

## 清理与恢复

开始 14:34:57Z，结束约 14:37:46Z。服务使用临时 HOME/DATA/WORKSPACE/TMPDIR；原生边界使用 OS HOME。生产 Laya baseline 34607，经正常 API 停一次，结束恢复 running pid 84356，health.ok=true、device=mps。独占 daemon 77527、自有 Laya 77537、隔离浏览器 77555 已退出；主会话 fresh pgrep 本次根无残留。supervisor exit=0、cleanup.ok=true、failures=[]、prodRestored=true。未动生产 daemon、日常 Chrome、用户设置或系统权限。

## 原始证据与范围

- `evidence/laya-benchmark-real/report-2026-10-17T14-34-57-077Z.json`：真实 handler 返回、逐个主会话命令、最终机器和 UI 状态、恢复记录，原样保留。
- `evidence/laya-benchmark-real/handoff-20261017T143456Z.log`：本地完整日志（gitignore）。
- `/tmp/pia-lb-amv7oy7ejb00-mvci05l5/supervisor-state.json`：外部监督状态；随临时目录清理可失效。

本次通过真实 handler + 真实 MCP + 本地真实模型 + 当前主会话决策，验证隔离页上的接管闭环。注册 definition 由测试取出，并非安装版 App 会话运行器自动调用；桥接 HTTP 只作用于本次 fixture。未声称安装版或任意网站自动接管已验证。新 browser 参数尚未出现在已安装 beta.29 的工具 schema。

主审额外给控制面 click 增加显式 input_route（trusted / dom_event），避免可信输入不可用时新快照 ref 改变后无法显式续接；本次全部使用 trusted，没有触发该分支。

## 下一步

主模型接管已从“仅返回提示”推进到三题真实完成。下一项仅改候选输入重复：候选保留在 criteria，state 仅保留 goal；依据上游输入格式建议，保留全部候选与现有门槛。该后续改动不属于本次实测代码，改善程度仍需单独测量，不能混用本报告成绩。
