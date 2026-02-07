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
  <title>TWMD Web GUI</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: #0b1020; color: #eef2ff; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; }
    .grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
    .card { background: #111933; border: 1px solid #2b3a6b; border-radius: 12px; padding: 16px; }
    .card h2 { margin: 0 0 10px; font-size: 16px; }
    .row { display: grid; gap: 8px; margin-bottom: 10px; }
    .row.two { grid-template-columns: 1fr 1fr; }
    label { font-size: 12px; color: #b6c2ff; }
    input, textarea, button { border-radius: 8px; border: 1px solid #3d4d86; background: #0f1730; color: #eef2ff; }
    input, textarea { padding: 8px; font-size: 13px; }
    textarea { width: 100%; min-height: 110px; resize: vertical; }
    button { cursor: pointer; padding: 8px 12px; font-size: 13px; }
    button.primary { background: #3856ff; border-color: #4f69ff; }
    button.warn { background: #b63838; border-color: #d14e4e; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .log { margin-top: 16px; background: #080d1a; border: 1px solid #2b3a6b; border-radius: 10px; padding: 10px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.35; max-height: 420px; overflow: auto; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .status { font-size: 12px; color: #b6c2ff; margin: 10px 0 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>TWMD Web GUI (M3 最小版)</h1>
    <div class="grid">
      <section class="card">
        <h2>登录 / Cookie</h2>
        <div class="row">
          <label for="cookieText">Cookie 文本（推荐粘贴）</label>
          <textarea id="cookieText" placeholder="粘贴浏览器导出的 cookie 文本"></textarea>
        </div>
        <div class="row">
          <label for="cookieFilePath">或 Cookie 文件路径</label>
          <input id="cookieFilePath" type="text" placeholder="例如 /Users/you/cookies.txt" />
        </div>
        <div class="row">
          <label><input id="looseCookie" type="checkbox" /> 关闭严格 cookie 校验（--loose-cookie）</label>
        </div>
        <div class="actions">
          <button class="primary" id="btnLogin">保存登录</button>
          <button id="btnWhoami">检查登录</button>
          <button id="btnLogout">清理登录</button>
        </div>
      </section>

      <section class="card">
        <h2>下载任务</h2>
        <div class="row">
          <label for="users">用户（逗号/空格/换行分隔）</label>
          <textarea id="users" placeholder="nasa\nSpaceX"></textarea>
        </div>
        <div class="row">
          <label for="outDir">输出目录</label>
          <input id="outDir" type="text" value="./downloads" />
        </div>
        <div class="row two">
          <div>
            <label for="kinds">媒体类型</label>
            <input id="kinds" type="text" value="image,video,gif" />
          </div>
          <div>
            <label for="maxTweets">最大推文数（可空）</label>
            <input id="maxTweets" type="number" min="1" placeholder="50" />
          </div>
        </div>
        <div class="row two">
          <div>
            <label for="concurrency">并发</label>
            <input id="concurrency" type="number" min="1" value="4" />
          </div>
          <div>
            <label for="retry">媒体重试</label>
            <input id="retry" type="number" min="0" value="2" />
          </div>
        </div>
        <div class="row two">
          <div>
            <label for="userRetry">用户重试</label>
            <input id="userRetry" type="number" min="0" value="1" />
          </div>
          <div>
            <label for="userDelayMs">用户间隔(ms)</label>
            <input id="userDelayMs" type="number" min="0" value="0" />
          </div>
        </div>
        <div class="row">
          <label for="requestDelayMs">请求间隔(ms)</label>
          <input id="requestDelayMs" type="number" min="0" value="0" />
        </div>
        <div class="actions">
          <button class="primary" id="btnStart">开始下载</button>
          <button class="warn" id="btnStop">停止任务</button>
        </div>
      </section>
    </div>

    <section class="log">
      <div class="actions" style="margin-bottom:8px">
        <strong>实时日志</strong>
        <button id="btnClear">清空</button>
      </div>
      <pre id="log" class="mono"></pre>
      <p class="status" id="status">状态：准备就绪</p>
    </section>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const logEl = $("log");
    const statusEl = $("status");

    function appendLog(line) {
      logEl.textContent += line + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setStatus(text) {
      statusEl.textContent = "状态：" + text;
    }

    async function post(path, payload = {}) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      return data;
    }

    $("btnLogin").onclick = async () => {
      try {
        setStatus("保存登录中...");
        const result = await post("/api/login", {
          cookieText: $("cookieText").value,
          cookieFilePath: $("cookieFilePath").value,
          looseCookie: $("looseCookie").checked
        });
        appendLog("[login] exit=" + result.exitCode + " " + (result.stdout || result.stderr || ""));
        setStatus(result.exitCode === 0 ? "登录已保存" : "登录失败");
      } catch (error) {
        appendLog("[login] " + error.message);
        setStatus("登录失败");
      }
    };

    $("btnWhoami").onclick = async () => {
      try {
        const result = await post("/api/whoami");
        appendLog("[whoami] exit=" + result.exitCode + " " + (result.stdout || result.stderr || ""));
      } catch (error) {
        appendLog("[whoami] " + error.message);
      }
    };

    $("btnLogout").onclick = async () => {
      try {
        const result = await post("/api/logout");
        appendLog("[logout] exit=" + result.exitCode + " " + (result.stdout || result.stderr || ""));
      } catch (error) {
        appendLog("[logout] " + error.message);
      }
    };

    $("btnStart").onclick = async () => {
      try {
        const payload = {
          users: $("users").value,
          outDir: $("outDir").value,
          kinds: $("kinds").value,
          maxTweets: $("maxTweets").value ? Number($("maxTweets").value) : undefined,
          concurrency: $("concurrency").value ? Number($("concurrency").value) : undefined,
          retry: $("retry").value ? Number($("retry").value) : undefined,
          userRetry: $("userRetry").value ? Number($("userRetry").value) : undefined,
          userDelayMs: $("userDelayMs").value ? Number($("userDelayMs").value) : undefined,
          requestDelayMs: $("requestDelayMs").value ? Number($("requestDelayMs").value) : undefined
        };

        const result = await post("/api/download", payload);
        appendLog("[download] started pid=" + result.pid);
        setStatus("下载进行中");
      } catch (error) {
        appendLog("[download] " + error.message);
        setStatus("下载未启动");
      }
    };

    $("btnStop").onclick = async () => {
      try {
        const result = await post("/api/stop");
        appendLog("[stop] " + result.message);
      } catch (error) {
        appendLog("[stop] " + error.message);
      }
    };

    $("btnClear").onclick = () => {
      logEl.textContent = "";
    };

    const events = new EventSource("/events");
    events.addEventListener("ready", (event) => {
      JSON.parse(event.data);
      setStatus("GUI 已连接");
    });
    events.addEventListener("log", (event) => {
      const data = JSON.parse(event.data);
      if (data.parsed) {
        appendLog(JSON.stringify(data.parsed));
      } else {
        appendLog(data.line);
      }
    });
    events.addEventListener("job", (event) => {
      const data = JSON.parse(event.data);
      appendLog("[job] " + JSON.stringify(data));
      if (data.type === "finished") {
        setStatus(data.exitCode === 0 || data.exitCode === 4 ? "任务结束" : "任务失败");
      }
    });
    events.onerror = () => {
      setStatus("与后端连接中断，等待重连...");
    };
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
