状态：已实现(e2e9b67d)

# 单聊与群聊 2GB 附件

按用户实施要求，前后端共用 shared 的 2GiB 单文件上限与 32MiB 分块大小，界面沿用 2GB 表述。固定地址经过 Cloudflare 时，每个上传请求都小于 100MB，不再发送整份 multipart 文件。

## 协议与存储

两个入口 `/api/agents/:id/upload`、`/api/rooms/:rid/upload` 共用 `routes/uploads.ts` 和 `uploads.ts`：

- POST JSON `{name,size}` 建立会话，返回 `{uploadId}`。
- PUT `/:uploadId?offset=N&index=N` 原始字节流，严格顺序追加，单请求最多 32MiB；响应确认 `{offset}`，累计等于声明大小后返回 `{offset,file}`。
- DELETE `/:uploadId` 取消，立即停止正在接收的流并清理临时文件；前端失败、移除、组件卸载均尝试取消。

临时文件 `.pia-upload-up_*.part` 位于相应 uploads/ 或群文件目录，完成前不登记。流式写盘使用 Node pipeline 的背压和中止机制；超过声明或总上限、分块超限、偏移/序号错、流失败时删除临时文件并返回中文错误。进程内会话不做续传；重启后由 housekeeping 每次扫描清理超过一天的专有临时文件（启动约 30 秒、之后每 6 小时）。清理只匹配模块专用命名，正式文件同此前缀时会改名，避免误删。

`files.ts` 的 finishUpload 为 Buffer 入站和分块完成共用安全命名、重名 `-1` 和登记；渠道原有 saveUpload / saveRoomUpload 调用继续使用。单聊保留工作区文件和快照，群上传保留一份；内存不积攒整份文件。原助理交付文件的 200MB 上限不在本次用户上传范围。

## 界面与模型输入

附件托盘按服务端已确认字节显示整数百分比；保留原有错误提示样式。前端 uploadChunks 允许测试传入更小分块参数，无产品设置。图片大于 30MiB 时，直接看图和转交识图两个入口均不读取、转换图片，只给文件路径与大小；文档仍保持 50MiB 提取上限。

## 验证范围

单测涵盖单聊/群聊多块精确字节、Buffer 调用、同名与安全名、声明与实际分块超限、顺序错、流中断、正在接收时取消、一天过期清理、零字节和图片保护。upload-chunks e2e 使用临时数据、Mock 和真实 33MiB 文件，验证普通文件/图片在两种对话中的两块上传、96% 进度、下载逐字节一致、消息附件登记、失败与取消。既有详情截图和图片查看器测试共用新上传 fixture。

真实 2GiB 整文件、物理手机及实际 Cloudflare 隧道未验证。
