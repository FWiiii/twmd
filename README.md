# tw-media-downloader

Twitter/X 媒体批量下载器项目骨架（TypeScript Monorepo）。

## 工作区结构

- `apps/cli`：可独立运行 CLI（`twmd`）
- `apps/gui`：Tauri + React 桌面端
- `packages/core`：抓取与下载核心能力（可复用）
- `packages/shared`：共享类型与模型

## 当前状态

已完成首版工程初始化：

- Monorepo 基础配置
- CLI/Core/Shared 最小可编译骨架
- GUI（Tauri + React）目录与占位文件

后续将按 `IMPLEMENTATION_PLAN.md` 分里程碑实现完整功能。
