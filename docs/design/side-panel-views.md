状态：阶段二与阶段三已实现并获总管验收，已纳入 beta.72 发布整合；含最终 WS 控制代际守卫。Mac 临时 Chromium 同Page集成已验，真实sandbox及跨平台交互未验

# 统一右工作区

沿用SidePanel全部调用方：执行概览、群任务看板/详情、群与单聊项目、提醒；文件直接登记统一注册表，复用PreviewContent及全部原格式视图。旧单文件store和portal槽位已删除。入口收束见[决策 0033](../decisions/0033-unified-right-rail.md)：收起时聊天标题栏保留单一工作区入口，展开时使用单排标签及控制，不另显示当前标题。

职责：workspace-state.ts只管标签转换和scope；workspace.ts持有当前scope有限内容注册，校验owner和scope；SidePanel.tsx登记内容并由固定SidePanelDock宿主显示。固定section节点仅切hidden/CSS，不因标签切换、收起、放大或手机布局而重挂。ResponsiveTabs复用更多菜单，标题完整tooltip；关闭当前标签后选相邻，收起/返回聊天只隐藏并解除放大。新标签起始页是临时占位，激活真实内容时替换该占位。筛选只匹配可用的文件、网页、助理详情、模型设置入口，不查询文件、会话或网页内容。文件预览的文件名只显示在标签；文件工具栏保留类型、大小、下载和关闭。

每个scope最多12项，第13项明确拒绝并显示workspace-limit-notice，用户手动关闭后才能新增。没有跨重启/多会话隐藏缓存；助理/群/对话变化主动清空全部当前内容。旧scope迟到update/unregister无效，dispose回调期间禁止重新注册，owner替换后旧cleanup不能删除新owner。

稳定对象键：file:<授权地址>、executions:<群或助理/对话查询>、work-items:<群ID>、projects:<接口base>、reminders、browser:<助理或群>；scope独立绑定群或助理+对话。标题不作身份。

布局复用layout.PREVIEW/previewW与Resizer，扣左栏后保证聊天520；放不下则单内容页并有返回聊天。统一工作区独立pa-workspace样式，使用主题panel/line/fg/mut，避免与主题设计器pa-preview冲突。详情八分类不变。

## 业务内容扩展示例与主题

新增内容只在业务模块调用registerWorkspace，传稳定key/title/语义kind/content与必要owner/onClose；宿主不新增业务分支。InfoPane 按 `settings:agent:<agentId>` 登记一份助理详情，八分类保留。助理名/群成员进入概览，大脑、输入框快速模型菜单里的「完整设置」与起始页「模型设置」进入同一详情的模型分类；顶部控制就地放大。唯一 ModelSettingsContent、ModelPicker、ContextDetails、图片与帮手模型设置及即时写队列均复用。保存目标固定 agentId，群成员上下文仍取群成员 conversationId。全局设置不迁移，不混入当前助理作用域。

主题不新增变量或独立配色：panel/line/fg/mut/bg/card/hover等语义变量与现有按钮/ResponsiveTabs/Resizer共用。四内置主题与DIY通过现有manifest→注册→setAppearance链路生效；CSS布局不以skin作key，不因主题切换重挂。使用正式copy-pixel另存的临时DIY实例测试，既有减少动态效果链路保留。静态token接线不等同所有主题视觉全矩阵通过，实际截图和测试以报告为准。

## 浏览器阶段三接入契约

服务端browser-pages拥有runtime/context/page随机身份、文档代际、owned/popup/isolated与current；ext-browser不再另存页面状态。工具和网页查看共用同一Page与browser-control串行输入。审批前捕获租约，入队/出队/异步间隙再查；暂停版本使暂停后恢复也不能放行旧租约。接管立即作废排队，等待在途及重读有界，超时仍draining锁定；显式恢复及交还重读后才授予。接管不能撤销网站已提交的异步副作用。

browser-frames每Page单CDP流扇出，查看者仅一帧待确认加最新pending帧；真实JPEG解码绘制后ACK绑定连接/page/文档代际/序列/尺寸。导航或尺寸变化旧帧失效，匹配新帧绘制确认后开放输入；查看器CSS缩放不改变业务viewport。路由复用api鉴权、一次短时ticket、origin拒绝与设备撤销，前端无CDP地址。host在任务中不自动迁到sandbox，电脑归属变更明确报错；未实现无损运行环境迁移。

工作区关闭/注销只释放查看订阅；收起或切其他标签退订流，不关闭业务Page。断线不交还控制权。关闭网页为接管后的独立确认动作。UI复用SidePanel固定宿主、Select/Input/Button/ErrorBox/useConfirm及主题语义变量，提供页/群成员选择、前后退刷新/地址栏、接管/交还/锁定恢复、中文输入。未有网页时不启动浏览器或VM。上传下载沿用现有browser工具、工作区文件与requests，不做另一套文件链。

验证见e2e/browser-workspace-ui.mjs、browser-control.test.ts、browser-workspace.test.ts及阶段三报告。连续画面不带音频；输入法候选、拖拽/粘贴/网页原生文件选择、真实sandbox/Windows/Linux/Tauri/PWA远程未验。共用Help可交互链接最小修复和鼠标/Tab/Esc见help-links-ui.mjs。

## 验收接口

right-workspace的data-mode=docked/expanded/mobile，data-collapsed=0/1、data-scope；内容data-workspace-key，标签data-itab。workspace-tabs及-more/-menu、workspace-content、workspace-new-tab/start、workspace-expand/restore/collapse/reopen/close-tab/back-chat、workspace-browser-open/disconnected、workspace-files-open/agent-open/model-open、workspace-limit-notice；原业务testid保留。

纯状态单测workspace-state.test.ts；真实内容/DOM测试side-panel-views.mjs与file-preview.mjs的side-panel-section；React owner/scope竞态测试在忽略目录artifacts/right-workspace-react。候选交付时以实际日志为准，不把脚本存在当通过。
