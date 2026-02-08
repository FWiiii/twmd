# tw-media-downloader

Twitter/X 媒体批量下载器项目（TypeScript Monorepo）。

## 工作区结构

- `apps/cli`：可独立运行 CLI（`twmd`）
- `apps/gui`：Tauri + React 桌面端（MVP 占位）
- `packages/core`：抓取与下载核心能力（可复用）
- `packages/shared`：共享类型与模型

## 当前状态（M2.3 GraphQL + Playwright）

- ✅ 本地会话保存（cookie）
- ✅ 严格 cookie 校验（默认要求 `auth_token` + `ct0`）
- ✅ 用户级抓取编排（按用户名批量）
- ✅ 双引擎抓取（`graphql` / `playwright`）
- ✅ 媒体下载器（并发、重试、跳过已存在）
- ✅ 失败明细报告（user/media 级别）
- ✅ 用户级重试与限速参数
- ✅ JSON/CSV 报告输出
- ✅ 错误码与标准退出码
- ✅ `--quiet` / `--no-color` / `--output-format json`
- 🚧 GUI 仍为占位

## CLI 快速使用

```bash
pnpm install
pnpm build
```

也支持“命令参数”形式（与子命令等价）：

```bash
twmd --gui
twmd --download --users nasa --out ./downloads
twmd --login --cookie-file ./cookies.txt
twmd --login-interactive
twmd --whoami
twmd --logout
```

## Web GUI（M3 最小版）

通过 CLI 启动本地 Web GUI（默认自动打开浏览器）：

```bash
node apps/cli/dist/index.js gui
```

安装为全局命令后也可直接用：

```bash
xd gui
```

可选参数：
- `--host`：监听地址（默认 `127.0.0.1`）
- `--port`：监听端口（默认 `4310`）
- `--no-open`：仅启动服务，不自动打开浏览器

示例：

```bash
node apps/cli/dist/index.js gui --host 127.0.0.1 --port 4310
```

GUI 页面支持：
- 粘贴 Cookie 文本或填写 Cookie 文件路径并保存登录
- 配置 users/outDir/engine/token/kinds/并发/重试参数
- 启动与停止下载任务
- 实时查看关键进度日志

### Playwright 运行准备（M2.3 回退/指定时）

首次使用前，安装浏览器：

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

### 2.5) 交互式登录（自动获取 Cookie）

无需手动粘贴 cookie，命令会打开浏览器（Playwright），你完成 X/Twitter 登录后自动保存会话：

```bash
node apps/cli/dist/index.js login-interactive
```

可选参数：
- `--timeout-ms <ms>`：等待登录超时（默认 `180000`）
- `--loose-cookie`：关闭严格 cookie 校验

实现细节：
- 优先调用本机 Chrome（持久化 profile），profile 默认在 `~/.tw-media-downloader/chrome-profile`
- 若本机 Chrome 不可用，会自动回退到 Playwright Chromium

### 3) 下载指定用户媒体

可选抓取引擎：
- `--engine graphql`：默认，走 GraphQL API 抓取（含 v1.1 fallback）
- `--engine playwright`：仅走页面抓取

可选环境变量：
- `TWMD_WEB_BEARER_TOKEN`：覆盖内置 web bearer（当 X 侧策略变更导致 GraphQL 403 时可用于兼容）

#### graphql（默认）

```bash
node apps/cli/dist/index.js download \
  --users nasa \
  --out ./downloads \
  --engine graphql \
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
- 默认仅下载用户本人原创媒体（排除转推/转发内容）
- graphql 引擎通过时间线接口 `exclude=retweets,replies` 过滤非原创内容
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
node apps/cli/dist/index.js download --users nasa --out ./downloads --output-format json
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

## 发布为可安装 CLI

按依赖顺序发布三个包：

```bash
pnpm -r build
pnpm --filter @huangjz11/shared publish --access public
pnpm --filter @huangjz11/core publish --access public
pnpm --filter @huangjz11/cli publish --access public
```

用户全局安装后可直接执行：

```bash
npm i -g @huangjz11/cli
twmd --gui
```

## 计划文档

详细实施方案见：`IMPLEMENTATION_PLAN.md`。
