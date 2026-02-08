import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StartGuiServerInput {
  host: string;
  port: number;
  cliScriptPath: string;
  autoOpen: boolean;
}

export interface GuiServerHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface DownloadRequest {
  users: string;
  outDir: string;
  engine?: "playwright" | "graphql" | string;
  kinds?: string;
  maxTweets?: number;
  concurrency?: number;
  retry?: number;
  userRetry?: number;
  userDelayMs?: number;
  requestDelayMs?: number;
}

interface LoginRequest {
  cookieText?: string;
  cookieFilePath?: string;
  looseCookie?: boolean;
}

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TWMD GUI</title>
  <style>
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f7f7f8;
      color: #1f2328;
    }

    .wrap {
      max-width: 820px;
      margin: 0 auto;
      padding: 20px 16px 28px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }

    .desc {
      margin: 6px 0 16px;
      font-size: 13px;
      color: #57606a;
    }

    .card {
      background: #fff;
      border: 1px solid #d0d7de;
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 12px;
    }

    .card h2 {
      margin: 0 0 10px;
      font-size: 15px;
      font-weight: 600;
    }

    .row {
      margin-bottom: 10px;
    }

    .grid2 {
      display: grid;
      gap: 10px;
      grid-template-columns: 1fr 1fr;
    }

    label {
      display: block;
      font-size: 12px;
      margin-bottom: 6px;
      color: #57606a;
    }

    input,
    select,
    textarea,
    button {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      font-size: 13px;
      padding: 8px 10px;
      background: #fff;
      color: #1f2328;
    }

    textarea {
      min-height: 92px;
      resize: vertical;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .actions button {
      width: auto;
      min-width: 96px;
      cursor: pointer;
    }

    button.primary {
      background: #1f6feb;
      border-color: #1f6feb;
      color: #fff;
    }

    button.warn {
      background: #cf222e;
      border-color: #cf222e;
      color: #fff;
    }

    details {
      margin-top: 6px;
    }

    details summary {
      cursor: pointer;
      font-size: 13px;
      color: #0969da;
      margin-bottom: 10px;
      user-select: none;
    }

    .log {
      margin-top: 12px;
      border: 1px solid #d0d7de;
      border-radius: 10px;
      background: #fff;
      padding: 10px;
    }

    .log-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 13px;
      color: #57606a;
    }

    .log-head button {
      width: auto;
      padding: 6px 10px;
      font-size: 12px;
    }

    pre {
      margin: 0;
      background: #f6f8fa;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      padding: 8px;
      min-height: 160px;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.4;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .status {
      margin: 8px 0 0;
      font-size: 12px;
      color: #57606a;
    }

    @media (max-width: 760px) {
      .grid2 {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>TWMD Web GUI</h1>
    <p class="desc">先登录 cookie，再填写用户并开始下载。</p>

    <section class="card">
      <h2>1) 登录</h2>
      <div class="row">
        <label for="cookieText">Cookie 文本（推荐）</label>
        <textarea id="cookieText" placeholder="粘贴 cookie 文本"></textarea>
      </div>
      <div class="row">
        <label for="cookieFilePath">或 Cookie 文件路径</label>
        <input id="cookieFilePath" type="text" placeholder="例如 /Users/you/cookies.txt" />
      </div>
      <div class="row">
        <label><input id="looseCookie" type="checkbox" style="width:auto;margin-right:6px;" />关闭严格校验</label>
      </div>
      <div class="actions">
        <button class="primary" id="btnLogin">保存登录</button>
        <button id="btnWhoami">检查登录</button>
        <button id="btnLogout">退出登录</button>
      </div>
    </section>

    <section class="card">
      <h2>2) 下载</h2>
      <div class="row">
        <label for="users">用户（逗号/空格/换行）</label>
        <textarea id="users" placeholder="nasa"></textarea>
      </div>
      <div class="grid2">
        <div class="row">
          <label for="outDir">输出目录</label>
          <input id="outDir" type="text" value="./downloads" />
        </div>
        <div class="row">
          <label for="kinds">媒体类型</label>
          <input id="kinds" type="text" value="image,video,gif" />
        </div>
      </div>

      <details>
        <summary>高级参数（可选）</summary>
        <div class="grid2">
          <div class="row">
            <label for="engine">抓取引擎</label>
            <select id="engine">
              <option value="graphql" selected>graphql（API 抓取）</option>
              <option value="playwright">playwright（仅页面抓取）</option>
            </select>
          </div>
          <div class="row">
            <label for="maxTweets">最大推文数</label>
            <input id="maxTweets" type="number" min="1" placeholder="50" />
          </div>
          <div class="row">
            <label for="concurrency">并发</label>
            <input id="concurrency" type="number" min="1" value="4" />
          </div>
          <div class="row">
            <label for="retry">媒体重试</label>
            <input id="retry" type="number" min="0" value="2" />
          </div>
          <div class="row">
            <label for="userRetry">用户重试</label>
            <input id="userRetry" type="number" min="0" value="1" />
          </div>
          <div class="row">
            <label for="userDelayMs">用户间隔(ms)</label>
            <input id="userDelayMs" type="number" min="0" value="0" />
          </div>
          <div class="row">
            <label for="requestDelayMs">请求间隔(ms)</label>
            <input id="requestDelayMs" type="number" min="0" value="0" />
          </div>
        </div>
      </details>

      <div class="actions" style="margin-top:10px;">
        <button class="primary" id="btnStart">开始下载</button>
        <button class="warn" id="btnStop">停止任务</button>
      </div>
    </section>

    <section class="log">
      <div class="log-head">
        <strong>实时日志</strong>
        <button id="btnClear">清空</button>
      </div>
      <pre id="log"></pre>
      <p class="status" id="status">状态：准备就绪</p>
    </section>
  </div>

  <script>
    (function () {
      function $(id) {
        return document.getElementById(id);
      }

      function init() {
        var logEl = $("log");
        var statusEl = $("status");

        if (!logEl || !statusEl) {
          console.error("[twmd-gui] missing log/status element");
          return;
        }

        function appendLog(line) {
          logEl.textContent += String(line) + "\\n";
          logEl.scrollTop = logEl.scrollHeight;
        }

        function setStatus(text) {
          statusEl.textContent = "状态：" + text;
        }

        async function post(path, payload) {
          var res = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload || {})
          });
          var data = await res.json().catch(function () {
            return {};
          });
          if (!res.ok) {
            throw new Error((data && data.error) || ("HTTP " + res.status));
          }
          return data;
        }

        function must(id) {
          var element = $(id);
          if (!element) {
            throw new Error("页面元素缺失: #" + id);
          }
          return element;
        }

        function toTimeLabel(ts) {
          if (!ts) {
            return "";
          }

          var date = new Date(ts);
          if (Number.isNaN(date.getTime())) {
            return "";
          }

          return date.toLocaleTimeString("zh-CN", { hour12: false });
        }

        function safeParseJson(text) {
          if (!text) {
            return null;
          }

          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        }

        function withTimePrefix(text, ts) {
          var t = toTimeLabel(ts);
          if (!t) {
            return text;
          }

          return "[" + t + "] " + text;
        }

        function formatParsedLog(parsed, fallbackLine) {
          if (!parsed || typeof parsed !== "object") {
            return fallbackLine || "";
          }

          var message = parsed.message || "";
          var event = parsed.event;

          if (message === "job_event" && event) {
            if (event.type === "job_started") {
              return withTimePrefix("任务开始", event.timestamp || parsed.ts);
            }

            if (event.type === "user_started") {
              return withTimePrefix("开始处理 @" + (event.username || "unknown"), event.timestamp || parsed.ts);
            }

            if (event.type === "media_found") {
              return withTimePrefix("@" + (event.username || "unknown") + " " + event.message, event.timestamp || parsed.ts);
            }

            if (event.type === "download_progress" && event.progress) {
              return withTimePrefix(
                "@" +
                  (event.username || "unknown") +
                  " 下载进度：下载 " +
                  event.progress.downloaded +
                  "/" +
                  event.progress.total +
                  "，失败 " +
                  event.progress.failed +
                  "，跳过 " +
                  event.progress.skipped,
                event.timestamp || parsed.ts
              );
            }

            if (event.type === "user_finished") {
              return withTimePrefix("@" + (event.username || "unknown") + " 处理完成", event.timestamp || parsed.ts);
            }

            if (event.type === "job_finished" && event.progress) {
              return withTimePrefix(
                "任务完成：总 " +
                  event.progress.total +
                  "，下载 " +
                  event.progress.downloaded +
                  "，失败 " +
                  event.progress.failed +
                  "，跳过 " +
                  event.progress.skipped,
                event.timestamp || parsed.ts
              );
            }

            if (event.type === "warning") {
              return withTimePrefix("警告：" + event.message, event.timestamp || parsed.ts);
            }

            if (event.type === "error") {
              return withTimePrefix("错误：" + event.message, event.timestamp || parsed.ts);
            }

            return withTimePrefix(event.message || "任务事件", event.timestamp || parsed.ts);
          }

          if (message === "job_summary" && parsed.report && parsed.report.summary) {
            var s = parsed.report.summary;
            return withTimePrefix(
              "汇总：用户成功 " +
                s.succeededUsers +
                "/" +
                s.totalUsers +
                "，媒体下载 " +
                s.downloaded +
                "/" +
                s.totalMedia +
                "，失败 " +
                s.failed +
                "，跳过 " +
                s.skipped,
              parsed.ts
            );
          }

          if (message === "job_failures") {
            var count = Array.isArray(parsed.failures) ? parsed.failures.length : 0;
            return withTimePrefix("失败明细：" + count + " 条", parsed.ts);
          }

          if (message === "Download job started") {
            return withTimePrefix(
              "已开始下载：用户 " + (parsed.users || "?") + " 个，目录 " + (parsed.outputDir || ""),
              parsed.ts
            );
          }

          if (message === "Login session saved") {
            return withTimePrefix("登录已保存（cookie " + (parsed.cookieCount || 0) + "）", parsed.ts);
          }

          if (message === "Logged in") {
            return withTimePrefix("当前已登录（cookie " + (parsed.cookieCount || 0) + "）", parsed.ts);
          }

          if (message === "Session cleared") {
            return withTimePrefix("本地会话已清理", parsed.ts);
          }

          if (typeof message === "string" && message.indexOf("Error [") === 0) {
            return withTimePrefix("错误：" + (parsed.detail || message), parsed.ts);
          }

          if (message) {
            return withTimePrefix(String(message), parsed.ts);
          }

          return fallbackLine || "";
        }

        function appendCommandResult(prefix, result) {
          var ok = result.exitCode === 0;
          appendLog("[" + prefix + "] " + (ok ? "成功" : "失败") + " (exit=" + result.exitCode + ")");

          var outputLines = [];
          if (result.stdout) {
            outputLines = outputLines.concat(String(result.stdout).split(/\\r?\\n/));
          }
          if (result.stderr) {
            outputLines = outputLines.concat(String(result.stderr).split(/\\r?\\n/));
          }

          for (var i = 0; i < outputLines.length; i += 1) {
            var rawLine = outputLines[i].trim();
            if (!rawLine) {
              continue;
            }

            var parsed = safeParseJson(rawLine);
            appendLog("  " + formatParsedLog(parsed, rawLine));
          }
        }

        try {
          var btnLogin = must("btnLogin");
          var btnWhoami = must("btnWhoami");
          var btnLogout = must("btnLogout");
          var btnStart = must("btnStart");
          var btnStop = must("btnStop");
          var btnClear = must("btnClear");

          btnLogin.addEventListener("click", async function () {
            try {
              setStatus("保存登录中...");
              var result = await post("/api/login", {
                cookieText: must("cookieText").value,
                cookieFilePath: must("cookieFilePath").value,
                looseCookie: must("looseCookie").checked
              });
              appendCommandResult("login", result);
              setStatus(result.exitCode === 0 ? "登录已保存" : "登录失败");
            } catch (error) {
              appendLog("[login] " + (error && error.message ? error.message : String(error)));
              setStatus("登录失败");
            }
          });

          btnWhoami.addEventListener("click", async function () {
            try {
              var result = await post("/api/whoami", {});
              appendCommandResult("whoami", result);
            } catch (error) {
              appendLog("[whoami] " + (error && error.message ? error.message : String(error)));
            }
          });

          btnLogout.addEventListener("click", async function () {
            try {
              var result = await post("/api/logout", {});
              appendCommandResult("logout", result);
            } catch (error) {
              appendLog("[logout] " + (error && error.message ? error.message : String(error)));
            }
          });

          btnStart.addEventListener("click", async function () {
            try {
              var payload = {
                users: must("users").value,
                outDir: must("outDir").value,
                engine: must("engine").value,
                kinds: must("kinds").value,
                maxTweets: must("maxTweets").value ? Number(must("maxTweets").value) : undefined,
                concurrency: must("concurrency").value ? Number(must("concurrency").value) : undefined,
                retry: must("retry").value ? Number(must("retry").value) : undefined,
                userRetry: must("userRetry").value ? Number(must("userRetry").value) : undefined,
                userDelayMs: must("userDelayMs").value ? Number(must("userDelayMs").value) : undefined,
                requestDelayMs: must("requestDelayMs").value
                  ? Number(must("requestDelayMs").value)
                  : undefined
              };

              var result = await post("/api/download", payload);
              appendLog("[download] started pid=" + result.pid);
              setStatus("下载进行中");
            } catch (error) {
              appendLog("[download] " + (error && error.message ? error.message : String(error)));
              setStatus("下载未启动");
            }
          });

          btnStop.addEventListener("click", async function () {
            try {
              var result = await post("/api/stop", {});
              appendLog("[stop] " + result.message);
            } catch (error) {
              appendLog("[stop] " + (error && error.message ? error.message : String(error)));
            }
          });

          btnClear.addEventListener("click", function () {
            logEl.textContent = "";
          });

          if (typeof EventSource !== "undefined") {
            var events = new EventSource("/events");
            events.addEventListener("ready", function () {
              setStatus("GUI 已连接");
            });
            events.addEventListener("log", function (event) {
              var data = JSON.parse(event.data);
              if (data.parsed) {
                appendLog(formatParsedLog(data.parsed, data.line));
              } else {
                appendLog(data.line);
              }
            });
            events.addEventListener("job", function (event) {
              var data = JSON.parse(event.data);

              if (data.type === "started") {
                appendLog("任务已启动（用户 " + (data.users || "?") + " 个，目录 " + (data.outDir || "") + "）");
              } else if (data.type === "finished") {
                appendLog("任务已结束（exit=" + data.exitCode + (data.signal ? ", signal=" + data.signal : "") + "）");
              } else if (data.type === "error") {
                appendLog("任务异常：" + (data.message || "未知错误"));
              } else {
                appendLog("[job] " + JSON.stringify(data));
              }

              if (data.type === "finished") {
                setStatus(data.exitCode === 0 || data.exitCode === 4 ? "任务结束" : "任务失败");
              }
            });
            events.onerror = function () {
              setStatus("与后端连接中断，等待重连...");
            };
          } else {
            appendLog("[warn] 浏览器不支持 EventSource，实时日志不可用");
          }

          setStatus("GUI 已初始化");
        } catch (error) {
          appendLog("[fatal] " + (error && error.message ? error.message : String(error)));
          setStatus("初始化失败");
          console.error(error);
        }
      }

      window.addEventListener("error", function (event) {
        var logEl = document.getElementById("log");
        if (logEl) {
          logEl.textContent += "[window-error] " + event.message + "\\n";
        }
      });

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
      } else {
        init();
      }
    })();
  </script>
</body>
</html>`;

function openInBrowser(url: string): void {
  const platform = process.platform;

  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as T;
}

async function runCliOnce(
  cliScriptPath: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliScriptPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function sanitizeUsers(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim().replace(/^@/, ""))
    .filter(Boolean);
}

function parsePositiveInt(input: unknown, key: string): string[] {
  if (input === undefined || input === null || input === "") {
    return [];
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return [key, String(value)];
}

function parseNonNegativeInt(input: unknown, key: string): string[] {
  if (input === undefined || input === null || input === "") {
    return [];
  }

  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return [key, String(value)];
}

export async function startGuiServer(input: StartGuiServerInput): Promise<GuiServerHandle> {
  const sseClients = new Set<ServerResponse>();
  let runningJob: ChildProcessWithoutNullStreams | null = null;

  const broadcast = (event: string, payload: Record<string, unknown>): void => {
    const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      client.write(line);
    }
  };

  const server: Server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", `http://${input.host}:${input.port}`);

    try {
      if (method === "GET" && requestUrl.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write("event: ready\ndata: {}\n\n");
        sseClients.add(res);
        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === "GET" && requestUrl.pathname === "/api/status") {
        sendJson(res, 200, {
          running: Boolean(runningJob)
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/login") {
        const payload = await readJsonBody<LoginRequest>(req);

        const looseCookie = Boolean(payload.looseCookie);
        let cookieFilePath = payload.cookieFilePath?.trim();
        let tempDirPath: string | null = null;

        if (!cookieFilePath) {
          const cookieText = payload.cookieText?.trim();
          if (!cookieText) {
            sendJson(res, 400, {
              error: "cookieText 或 cookieFilePath 至少提供一个。"
            });
            return;
          }

          tempDirPath = await mkdtemp(join(tmpdir(), "twmd-gui-"));
          cookieFilePath = join(tempDirPath, "cookies.txt");
          await writeFile(cookieFilePath, cookieText, "utf8");
        }

        const args = ["login", "--cookie-file", cookieFilePath, "--output-format", "json", "--no-color"];
        if (looseCookie) {
          args.push("--loose-cookie");
        }

        const result = await runCliOnce(input.cliScriptPath, args);
        if (tempDirPath) {
          await rm(tempDirPath, { recursive: true, force: true });
        }

        sendJson(res, 200, {
          ...result,
          ok: result.exitCode === 0
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/whoami") {
        const result = await runCliOnce(input.cliScriptPath, [
          "whoami",
          "--output-format",
          "json",
          "--no-color"
        ]);

        sendJson(res, 200, {
          ...result,
          ok: result.exitCode === 0
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/logout") {
        const result = await runCliOnce(input.cliScriptPath, [
          "logout",
          "--output-format",
          "json",
          "--no-color"
        ]);

        sendJson(res, 200, {
          ...result,
          ok: result.exitCode === 0
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/download") {
        if (runningJob) {
          sendJson(res, 409, {
            error: "已有下载任务在运行，请先停止或等待完成。"
          });
          return;
        }

        const payload = await readJsonBody<DownloadRequest>(req);
        const users = sanitizeUsers(payload.users ?? "");
        if (users.length === 0) {
          sendJson(res, 400, {
            error: "users 不能为空。"
          });
          return;
        }

        const outDir = payload.outDir?.trim();
        if (!outDir) {
          sendJson(res, 400, {
            error: "outDir 不能为空。"
          });
          return;
        }

        const args = [
          "download",
          "--users",
          users.join(","),
          "--out",
          outDir,
          "--output-format",
          "json",
          "--no-color"
        ];

        const engine = payload.engine?.trim();
        if (engine) {
          args.push("--engine", engine);
        }

        const kinds = payload.kinds?.trim();
        if (kinds) {
          args.push("--kinds", kinds);
        }

        args.push(...parsePositiveInt(payload.maxTweets, "--max-tweets"));
        args.push(...parsePositiveInt(payload.concurrency, "--concurrency"));
        args.push(...parseNonNegativeInt(payload.retry, "--retry"));
        args.push(...parseNonNegativeInt(payload.userRetry, "--user-retry"));
        args.push(...parseNonNegativeInt(payload.userDelayMs, "--user-delay-ms"));
        args.push(...parseNonNegativeInt(payload.requestDelayMs, "--request-delay-ms"));

        const job = spawn(process.execPath, [input.cliScriptPath, ...args], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            FORCE_COLOR: "0"
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
        runningJob = job;

        let stdoutBuffer = "";
        let stderrBuffer = "";

        const flushLines = (source: "stdout" | "stderr", chunkText: string): void => {
          const next = source === "stdout" ? stdoutBuffer + chunkText : stderrBuffer + chunkText;
          const lines = next.split(/\r?\n/);
          const remain = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            let parsed: unknown = null;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              parsed = null;
            }

            broadcast("log", {
              stream: source,
              line: trimmed,
              parsed
            });
          }

          if (source === "stdout") {
            stdoutBuffer = remain;
          } else {
            stderrBuffer = remain;
          }
        };

        broadcast("job", {
          type: "started",
          users: users.length,
          outDir
        });

        job.stdout.on("data", (chunk) => {
          flushLines("stdout", chunk.toString());
        });

        job.stderr.on("data", (chunk) => {
          flushLines("stderr", chunk.toString());
        });

        job.on("close", (exitCode, signal) => {
          if (stdoutBuffer.trim()) {
            broadcast("log", {
              stream: "stdout",
              line: stdoutBuffer.trim(),
              parsed: null
            });
          }

          if (stderrBuffer.trim()) {
            broadcast("log", {
              stream: "stderr",
              line: stderrBuffer.trim(),
              parsed: null
            });
          }

          broadcast("job", {
            type: "finished",
            exitCode,
            signal
          });
          runningJob = null;
          stdoutBuffer = "";
          stderrBuffer = "";
        });

        job.on("error", (error) => {
          broadcast("job", {
            type: "error",
            message: error.message
          });
          runningJob = null;
          stdoutBuffer = "";
          stderrBuffer = "";
        });

        sendJson(res, 200, {
          ok: true,
          pid: job.pid
        });
        return;
      }

      if (method === "POST" && requestUrl.pathname === "/api/stop") {
        if (!runningJob) {
          sendJson(res, 200, {
            ok: true,
            message: "没有正在运行的任务。"
          });
          return;
        }

        runningJob.kill("SIGINT");
        sendJson(res, 200, {
          ok: true,
          message: "已发送停止信号。"
        });
        return;
      }

      sendJson(res, 404, {
        error: "Not found"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, {
        error: message
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine GUI server address.");
  }

  const handle: GuiServerHandle = {
    host: input.host,
    port: address.port,
    url: `http://${input.host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (runningJob) {
          runningJob.kill("SIGINT");
        }
        for (const client of sseClients) {
          client.end();
        }
        sseClients.clear();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };

  if (input.autoOpen) {
    openInBrowser(handle.url);
  }

  return handle;
}
