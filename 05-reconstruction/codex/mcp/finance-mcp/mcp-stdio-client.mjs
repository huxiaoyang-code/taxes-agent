/**
 * mcp-stdio-client.mjs — 供测试脚本复用的最小 MCP stdio 客户端。
 *
 * 关注点：单行 JSON 解析容错、每个请求超时、子进程清理。
 * 不依赖任何外部 SDK，只用 node 内置模块。
 */
import { spawn } from "node:child_process";

export class McpStdioClient {
  constructor(serverPath, { env = {}, cwd, timeoutMs = 15000 } = {}) {
    this.serverPath = serverPath;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.buf = "";
    this.stderr = "";
    this.nextId = 1;
    this.exited = false;
    this.child = null;
  }

  start() {
    this.child = spawn(process.execPath, [this.serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
      cwd: this.cwd,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => { this.stderr += d; });
    this.child.on("error", (e) => this.#failAll(new Error(`mcp_spawn_failed: ${e.message}`)));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.#failAll(new Error(`mcp_exited: code=${code} signal=${signal}${this.stderr ? ` stderr=${this.stderr.slice(0, 400)}` : ""}`));
    });
    return this;
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 非 JSON 输出直接跳过，不再二次抛错
      if (msg.id === undefined) continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  rpc(method, params = {}) {
    if (!this.child || this.exited) return Promise.reject(new Error("mcp_not_running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_timeout: ${method} 超过 ${this.timeoutMs}ms 未响应`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    if (!this.child || this.exited) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(clientName = "mcp-test") {
    const init = await this.rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" },
    });
    this.notify("notifications/initialized");
    return init;
  }

  /** 调用工具；返回 { isError, text, data, structured }，text 非 JSON 时 data=null。 */
  async call(name, args = {}) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r.error) return { isError: true, text: r.error.message, data: null, structured: r.error, rpcError: true };
    const text = r.result?.content?.[0]?.text;
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 保留原始文本 */ }
    return { isError: r.result?.isError === true, text, data, structured: r.result?.structuredContent ?? null };
  }

  async close() {
    if (!this.child || this.exited) return;
    const child = this.child;
    const done = new Promise((resolve) => child.once("exit", resolve));
    try { child.stdin.end(); } catch { /* 忽略此处异常 */ }
    child.kill();
    const timer = new Promise((resolve) => setTimeout(resolve, 3000));
    await Promise.race([done, timer]);
    if (!this.exited) { try { child.kill("SIGKILL"); } catch { /* 忽略此处异常 */ } }
  }
}
