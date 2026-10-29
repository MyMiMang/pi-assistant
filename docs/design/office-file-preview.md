状态：已实现，随 beta.44 打包

# Office 等常用文件应用内预览（第二期）
接 [html-file-preview.md](html-file-preview.md)。复用 `FilePreview.tsx` 弹窗、`preview.ts` 判定、`FilePreviewViews.tsx` 的 `ModeBar` / `Notice` / `CodeView` / `loadText` 写法，不另起一套。

## 范围
| 类型 | 判定 | 显示 | 用的库 |
|---|---|---|---|
| Word | `.docx/.docm/.dotx` + 对应 MIME | 按原排版（分页、表格、图片、页眉页脚） | `docx-preview`（Apache-2.0），图片用 data: URL（`useBase64URL`） |
| Excel | `.xlsx/.xlsm` + 对应 MIME | 表格，多工作表切换；日期按本地格式显示 | `read-excel-file/browser`（MIT） |
| PPT | `.pptx/.pptm` + 对应 MIME | 一页一张，按比例缩放；文字、图片、形状填充、表格；图表显示「图表（下载查看）」占位 | `pptxtojson`（MIT）解析成 JSON，渲染自己写 |
| Apple iWork | `.pages/.numbers/.key` | 显示包里自带的预览图（`preview.jpg` / `QuickLook/Thumbnail.jpg` 等），说明「这是文件自带的预览图」；没有就提示下载 | `jszip`（MIT，直接声明依赖） |
| 压缩包 | `.zip` | 列出文件名、大小、文件夹，不解压内容；最多列 2000 条 | `jszip` |
| Jupyter | `.ipynb` | 按单元格：Markdown 单元用现有 `Markdown`（不自动加载外链图片）、代码单元、输出（文本、`image/png|jpeg` 用 data: 图片；`text/html` 输出只显示其 `text/plain`） | 无（纯逻辑解析） |
| 老格式 | `.doc/.xls/.ppt`、`.odt/.ods/.odp` | 仍不支持，提示「用 Office 另存为 .docx / .xlsx / .pptx 后就能预览」 | — |

## 安全
- 宏一律不执行（这些库只读 XML，不碰 VBA）。
- Word / PPT 渲染进 Shadow DOM 容器（样式不串到 App 里）。App 页面的 CSP 已经不允许内联事件和 `javascript:`，作为兜底。
- PPT 文字是 `pptxtojson` 给的 HTML 字符串：插入前用一个白名单清洗函数处理（`DOMParser` 解析成不活动文档，只留 `p/span/div/br/b/strong/i/em/u/s/sub/sup/ul/ol/li/a` 和 `style`，`a` 只留 http/https 链接）。纯函数，放 `office-preview.ts`，有单测。
- 文档里的链接：容器统一拦截点击，http/https 用新窗口打开（`noopener`），其他协议忽略；绝不在 App 窗口里跳转。
- 远程图片：App CSP 的 `img-src` 本来就不允许外网图片，保持不变。

## 体积和上限
- 四个库都用 `import()` 按需加载，打开对应文件才下载；主包大小不增加（构建后核对）。
- Office / iWork / zip / ipynb 读取上限 30MB（`fetchBlobLimited`），超了显示「文件太大」+ 下载。Excel 表格沿用 `MAX_CSV_ROWS / MAX_CSV_COLS`，表格组件和 CSV 共用一个（从 `CsvView` 抽出来）。
- 解析失败（文件损坏 / 格式不认）：显示「这个文件解析不了」+ 下载，不白屏。

## 文件划分
- 判定：`preview.ts` 新增 `docx / xlsx / pptx / iwork / zip / ipynb`。
- 纯逻辑：新文件 `apps/web/src/office-preview.ts`（清洗、ipynb 解析、zip 条目整理、iWork 预览图路径挑选、幻灯片坐标换算、Excel 单元格格式化）。
- 视图：新文件 `apps/web/src/components/OfficeViews.tsx`（放不下再拆）。单文件不超过 600 行。
- 新依赖写进 `THIRD_PARTY_NOTICES.md`（版本 + 许可证），版本固定写死。

## 测试
- 单测：新判定；清洗函数（`script`、`onerror`、`javascript:` 都被去掉）；ipynb 解析；zip 条目；iWork 路径挑选。
- e2e（`e2e/file-preview.mjs` 扩充）：测试用的 docx / xlsx / pptx / pages / zip / ipynb 在测试运行时用 jszip 现生成，不入库二进制文件；每种都打开看到内容；损坏文件显示解析失败；390 窄屏；Word 里的链接点了不跳走 App。
