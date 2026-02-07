# tw-media-downloader

Twitter/X 媒体批量下载器项目（TypeScript Monorepo）。

## 工作区结构

- `apps/cli`：可独立运行 CLI（`twmd`）
- `apps/gui`：Tauri + React 桌面端（MVP 占位）
- `packages/core`：抓取与下载核心能力（可复用）
- `packages/shared`：共享类型与模型

## 当前状态（M2.2 Playwright 引擎）

- ✅ 本地会话保存（cookie）
- ✅ 严格 cookie 校验（默认要求 `auth_token` + `ct0`）
- ✅ 用户级抓取编排（按用户名批量）
- ✅ 媒体下载器（并发、重试、跳过已存在）
- ✅ 失败明细报告（user/media 级别）
- ✅ 用户级重试与限速参数
- ✅ JSON/CSV 报告输出
- ✅ 错误码与标准退出码
- ✅ `--quiet` / `--no-color` / `--output-format json`
- ✅ `--engine agent|playwright`（新增）
- 🚧 GUI 仍为占位

## CLI 快速使用

```bash
pnpm install
pnpm build
```

### Playwright 引擎准备（M2.2）

首次使用 `--engine playwright` 前，安装浏览器：

```bash
npx playwright install chromium
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

当会话不完整时会返回认证错误退出码。

### 3) 下载指定用户媒体

#### `agent` 引擎（默认）

```bash
node apps/cli/dist/index.js download \
  --users user1,user2 \
  --out ./downloads \
  --engine agent \
  --kinds image,video,gif \
  --max-tweets 200
```

#### `playwright` 引擎（推荐用于公开账号兜底）

```bash
node apps/cli/dist/index.js download \
  --users nasa \
  --out ./downloads \
  --engine playwright \
  --kinds image,video,gif \
  --max-tweets 50 \
  --concurrency 2 \
  --retry 1 \
  --user-retry 0 \
  --json-report ./report.json \
  --csv-report ./report.csv \
  --failures-report ./failures.json
```

也可使用 `--users-file ./users.txt`（每行一个用户，可带 `@`）。

参数说明：
- `--engine`：抓取引擎（`agent` / `playwright`）
- `--retry`：单个媒体下载失败后的重试次数（可为 0）
- `--user-retry`：单个用户任务失败后的重试次数（可为 0）
- `--user-delay-ms`：每个用户任务之间的固定延迟
- `--request-delay-ms`：每次媒体请求前的固定延迟
- `--json-report`：输出结构化 JSON 报告（summary + failures）
- `--csv-report`：输出扁平 CSV 报告（summary 行 + failure 行）
- `--failures-report`：仅输出失败明细 JSON

### 4) 全局输出参数（M2.1）

- `--quiet`：仅保留必要输出（仍会输出错误）
- `--no-color`：关闭彩色文本输出
- `--output-format text|json`：控制标准输出格式
  - `text`：适合人读（默认）
  - `json`：每行一个 JSON 日志对象，适合脚本/GUI 管道消费

示例：

```bash
node apps/cli/dist/index.js download --users nasa --out ./downloads --engine playwright --output-format json
```

### 5) 清理本地会话

```bash
node apps/cli/dist/index.js logout
```

## 退出码

- `0`：成功
- `2`：参数/用法错误（`TWMD_E_USAGE`）
- `3`：认证/会话错误（`TWMD_E_AUTH`）
- `4`：部分成功（任务完成但有失败项）
- `5`：内部/运行时错误（`TWMD_E_INTERNAL`）

## 计划文档

详细实施方案见：`IMPLEMENTATION_PLAN.md`。
