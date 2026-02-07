# tw-media-downloader

Twitter/X 媒体批量下载器项目（TypeScript Monorepo）。

## 工作区结构

- `apps/cli`：可独立运行 CLI（`twmd`）
- `apps/gui`：Tauri + React 桌面端（MVP 占位）
- `packages/core`：抓取与下载核心能力（可复用）
- `packages/shared`：共享类型与模型

## 当前状态（M1 进行中）

- ✅ 本地会话保存（cookie）
- ✅ 用户级抓取编排（按用户名批量）
- ✅ 媒体下载器（并发、重试、跳过已存在）
- ✅ CLI 命令骨架（`login` / `whoami` / `download` / `logout`）
- 🚧 GUI 仍为占位

## CLI 快速使用

```bash
pnpm install
pnpm --filter @twmd/cli build
node apps/cli/dist/index.js help
```

### 1) 导入 cookie

```bash
node apps/cli/dist/index.js login --cookie-file ./cookies.txt
```

支持两类 cookie 文件：
- 浏览器导出的 Netscape cookie 文件
- 单行/多行 `name=value` cookie 文本

### 2) 查看登录状态

```bash
node apps/cli/dist/index.js whoami
```

### 3) 下载指定用户媒体

```bash
node apps/cli/dist/index.js download \
  --users user1,user2 \
  --out ./downloads \
  --kinds image,video,gif \
  --max-tweets 200 \
  --concurrency 4 \
  --retry 2 \
  --json-report ./report.json
```

也可使用 `--users-file ./users.txt`（每行一个用户，可带 `@`）。

### 4) 清理本地会话

```bash
node apps/cli/dist/index.js logout
```

## 计划文档

详细实施方案见：`IMPLEMENTATION_PLAN.md`。
