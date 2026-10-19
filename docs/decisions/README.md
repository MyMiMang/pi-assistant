# 决策记录（decisions）

用户拍板过的决定，一条一个文件：`NNNN-标题.md`，不超过 15 行。**AI 不能自己推翻或绕开已有决策**；想改先问用户，用户同意后新写一条「取代 NNNN」，旧的那条把状态改成「已被 NNNN 取代」。

模板：
```
# NNNN 标题
- 日期：YYYY-MM-DD
- 状态：有效 / 已被 NNNN 取代
- 决定：一句话
- 原因：一两句
- 不做什么：被否掉的方案
- 影响：相关代码 / 设计文档
```

| 编号 | 决定 |
|---|---|
| [0001](0001-reuse-first.md) | 复用优先，先搜再写，禁止重复实现 |
| [0002](0002-pi-via-adapter.md) | 不改 Pi 本体，只经 pi-adapter 接入 |
| [0003](0003-hindsight-via-adapter.md) | 不改 Hindsight 本体，只经适配层接入 |
| [0004](0004-release-only-on-dabao.md) | 只有用户说「打包」才发布，不自动安装 |
| [0005](0005-remove-laya.md) | 撤下 Laya 与电脑快速候选选择器 |
| [0006](0006-group-collaboration.md) | 群聊：一个管理者 + 自主模式，只检测不设次数上限 |
| [0007](0007-ui-standard.md) | 界面标准：名称 + 一行说明，「?」，「高级」折叠，列表折叠 |
| [0008](0008-agent-details-classic.md) | 助理详情经典布局，模型页复用 ModelPicker |
| [0009](0009-memory-reliability.md) | 记忆：先存基础再同步高级，故障必须让用户知道 |
| [0010](0010-artifacts-not-committed.md) | 截图 / 证据不入库 |
| [0011](0011-project-standards.md) | 项目规范化：AGENTS.md 唯一入口 + 自动检查 |
| [0012](0012-no-auto-upstream-updates.md) | Pi / Hindsight 不自动升级，开发时手动升级 |
| [0013](0013-local-voice-optional.md) | 本地语音识别是可选模块，默认不安装 |
| [0014](0014-task-and-helper.md) | 「任务」与「帮手」：任务类机制合并，帮手最多再派一层，核验通过记忆自动转正 |
