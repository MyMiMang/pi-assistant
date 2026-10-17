# beta.31 UI 修复验收（2026-10-18）

用户反馈beta.30主题介绍越框、助手回复只剩引用、完整模型目录太小；补充轻微思考胶囊动态、暗夜排首且默认，明确全部完成后提交打包。尚未安装候选App，不以源码测试冒充真机。

## 最终实现

- `message-body.ts`/`ChatMessages.tsx`：空error/interrupted依然显示气泡与明确原因。主会话只读本agent HTTP最近200条、仅输出结构聚合：25条assistant/error无正文、其中23条超时。最新三条done有正文不能代表旧空白行，前期“显示故障集中”的表述据此纠正。未删历史数据。详见[空白根因](beta30-blank-reply-root-cause.md)。
- `Settings.tsx`：主题卡片明确`whitespace-normal`与`overflow-wrap:anywhere`、grid/flex最小宽0，名称可换行、标记不压缩；不靠截断/隐藏介绍解决。
- `ModelPicker.tsx`：完整目录420px（视口-16px封顶），独立于首层340px；使用真实一侧可用空间与bottom/top锚点，去掉上一层maxHeight影响自然高度测量的循环。搜索/两层Esc/焦点/选择返回保留，模型池菜单同样接宽度。
- `ThinkingSlider`与专属`thinking-slider-motion.css`：off无动画，六档1/3/5/8/12/16粒子，轻微色流/光晕/粒子CSS循环，速度6–11s光带/4–9s粒子，色彩复用主题token；三层均乘DIY速度/光晕，steps成步、reduce全停。白色实心无字滑钮始终在最上层。未修改thinking/Fast参数。
- `themes/registry.ts`：暗夜移首；DEFAULT原本就是noir，继续保留初始暗夜及用户主动选择。

## 实跑与证据

- Node24.19；最终web build exit0：`index-B2afDUUy.js`/`index-0e70mwj3.css`，两端tsc exit0。
- 59/59纯测试：message-body、thinking-slider-frontend、model-menu-two-level、release-scope。
- 主题布局真实隔离服务UI：24组合（1280/760/390×light/dark×四主题），逐卡检查文本绘制范围/scrollWidth/高度，合法无空格DIY长名；暗夜首位及初始默认断言。先前未覆盖每张radio里继承的nowrap，已补。
- 目录真实DOM假API：1280×900宽420、可视476、11条可见、3分组；390×844宽374、11条可见；常用5项、多服务、超长名称、无越界/重叠、Esc/焦点和选完返回通过。旧dist下测试复现4项失败（320宽、190可视、5条、0完整分组），并非只断言控件存在。
- 消息真实DOM假API：noir/pixel×light/dark四组合，正常正文、空超时、空连接错误、空中断均有非透明可见文字。初始fixture缺host-control DTO曾pageerror/超时，补齐fixture后通过，未为迁就测试改产品。
- 动效真实隔离服务：七档两时刻采样，六档flow/glow transform与粒子transform/opacity确实变化；off静止、DIY1.2倍率三层均生效、steps成步、reduce三层animation none。首次测试没有考虑“选档后弹层按契约关闭”而空DOM，修正脚本重开后通过，非产品失败。
- 受影响Fast UI64/64通过。首次子代理截图前直接Esc时悬停说明还未出现，按契约把菜单关闭；改脚本先等hover-tip再Esc后通过，未改Esc产品行为。
- 查看7张关键截图（主题1280/390、模型目录1280/390、max动效静帧、错误noir dark/pixel light），正文/错误可读、文字不越卡片、模型目录宽敞、实心圆钮与粒子可见。截图只能证明静态观感，动画靠时间采样。证据在`evidence/beta31-{ui,model-menu,message,ambient}`；Fast64图在`evidence/beta31-fast`，未逐图重审不称全部看过。

## 边界与后续

- 网络错误没有被本次根治。SDK审计提示Pi请求deadline默认300s、底层连接超时可能约10s，但缺每次底层cause，不将时长相似写成TCP/代理/网关的确证；不调大timeout、不加重复重试、不静默换模型。Pi自动重试进度尚未接成App专门状态，后续可独立设计，不能静默删掉失败历史。
- 独立只读复核未发现发布阻塞；极小窗口（高<约280px）最小高度、浏览器根字号非16px时窄屏6rem与96px换算仍有边界风险，未扩展为此次已验证范围。主审进程检查无本次测试/launch-memory残留。未跑全量测试/全量e2e/跨平台完整任务/真机WebKit候选；Chromium模拟手机不等于物理手机。发布按现有all-intel五平台及Mac/Windows安装启动smoke，结果待workflow。未自动安装。
- beta.30 Actions39055072812已全部成功，2026-10-17T18:09:53Z公开Latest；主核13非零资产、6条更新平台别名/URL版本一致/签名非空。beta.31修复将用新tag，不移动beta.30。
