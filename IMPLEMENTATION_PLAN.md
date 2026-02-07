# Twitter 媒体批量下载器（TS）实施方案

## Summary
构建一个两层架构应用：

1. **核心层：可独立运行的 TypeScript CLI + Core Library**
   - 支持按用户名批量抓取 Twitter/X 用户时间线媒体（图片、视频、GIF）
   - 支持本地保存会话（登录态）
   - 支持批量任务、并发下载、基础失败重试、日志与结果汇总
   - 可被 GUI 直接复用（避免双实现）

2. **界面层：Tauri + React GUI**
   - 提供用户输入、登录态管理、任务启动/停止、进度展示、结果导出
   - GUI 仅做编排与展示，抓取/下载逻辑全部调用 Core

已确认约束：
- 本地保存登录态：是
- 不做代理配置
- 第一版不做断点续传与 SQLite 去重
- 数据来源：Cookies/会话抓取
- 下载范围：图片 + 视频 + GIF
- GUI：Tauri + React
- 平台：macOS + Linux + Windows

---

## Architecture（决策完成版）

### Monorepo 结构
- `apps/cli`：CLI 可执行入口
- `apps/gui`：Tauri + React 前端与桌面壳
- `packages/core`：抓取与下载核心库（供 CLI/GUI 共享）
- `packages/shared`：共享类型、错误码、任务状态模型
- `configs/*`：eslint、tsconfig、vitest 统一配置

### Core 分层
- `auth`：登录态加载、校验、持久化
- `scraper`：用户时间线抓取、媒体提取、分页
- `downloader`：下载调度、并发控制、文件命名与写入
- `orchestrator`：任务编排（多用户批处理）
- `reporter`：结构化结果输出（json/csv 可选）
- `telemetry`：日志与进度事件（先本地）

---

## Public APIs / Interfaces / Types（重要变更点）

### `packages/core` 导出 API
- `createSessionStore(options)`
- `loginWithCookies(input)`（首版用 cookie 导入/校验）
- `fetchUserMedia(params)`
- `downloadMediaBatch(params)`
- `runBatchJob(params): AsyncGenerator<JobEvent>`
- `summarizeJobResult(result)`

### 关键类型（`packages/shared`）
- `UserIdentifier`：`{ username: string }`
- `MediaKind`：`'image' | 'video' | 'gif'`
- `MediaItem`：`id, tweetId, username, kind, url, createdAt, filenameHint`
- `BatchJobInput`：
  - `users: string[]`
  - `outputDir: string`
  - `mediaKinds: MediaKind[]`（默认三类全开）
  - `maxTweetsPerUser?: number`
  - `concurrency?: number`
- `JobEvent`：
  - `job_started | user_started | media_found | download_progress | user_finished | job_finished | warning | error`
- `JobResult`：
  - `totalUsers, succeededUsers, failedUsers, totalMedia, downloaded, failed, skipped`

### 会话持久化格式（本地）
- 文件：`~/.tw-media-dl/session.json`（平台兼容路径由库统一解析）
- 内容：cookie jar + 元信息（更新时间、校验状态）
- 首版默认“明文 + 文件权限限制”，后续可升级系统密钥链

---

## CLI 规格（独立可运行）

### 命令设计
- `twmd login --cookie-file <path>`
  - 导入并验证 cookie，写入本地 session store
- `twmd whoami`
  - 校验当前会话是否可用
- `twmd download --users <u1,u2> --out <dir> [--kinds image,video,gif] [--max-tweets N] [--concurrency N] [--json-report <file>]`
- `twmd download --users-file <file> --out <dir> ...`
- `twmd logout`
  - 清理本地 session

### CLI 行为约束
- 参数冲突校验：`--users` 与 `--users-file` 二选一
- 默认并发：`4`
- 默认下载类型：全部媒体
- 默认失败重试：每文件 `2` 次（指数退避）
- 输出目录结构：`<out>/<username>/<tweetId>_<mediaId>.<ext>`
- 已存在同名文件：默认 `skip`（通过内容长度 + 文件存在判断，不做 hash 去重）

---

## GUI 规格（Tauri + React）

### 页面与流程
1. **Session 页面**
   - 导入 cookie 文本/文件
   - 显示会话状态（有效/失效）
2. **Task 页面**
   - 输入用户列表（多行）
   - 选择输出目录
   - 选择媒体类型（默认全选）
   - 可选设置：每用户最大推文数、并发数
   - 启动任务/取消任务
3. **Progress 页面**
   - 总进度、当前用户、下载速率（基础）
   - 失败条目列表（可导出）
4. **Result 页面**
   - 成功/失败汇总
   - 打开输出目录
   - 导出 JSON 报告

### GUI 与 Core 集成
- Tauri command 层仅做参数校验与事件转发
- Core 的 `AsyncGenerator<JobEvent>` 映射为前端事件流
- 所有业务规则（重试、分页、命名）保持在 Core

---

## Error Handling & Edge Cases
- 用户不存在 / 用户保护（私有账号）/ 无媒体：按用户级别失败或跳过并记录
- 会话失效：任务启动前拦截；运行中遇到 401 则全局中止并提示重新登录
- 视频多码率选择：默认最高可用码率
- 限流/挑战页：识别后退避重试；超过阈值给出可操作提示
- 文件系统错误（路径不可写、磁盘满）：明确错误码与建议
- Windows 路径兼容：统一 sanitize 文件名（去除非法字符）

---

## Testing & Acceptance Criteria

### 单元测试（core）
- 媒体提取器：图片/视频/GIF 解析正确
- 文件命名规则：跨平台非法字符处理
- 参数校验：CLI 输入组合合法性
- 重试策略：可重试与不可重试错误分类

### 集成测试（mock 网络）
- 单用户下载成功（含三类媒体）
- 多用户批量下载（部分成功/部分失败）
- 会话失效流程
- 限流重试后成功 / 超限失败

### GUI 端测试
- 表单校验
- 任务状态流转（idle/running/failed/success）
- 事件渲染正确（进度与失败列表）

### 验收标准（v1）
- 给定 10 个公开用户，CLI 能稳定输出成功/失败报告
- GUI 可完成一次端到端任务（导入会话→下载→查看结果）
- 三平台可打包并运行（macOS/Linux/Windows）
- 文档覆盖：快速开始、cookie 导入、常见错误说明

---

## Milestones
1. **M1 Core MVP**
   - session + scraper + downloader + batch orchestrator
2. **M2 CLI 完整化**
   - 命令、参数、报告、错误码、文档
3. **M3 GUI MVP**
   - session/task/progress/result 全流程
4. **M4 稳定性**
   - 限流处理、跨平台路径、打包与回归测试

---

## Assumptions & Defaults
- 默认数据源为网页会话抓取（非官方 API）
- 首版不提供代理、断点续传、数据库去重
- 会话默认落盘到用户目录并限制文件权限
- 并发默认 4，单文件重试 2 次
- 已存在同名文件默认跳过
- 视频默认取最高可用质量
