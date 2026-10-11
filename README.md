# 胡好好（pi-assistant）

基于 [Pi](https://github.com/earendil-works/pi) 的**本地私人助理**：跑在你自己的 Mac / Windows 电脑上，有自己的工作区“电脑”，能写代码跑代码、处理文件、操作浏览器、连接 Gmail / 日历 / GitHub，后台和定时干活；手机 App 只是遥控器。

> 当前状态：**设计阶段**，仓库只有骨架。完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 特点

- 一步安装：Pi 与 Node 运行时全部内置，不需要另装任何东西
- 沙箱三档自动选择：工作区目录 / 系统沙箱 / Docker（可选）
- 桌面 + 手机共用界面，扫码配对，实时同步
- 有后果的操作（发送、删除、付款、提交表单）一律先审批，手机上也能批
- 后台任务、定时任务、记忆、技能、浏览器接管、应用连接器

## 目录

```
apps/daemon      守护进程：Gateway + Pi Runtime + 调度 + 连接器
apps/web         React Web UI（桌面窗口与手机共用）
apps/desktop     Tauri 2 桌面外壳
apps/mobile      Capacitor 手机外壳
packages/*       共享类型与 Pi 扩展（审批、沙箱、交付、记忆、浏览器、连接器）
sandbox/         Docker 沙箱镜像与 exec-daemon
skills/          内置技能（SKILL.md）
deploy/          docker compose 与打包脚本
docs/            设计文档
```

## 里程碑

1. **Phase 1 核心**：一键安装 + 开机自启、沙箱工作区、桌面/手机共用 UI + 扫码配对 + 实时同步、基于 Pi 的聊天（跑代码、回传文件）、后台任务 + 推送、审批（手机可批）
2. **Phase 2**：记忆、技能、定时任务、安全远程访问
3. **Phase 3**：浏览器自动化与人工接管、Gmail/日历/GitHub 连接器（草稿优先）、多助理、用量、设置

## 开发（规划中）

```bash
# Node 22.19+
npm install --ignore-scripts
cp .env.example .env
npm run dev
# 或：docker compose -f deploy/compose.yaml up --build
```
