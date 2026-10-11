# 胡好好（pi-assistant）

基于 [Pi](https://github.com/earendil-works/pi) 的**本地私人助理**：跑在你自己的 Mac / Windows 电脑上，有自己的工作区“电脑”，能写代码跑代码、处理文件、操作浏览器、连接 Gmail / 日历 / GitHub，后台和定时干活。所有界面是同一个网页应用（PWA），手机扫码即可远程使用，不需要原生 App。

> 当前状态：**设计阶段**，仓库只有骨架。完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 特点

- 一步安装：轻量安装包（Mac .dmg / Windows .exe），内置 Pi、Node 运行时与 cloudflared，开机自启，菜单栏/托盘一点打开
- 出门在外也能用：内置隧道，手机用流量扫码/点链接即可连回电脑，零网络配置
- 沙箱三档自动选择：工作区目录 / 系统沙箱 / Docker（可选）
- 一个响应式 PWA 电脑手机通用，可添加到主屏幕，Web Push 推送，实时同步
- 有后果的操作（发送、删除、付款、提交表单）一律先审批，手机上也能批
- 后台任务、定时任务、记忆、技能、浏览器接管、应用连接器

## 目录

```
apps/web         唯一界面：React 响应式 PWA（电脑与手机共用）
apps/tray        Tauri 2 托盘程序 + 安装包（dmg / exe）
apps/rendezvous  稳定入口 Worker（serverId → 当前隧道地址）
packages/server  本地服务：Gateway + Pi Runtime + 任务 + 调度 + 隧道 + 配对
packages/*       共享类型与 Pi 扩展（审批、沙箱、交付、记忆、浏览器、连接器）
sandbox/         Docker 沙箱镜像与 exec-daemon（可选）
skills/          内置技能（SKILL.md）
scripts/         构建脚本
deploy/          docker compose
.github/         CI 与安装包发布流程
docs/            设计文档
```

## 里程碑

1. **Phase 1 核心**：一键安装 + 开机自启 + 托盘、GitHub Actions 出安装包、沙箱工作区、单一 PWA + 实时同步、**内置隧道远程访问 + 扫码配对**、基于 Pi 的聊天（跑代码、回传文件）、后台任务 + Web Push、审批（手机可批）
2. **Phase 2**：记忆、技能、定时任务、可选稳定地址（命名隧道 / Tailscale）
3. **Phase 3**：浏览器自动化与人工接管、Gmail/日历/GitHub 连接器（草稿优先）、多助理、用量、设置

## 开发（规划中）

```bash
# Node 22.19+
npm install --ignore-scripts
cp .env.example .env
npm run dev
# 或：docker compose -f deploy/compose.yaml up --build
```
