// local-batch-report-worker.mjs — 报表渲染 worker 线程入口（LOCAL-07）。
//
// 只消费主线程传入的**已冻结报表 DTO**（schemaVersion=1，来自 report-export.mjs 的一致只读快照），
// 调用已审 LOCAL-05 纯渲染函数 buildReportDocument / buildReportXlsx / buildReportPdf。
//
// 约束：
// - 绝不 import db.mjs / accounting.mjs / report-export.mjs / report-office-export 的
//   buildOfficeExport：本 worker 不打开数据库、不重算任何金额、不查询账套。
// - 只做「DTO -> 字节」；文件名、路径、发布、hash 记录、状态机全部由主线程负责。
// - 回传真实 threadId 与可比对的渲染起止时间（performance.timeOrigin + performance.now()，
//   各线程都以 epoch 毫秒为基准，因此可跨线程比较区间重叠）。

import { parentPort, threadId } from "node:worker_threads";
import {
  buildReportDocument, buildReportXlsx, buildReportPdf,
} from "./report-office-export.mjs";

const stamp = () => performance.timeOrigin + performance.now();

async function render({ format, dto }) {
  const document = buildReportDocument(dto);
  if (format === "xlsx") return { buffer: await buildReportXlsx(dto, document), meta: {} };
  if (format === "pdf") {
    const result = await buildReportPdf(dto, document);
    return { buffer: result.buffer, meta: { pageCount: result.pageCount, font: result.font?.label ?? null } };
  }
  throw Object.assign(new Error("report_format_unsupported"), { code: "report_format_unsupported" });
}

if (parentPort) {
  parentPort.on("message", async (message) => {
    if (!message || message.type !== "render") return;
    const started = stamp();
    try {
      const { buffer, meta } = await render(message);
      const finished = stamp();
      const bytes = Buffer.from(buffer);
      const copy = new Uint8Array(bytes);
      parentPort.postMessage(
        { type: "rendered", id: message.id, ok: true, buffer: copy, threadId, started, finished, meta },
        [copy.buffer],
      );
    } catch (error) {
      parentPort.postMessage({
        type: "rendered", id: message.id, ok: false, threadId, started, finished: stamp(),
        code: error?.code || "render_failed",
        message: String(error?.message || error).slice(0, 300),
      });
    }
  });
}
