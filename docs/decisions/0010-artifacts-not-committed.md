# 0010 截图和证据不入库
- 日期：2026-10-18
- 状态：有效
- 决定：截图、日志、证据只写 `artifacts/`（gitignore），需要给用户看的直接发；不再新建 progress-snapshots/、evidence/、docs/screenshots/ 文件，已有的移出 git 跟踪（本地和历史保留）。
- 原因：仓库被几百张证据图撑大，接手的 AI 也被大量过程记录干扰。
- 影响：.gitignore；`check:static` 的仓库卫生检查。
