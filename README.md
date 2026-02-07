# tw-media-downloader

Twitter/X 媒体批量下载器项目（TypeScript Monorepo）。

## 工作区结构

- `apps/cli`：可独立运行 CLI（`twmd`）
- `apps/gui`：Tauri + React 桌面端（MVP 占位）
- `packages/core`：抓取与下载核心能力（可复用）
- `packages/shared`：共享类型与模型

## 当前状态（M1.5）

- ✅ 本地会话保存（cookie）
- ✅ 严格 cookie 校验（默认要求 `auth_token` + `ct0`）
- ✅ 用户级抓取编排（按用户名批量）
- ✅ 媒体下载器（并发、重试、跳过已存在）
- ✅ 失败明细报告（user/media 级别）
- ✅ 用户级重试与限速参数
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

默认启用严格校验，cookie 必须包含 `auth_token` 与 `ct0`。如需关闭严格校验：

```bash
node apps/cli/dist/index.js login --cookie-file ./cookies.txt --loose-cookie
```

支持两类 cookie 文件：
- 浏览器导出的 Netscape cookie 文件
- 单行/多行 `name=value` cookie 文本

### 2) 查看登录状态

```bash
node apps/cli/dist/index.js whoami
```

当会话缺少必要 cookie 时，会提示缺失项。

### 3) 下载指定用户媒体

```bash
node apps/cli/dist/index.js download \
  --users user1,user2 \
  --out ./downloads \
  --kinds image,video,gif \
  --max-tweets 200 \
  --concurrency 4 \
  --retry 2 \
  --user-retry 1 \
  --user-delay-ms 1000 \
  --request-delay-ms 200 \
  --json-report ./report.json \
  --failures-report ./failures.json
```

也可使用 `--users-file ./users.txt`（每行一个用户，可带 `@`）。

参数说明：
- `--retry`：单个媒体下载失败后的重试次数（可为 0）
- `--user-retry`：单个用户任务失败后的重试次数（可为 0）
- `--user-delay-ms`：每个用户任务之间的固定延迟
- `--request-delay-ms`：每次媒体请求前的固定延迟
- `--json-report`：输出整体任务报告（含失败明细）
- `--failures-report`：仅输出失败明细

### 4) 清理本地会话

```bash
node apps/cli/dist/index.js logout
```

## 计划文档

详细实施方案见：`IMPLEMENTATION_PLAN.md`。
