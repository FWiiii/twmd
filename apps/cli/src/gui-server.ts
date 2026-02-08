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

interface InteractiveLoginRequest {
  looseCookie?: boolean;
  timeoutMs?: number;
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
  <div id="root"></div>

  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script>
    (function () {
      var ReactRef = window.React;
      var ReactDOMRef = window.ReactDOM;

      if (!ReactRef || !ReactDOMRef) {
        document.body.innerHTML =
          '<div class="wrap"><section class="card"><h2>GUI 加载失败</h2><p class="status">无法加载 React 运行时，请检查网络后刷新页面。</p></section></div>';
        return;
      }

      var h = ReactRef.createElement;
      var useEffect = ReactRef.useEffect;
      var useRef = ReactRef.useRef;
      var useState = ReactRef.useState;

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

        if (message === "Interactive login started") {
          return withTimePrefix("已打开浏览器，请完成 X/Twitter 登录", parsed.ts);
        }

        if (message === "Interactive login session saved") {
          return withTimePrefix("交互式登录已保存（cookie " + (parsed.cookieCount || 0) + "）", parsed.ts);
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

      function toOptionalNumber(value) {
        if (value === undefined || value === null || value === "") {
          return undefined;
        }

        var parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return undefined;
        }

        return parsed;
      }

      function App() {
        var _useState = useState(""),
          cookieText = _useState[0],
          setCookieText = _useState[1];
        var _useState2 = useState(""),
          cookieFilePath = _useState2[0],
          setCookieFilePath = _useState2[1];
        var _useState3 = useState(false),
          looseCookie = _useState3[0],
          setLooseCookie = _useState3[1];
        var _useState4 = useState(""),
          users = _useState4[0],
          setUsers = _useState4[1];
        var _useState5 = useState("./downloads"),
          outDir = _useState5[0],
          setOutDir = _useState5[1];
        var _useState6 = useState("image,video,gif"),
          kinds = _useState6[0],
          setKinds = _useState6[1];
        var _useState7 = useState("graphql"),
          engine = _useState7[0],
          setEngine = _useState7[1];
        var _useState8 = useState(""),
          maxTweets = _useState8[0],
          setMaxTweets = _useState8[1];
        var _useState9 = useState("4"),
          concurrency = _useState9[0],
          setConcurrency = _useState9[1];
        var _useState10 = useState("2"),
          retry = _useState10[0],
          setRetry = _useState10[1];
        var _useState11 = useState("1"),
          userRetry = _useState11[0],
          setUserRetry = _useState11[1];
        var _useState12 = useState("0"),
          userDelayMs = _useState12[0],
          setUserDelayMs = _useState12[1];
        var _useState13 = useState("0"),
          requestDelayMs = _useState13[0],
          setRequestDelayMs = _useState13[1];
        var _useState14 = useState(""),
          logText = _useState14[0],
          setLogText = _useState14[1];
        var _useState15 = useState("准备就绪"),
          status = _useState15[0],
          setStatus = _useState15[1];

        var logRef = useRef(null);
        var appendLogRef = useRef(function () {
        });

        appendLogRef.current = function (line) {
          setLogText(function (prev) {
            return prev + String(line) + "\\n";
          });
        };

        function appendCommandResult(prefix, result) {
          var ok = result.exitCode === 0;
          appendLogRef.current("[" + prefix + "] " + (ok ? "成功" : "失败") + " (exit=" + result.exitCode + ")");

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
            appendLogRef.current("  " + formatParsedLog(parsed, rawLine));
          }
        }

        useEffect(function () {
          if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
          }
        }, [logText]);

        useEffect(function () {
          function onWindowError(event) {
            appendLogRef.current("[window-error] " + event.message);
          }

          window.addEventListener("error", onWindowError);
          return function () {
            window.removeEventListener("error", onWindowError);
          };
        }, []);

        useEffect(function () {
          var events = null;

          try {
            if (typeof EventSource !== "undefined") {
              events = new EventSource("/events");
              events.addEventListener("ready", function () {
                setStatus("GUI 已连接");
              });
              events.addEventListener("log", function (event) {
                var data = safeParseJson(event.data) || {};
                if (data.parsed) {
                  appendLogRef.current(formatParsedLog(data.parsed, data.line));
                  return;
                }

                if (typeof data.line === "string") {
                  appendLogRef.current(data.line);
                }
              });
              events.addEventListener("job", function (event) {
                var data = safeParseJson(event.data) || {};

                if (data.type === "started") {
                  appendLogRef.current("任务已启动（用户 " + (data.users || "?") + " 个，目录 " + (data.outDir || "") + "）");
                } else if (data.type === "finished") {
                  appendLogRef.current("任务已结束（exit=" + data.exitCode + (data.signal ? ", signal=" + data.signal : "") + "）");
                } else if (data.type === "error") {
                  appendLogRef.current("任务异常：" + (data.message || "未知错误"));
                } else {
                  appendLogRef.current("[job] " + JSON.stringify(data));
                }

                if (data.type === "finished") {
                  setStatus(data.exitCode === 0 || data.exitCode === 4 ? "任务结束" : "任务失败");
                }
              });
              events.onerror = function () {
                setStatus("与后端连接中断，等待重连...");
              };
            } else {
              appendLogRef.current("[warn] 浏览器不支持 EventSource，实时日志不可用");
            }

            setStatus("GUI 已初始化");
          } catch (error) {
            appendLogRef.current("[fatal] " + (error && error.message ? error.message : String(error)));
            setStatus("初始化失败");
            console.error(error);
          }

          return function () {
            if (events) {
              events.close();
            }
          };
        }, []);

        async function handleLogin() {
          try {
            setStatus("保存登录中...");
            var result = await post("/api/login", {
              cookieText: cookieText,
              cookieFilePath: cookieFilePath,
              looseCookie: looseCookie
            });
            appendCommandResult("login", result);
            setStatus(result.exitCode === 0 ? "登录已保存" : "登录失败");
          } catch (error) {
            appendLogRef.current("[login] " + (error && error.message ? error.message : String(error)));
            setStatus("登录失败");
          }
        }

        async function handleWhoami() {
          try {
            var result = await post("/api/whoami", {});
            appendCommandResult("whoami", result);
          } catch (error) {
            appendLogRef.current("[whoami] " + (error && error.message ? error.message : String(error)));
          }
        }

        async function handleInteractiveLogin() {
          try {
            setStatus("打开浏览器登录中...");
            var result = await post("/api/login-interactive", {
              looseCookie: looseCookie,
              timeoutMs: 180000
            });
            appendCommandResult("login-interactive", result);
            setStatus(result.exitCode === 0 ? "交互式登录成功" : "交互式登录失败");
          } catch (error) {
            appendLogRef.current(
              "[login-interactive] " + (error && error.message ? error.message : String(error))
            );
            setStatus("交互式登录失败");
          }
        }

        async function handleLogout() {
          try {
            var result = await post("/api/logout", {});
            appendCommandResult("logout", result);
          } catch (error) {
            appendLogRef.current("[logout] " + (error && error.message ? error.message : String(error)));
          }
        }

        async function handleStart() {
          try {
            var payload = {
              users: users,
              outDir: outDir,
              engine: engine,
              kinds: kinds,
              maxTweets: toOptionalNumber(maxTweets),
              concurrency: toOptionalNumber(concurrency),
              retry: toOptionalNumber(retry),
              userRetry: toOptionalNumber(userRetry),
              userDelayMs: toOptionalNumber(userDelayMs),
              requestDelayMs: toOptionalNumber(requestDelayMs)
            };

            var result = await post("/api/download", payload);
            appendLogRef.current("[download] started pid=" + result.pid);
            setStatus("下载进行中");
          } catch (error) {
            appendLogRef.current("[download] " + (error && error.message ? error.message : String(error)));
            setStatus("下载未启动");
          }
        }

        async function handleStop() {
          try {
            var result = await post("/api/stop", {});
            appendLogRef.current("[stop] " + result.message);
          } catch (error) {
            appendLogRef.current("[stop] " + (error && error.message ? error.message : String(error)));
          }
        }

        function handleClearLog() {
          setLogText("");
        }

        return h(
          "div",
          { className: "wrap" },
          h("h1", null, "TWMD Web GUI"),
          h("p", { className: "desc" }, "先登录 cookie，再填写用户并开始下载。"),
          h(
            "section",
            { className: "card" },
            h("h2", null, "1) 登录"),
            h(
              "div",
              { className: "row" },
              h("label", { htmlFor: "cookieText" }, "Cookie 文本（推荐）"),
              h("textarea", {
                id: "cookieText",
                placeholder: "粘贴 cookie 文本",
                value: cookieText,
                onChange: function (event) {
                  setCookieText(event.target.value);
                }
              })
            ),
            h(
              "div",
              { className: "row" },
              h("label", { htmlFor: "cookieFilePath" }, "或 Cookie 文件路径"),
              h("input", {
                id: "cookieFilePath",
                type: "text",
                placeholder: "例如 /Users/you/cookies.txt",
                value: cookieFilePath,
                onChange: function (event) {
                  setCookieFilePath(event.target.value);
                }
              })
            ),
            h(
              "div",
              { className: "row" },
              h(
                "label",
                null,
                h("input", {
                  id: "looseCookie",
                  type: "checkbox",
                  checked: looseCookie,
                  style: {
                    width: "auto",
                    marginRight: "6px"
                  },
                  onChange: function (event) {
                    setLooseCookie(event.target.checked);
                  }
                }),
                "关闭严格校验"
              )
            ),
            h(
              "div",
              { className: "actions" },
              h(
                "button",
                {
                  className: "primary",
                  id: "btnLogin",
                  onClick: function () {
                    void handleLogin();
                  }
                },
                "保存登录"
              ),
              h(
                "button",
                {
                  id: "btnInteractiveLogin",
                  onClick: function () {
                    void handleInteractiveLogin();
                  }
                },
                "浏览器登录"
              ),
              h(
                "button",
                {
                  id: "btnWhoami",
                  onClick: function () {
                    void handleWhoami();
                  }
                },
                "检查登录"
              ),
              h(
                "button",
                {
                  id: "btnLogout",
                  onClick: function () {
                    void handleLogout();
                  }
                },
                "退出登录"
              )
            )
          ),
          h(
            "section",
            { className: "card" },
            h("h2", null, "2) 下载"),
            h(
              "div",
              { className: "row" },
              h("label", { htmlFor: "users" }, "用户（逗号/空格/换行）"),
              h("textarea", {
                id: "users",
                placeholder: "nasa",
                value: users,
                onChange: function (event) {
                  setUsers(event.target.value);
                }
              })
            ),
            h(
              "div",
              { className: "grid2" },
              h(
                "div",
                { className: "row" },
                h("label", { htmlFor: "outDir" }, "输出目录"),
                h("input", {
                  id: "outDir",
                  type: "text",
                  value: outDir,
                  onChange: function (event) {
                    setOutDir(event.target.value);
                  }
                })
              ),
              h(
                "div",
                { className: "row" },
                h("label", { htmlFor: "kinds" }, "媒体类型"),
                h("input", {
                  id: "kinds",
                  type: "text",
                  value: kinds,
                  onChange: function (event) {
                    setKinds(event.target.value);
                  }
                })
              )
            ),
            h(
              "details",
              null,
              h("summary", null, "高级参数（可选）"),
              h(
                "div",
                { className: "grid2" },
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "engine" }, "抓取引擎"),
                  h(
                    "select",
                    {
                      id: "engine",
                      value: engine,
                      onChange: function (event) {
                        setEngine(event.target.value);
                      }
                    },
                    h("option", { value: "graphql" }, "graphql（API 抓取）"),
                    h("option", { value: "playwright" }, "playwright（仅页面抓取）")
                  )
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "maxTweets" }, "最大推文数"),
                  h("input", {
                    id: "maxTweets",
                    type: "number",
                    min: "1",
                    placeholder: "50",
                    value: maxTweets,
                    onChange: function (event) {
                      setMaxTweets(event.target.value);
                    }
                  })
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "concurrency" }, "并发"),
                  h("input", {
                    id: "concurrency",
                    type: "number",
                    min: "1",
                    value: concurrency,
                    onChange: function (event) {
                      setConcurrency(event.target.value);
                    }
                  })
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "retry" }, "媒体重试"),
                  h("input", {
                    id: "retry",
                    type: "number",
                    min: "0",
                    value: retry,
                    onChange: function (event) {
                      setRetry(event.target.value);
                    }
                  })
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "userRetry" }, "用户重试"),
                  h("input", {
                    id: "userRetry",
                    type: "number",
                    min: "0",
                    value: userRetry,
                    onChange: function (event) {
                      setUserRetry(event.target.value);
                    }
                  })
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "userDelayMs" }, "用户间隔(ms)"),
                  h("input", {
                    id: "userDelayMs",
                    type: "number",
                    min: "0",
                    value: userDelayMs,
                    onChange: function (event) {
                      setUserDelayMs(event.target.value);
                    }
                  })
                ),
                h(
                  "div",
                  { className: "row" },
                  h("label", { htmlFor: "requestDelayMs" }, "请求间隔(ms)"),
                  h("input", {
                    id: "requestDelayMs",
                    type: "number",
                    min: "0",
                    value: requestDelayMs,
                    onChange: function (event) {
                      setRequestDelayMs(event.target.value);
                    }
                  })
                )
              )
            ),
            h(
              "div",
              {
                className: "actions",
                style: {
                  marginTop: "10px"
                }
              },
              h(
                "button",
                {
                  className: "primary",
                  id: "btnStart",
                  onClick: function () {
                    void handleStart();
                  }
                },
                "开始下载"
              ),
              h(
                "button",
                {
                  className: "warn",
                  id: "btnStop",
                  onClick: function () {
                    void handleStop();
                  }
                },
                "停止任务"
              )
            )
          ),
          h(
            "section",
            { className: "log" },
            h(
              "div",
              { className: "log-head" },
              h("strong", null, "实时日志"),
              h(
                "button",
                {
                  id: "btnClear",
                  onClick: handleClearLog
                },
                "清空"
              )
            ),
            h("pre", { id: "log", ref: logRef }, logText),
            h("p", { className: "status", id: "status" }, "状态：" + status)
          )
        );
      }

      var rootElement = document.getElementById("root");
      if (!rootElement) {
        console.error("[twmd-gui] missing #root element");
        return;
      }

      if (typeof ReactDOMRef.createRoot === "function") {
        ReactDOMRef.createRoot(rootElement).render(h(App));
      } else {
        ReactDOMRef.render(h(App), rootElement);
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

      if (method === "POST" && requestUrl.pathname === "/api/login-interactive") {
        const payload = await readJsonBody<InteractiveLoginRequest>(req);
        const args = [
          "login-interactive",
          "--output-format",
          "json",
          "--no-color"
        ];

        if (payload.looseCookie) {
          args.push("--loose-cookie");
        }

        if (payload.timeoutMs !== undefined && payload.timeoutMs !== null && payload.timeoutMs !== 0) {
          args.push("--timeout-ms", String(payload.timeoutMs));
        }

        const result = await runCliOnce(input.cliScriptPath, args);
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
