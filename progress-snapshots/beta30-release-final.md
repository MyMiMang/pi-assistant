# beta.30 发布前最终收口

2026-10-18，基公开 beta.29 / main `2e87f51`。用户已授权撤下电脑快速选择器，完成后推送打包。当前仍未公开，不能当已安装App验收。

## 最终范围

请求级Fast+两层紧凑菜单/滑块最终视觉、原生启动环境修正；撤下电脑快速选择器的runtime/HTTP/UI/Laya下载注册。通用classifier元数据、直接CUA/host CDP/助理Playwright及权限保留。研究代码与raw历史保留但不挂产品运行链路；用户已装模型/文件/设置不自动删除，现有生产模型未操作。

最终复核补修Fast说明为“从下一次请求起持续生效，直到更改”，不再暗示仅一次请求；修正ModelServices文件尾空行。

## 实际验证

- 最终两端tsc exit0、web build exit0，`index-9KniBKcv.js`。
- 服务端8文件64/64：fast-mode、native launch(+真实无害stdio子进程)、host-control、custom provider、classifier HTTP discovery、local registration/status；独立synthetic HOME/TMP/DATA/WORKSPACE+setup预加载/offline，假loopback服务，无真实模型。
- 纯检查23/23：request Fast frontend、两层菜单、native browser env fixture、release-scope/workflow校验。
- 最终构建Fast UI64/64，日志`logs/beta30-final-fast-ui.log`；包含持续生效文案、保存/回滚/迟到写入、Esc/焦点、390、子代理跟随/覆盖、子集与不支持协议。
- 新`e2e/fast-selector-removal-ui.mjs`：真实隔离服务+内存凭据+mock/offline与自有headless Chromium；host/computer/models页面无旧入口、权限与电脑开关保留、Laya下载登记消失、旧API未挂、聊天Fast和slider保留、无pageerror。第一次用了不存在的`settings=desktop`等待超时；修正测试键为`computer`后一次通过，记录失败，未修改产品行为来迁就测试。
- 撤入口四图已由主会话查看：`evidence/beta30-final-ui/{host,desktop,models,chat-fast-retained}.png`，真实可见无明显错页/布局问题。Fast原始稳定图另存`evidence/beta30-final-fast`，未全部重新识图，不称全部已查。
- 清理采用统一temp-server组TERM/KILL和browser.close；final进程白名单确认见发布后HANDOFF，不杀历史进程。

## 审查与限制

只读独立review对519ec4f未发现新阻塞，指出Fast一次性文案已修；macOS 12/13的`open --env`未实机验证，保留风险，不关闭SSL验证或改系统授权。现有request Fast公开hook证据/保留菜单行为经主会话复核。

当前实际服务/账号加速、真实计费、Codex登录Fast、真机App完整流程、Windows/Linux/Intel实机、全量单测/e2e未验；系统TCC跨升级保持和精确keychain因果未解决。此次候选不含新增语音实现，不用这些历史待验事项冒充已完成。发布范围保持`.github/release-scope.json` all-intel；五平台构建及安装冒烟交workflow，结果另记。
