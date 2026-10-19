// app.js — 记账 + 报表 网页前端（零依赖）
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (Number(n) || 0).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

let META = { coa: [], standards: [] };
let SETS = [], SET_ID = null, SET = null, ACCOUNTS = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ------------------------------------------------------------------ 账套
async function loadMeta() { META = await api("/api/meta"); }
async function loadSets(selectId) {
  SETS = await api("/api/account-sets");
  const sel = $("#accountSetSelect");
  sel.innerHTML = SETS.length
    ? SETS.map((s) => `<option value="${s.id}">${esc(s.name)}（${esc(s.taxpayer_type)}）</option>`).join("")
    : `<option value="">（暂无账套）</option>`;
  if (selectId) sel.value = selectId;
  SET_ID = sel.value ? +sel.value : null;
  await selectSet();
}
async function selectSet() {
  SET = SET_ID ? await api(`/api/account-sets/${SET_ID}`) : null;
  ACCOUNTS = SET_ID ? await api(`/api/account-sets/${SET_ID}/accounts`) : [];
  $("#setMeta").textContent = SET ? `启用期间 ${SET.start_period} · ${SET.accounting_standard}` : "请先新建账套";
  for (const id of ["#vPeriod", "#rPeriod", "#aPeriod", "#pPeriod"]) { const el = $(id); if (!el.value) el.value = SET?.start_period || thisMonth(); }
  renderAccounts(); renderOpening(); await loadVouchers(); renderPeriods(); await renderAssets();
  fillCodeSelect();
  $("#btnExportReport").disabled = !SET_ID;
  $("#reportExportStatus").textContent = "";
  $("#reportOut").innerHTML = "";
  $("#reportWarnings").textContent = "";
}
function newSetDialog() {
  const d = document.createElement("dialog");
  d.innerHTML = `
    <h3>新建账套</h3>
    <div class="row"><label>名称 <input id="nsName" placeholder="例：某某贸易有限公司" /></label></div>
    <div class="row"><label>纳税人性质 <select id="nsTax"><option>小规模纳税人</option><option>一般纳税人</option></select></label></div>
    <div class="row"><label>会计准则 <select id="nsStd">${META.standards.map((s) => `<option>${s}</option>`).join("")}</select></label></div>
    <div class="row"><label>启用期间 <input type="month" id="nsStart" value="${thisMonth()}" /></label></div>
    <div class="row" style="justify-content:flex-end">
      <button id="nsCancel">取消</button>
      <button id="nsTaxBrowser" class="ghost">创建后从税局导入</button>
      <button id="nsOk" class="primary">创建</button>
    </div>`;
  document.body.appendChild(d);
  d.showModal();
  $("#nsCancel", d).onclick = () => d.close();
  d.addEventListener("close", () => d.remove());
  // 普通返回/抛错的内部 async 函数：创建失败时抛错，由最外层 handler 统一处理；
  // 失败不继续 loadSets、也不打开税局 dialog，因此不会重复创建账套。
  const create = async () => {
    const set = await api("/api/account-sets", { method: "POST", body: {
      name: $("#nsName", d).value.trim(), taxpayer_type: $("#nsTax", d).value,
      accounting_standard: $("#nsStd", d).value, start_period: $("#nsStart", d).value } });
    d.close();
    return set;
  };
  $("#nsOk", d).onclick = guard(async () => {
    const set = await create();
    await loadSets(set.id); toast("账套已创建，已载入标准科目表");
  });
  $("#nsTaxBrowser", d).onclick = guard(async () => {
    const set = await create();
    await loadSets(set.id);
    toast("空账套已创建，请在税局导入窗口中绑定企业基本信息");
    taxBrowserDialog({ bindSetId: set.id });
  });
}

// ------------------------------------------------------------------ 导入账套
function readFileText(file, encoding) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("文件读取失败"));
    r.readAsText(file, encoding);
  });
}
function downloadText(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}
function importSetDialog() {
  const d = document.createElement("dialog");
  d.style.minWidth = "640px";
  d.innerHTML = `
    <h3>导入账套</h3>
    <p class="hint">两种方式：① 一个 JSON 文件（最稳）；② 四张 CSV（账套/科目/期初余额/凭证，Excel 另存为 CSV）。
    导入前先预检，借贷不平、科目不存在会明确报错。</p>
    <div class="row">
      <label>CSV 编码 <select id="impEnc"><option value="utf-8">UTF-8</option><option value="gbk">GBK / GB18030（中文 Excel 常见）</option></select></label>
      <button id="impTpl" class="ghost">下载 CSV 模板</button>
    </div>
    <div class="row"><label>① JSON 文件 <input type="file" id="impJson" accept=".json,application/json" /></label></div>
    <div class="row" style="gap:10px">
      <label>账套.csv <input type="file" id="impMeta" accept=".csv,.txt" /></label>
      <label>科目.csv <input type="file" id="impAccounts" accept=".csv,.txt" /></label>
    </div>
    <div class="row" style="gap:10px">
      <label>期初余额.csv <input type="file" id="impOpenings" accept=".csv,.txt" /></label>
      <label>凭证.csv <input type="file" id="impVouchers" accept=".csv,.txt" /></label>
    </div>
    <div id="impResult" class="card hidden" style="max-height:280px"></div>
    <div class="row" style="justify-content:flex-end">
      <button id="impCancel">取消</button>
      <button id="impPreview">预检</button>
      <button id="impConfirm" class="primary" disabled>确认导入</button>
    </div>`;
  document.body.appendChild(d); d.showModal();
  let payload = null;
  d.addEventListener("close", () => d.remove());
  $("#impCancel", d).onclick = () => d.close();
  $("#impTpl", d).onclick = guard(async () => {
    const t = await api("/api/import/templates");
    downloadText("账套.csv", t.meta); downloadText("科目.csv", t.accounts);
    downloadText("期初余额.csv", t.openings); downloadText("凭证.csv", t.vouchers);
    toast("已下载 4 个 CSV 模板");
  });
  const showValidation = (v) => {
    const el = $("#impResult", d); el.classList.remove("hidden");
    el.innerHTML = `<div><b>${v.ok ? "✅ 预检通过" : "❌ 预检未通过"}</b></div>
      <div class="hint">账套：${esc(v.summary.account_set || "—")} · 启用 ${esc(v.summary.start_period || "—")} ·
      额外科目 ${v.summary.accounts} · 期初 ${v.summary.opening_balances} · 凭证 ${v.summary.vouchers}（${v.summary.entries} 分录）</div>
      ${v.errors.length ? `<div style="color:#d03050"><b>错误（${v.errors.length}）</b><ul>${v.errors.slice(0, 30).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
      ${v.warnings.length ? `<div style="color:#e6a23c"><b>提示（${v.warnings.length}）</b><ul>${v.warnings.slice(0, 20).map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}`;
  };
  $("#impPreview", d).onclick = guard(async () => {
    const enc = $("#impEnc", d).value;
    const jsonFile = $("#impJson", d).files[0];
    if (jsonFile) {
      payload = JSON.parse(await readFileText(jsonFile, "utf-8"));
      const r = await api("/api/import/account-set", { method: "POST", body: { payload, dryRun: true } });
      showValidation(r.validation); $("#impConfirm", d).disabled = !r.validation.ok; return;
    }
    const files = { meta: $("#impMeta", d).files[0], accounts: $("#impAccounts", d).files[0],
      openings: $("#impOpenings", d).files[0], vouchers: $("#impVouchers", d).files[0] };
    if (!Object.values(files).some(Boolean)) return toast("请选择 JSON 或至少一张 CSV", true);
    const texts = {};
    for (const [k, f] of Object.entries(files)) if (f) texts[k] = await readFileText(f, enc);
    const r = await api("/api/import/parse", { method: "POST", body: { texts } });
    payload = r.payload; showValidation(r.validation); $("#impConfirm", d).disabled = !r.validation.ok;
    if (r.validation.ok) toast("预检通过，可确认导入"); else toast("预检未通过，见下方错误", true);
  });
  $("#impConfirm", d).onclick = guard(async () => {
    const r = await api("/api/import/account-set", { method: "POST", body: { payload, dryRun: false } });
    d.close(); await loadSets(r.created.id);
    toast(`账套已导入：${r.created.name}（凭证 ${r.created.vouchers} 张）`);
  });
}

// ------------------------------------------------------------------ 科目
function renderAccounts() {
  if (!SET_ID) return $("#accountList").innerHTML = `<p class="hint">请先新建账套</p>`;
  $("#accountList").innerHTML = `<table><thead><tr><th>编码</th><th>名称</th><th>类别</th><th>方向</th></tr></thead>
    <tbody>${ACCOUNTS.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.category)}</td>
      <td>${a.direction === "debit" ? "借" : "贷"}${a.contra ? "（备抵）" : ""}</td></tr>`).join("")}</tbody></table>`;
}
function addAccountDialog() {
  if (!SET_ID) return toast("请先新建账套", true);
  const d = document.createElement("dialog");
  d.innerHTML = `<h3>新增科目</h3>
    <div class="row"><label>编码 <input id="acCode" /></label><label>名称 <input id="acName" /></label></div>
    <div class="row"><label>类别 <select id="acCat"><option>资产</option><option>负债</option><option>权益</option><option>成本</option><option>损益</option></select></label>
      <label>方向 <select id="acDir"><option value="debit">借</option><option value="credit">贷</option></select></label></div>
    <div class="row" style="justify-content:flex-end"><button id="acCancel">取消</button><button id="acOk" class="primary">新增</button></div>`;
  document.body.appendChild(d); d.showModal();
  $("#acCancel", d).onclick = () => d.close(); d.addEventListener("close", () => d.remove());
  $("#acOk", d).onclick = guard(async () => {
    ACCOUNTS = await api(`/api/account-sets/${SET_ID}/accounts`, { method: "POST", body: {
      code: $("#acCode", d).value.trim(), name: $("#acName", d).value.trim(),
      category: $("#acCat", d).value, direction: $("#acDir", d).value } });
    d.close(); renderAccounts(); fillCodeSelect(); renderOpening(); toast("科目已新增");
  });
}

// ------------------------------------------------------------------ 期初
function renderOpening() {
  if (!SET_ID) return $("#openingList").innerHTML = "";
  api(`/api/account-sets/${SET_ID}/opening-balances`).then((obs) => {
    const map = new Map(obs.map((o) => [o.code, o]));
    $("#openingList").innerHTML = `<table><thead><tr><th>编码</th><th>名称</th><th class="num">借方期初</th><th class="num">贷方期初</th></tr></thead>
      <tbody>${ACCOUNTS.map((a) => { const o = map.get(a.code) || {};
        return `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td>
          <td class="num"><input type="number" step="0.01" data-code="${a.code}" data-side="debit" value="${o.debit || ""}" /></td>
          <td class="num"><input type="number" step="0.01" data-code="${a.code}" data-side="credit" value="${o.credit || ""}" /></td></tr>`; }).join("")}</tbody></table>`;
  }).catch(() => {});
}
const saveOpening = guard(async () => {
  const map = new Map();
  $$("#openingList input").forEach((i) => {
    const e = map.get(i.dataset.code) || { code: i.dataset.code, debit: 0, credit: 0 };
    e[i.dataset.side] = Number(i.value) || 0; map.set(i.dataset.code, e);
  });
  const items = [...map.values()].filter((e) => e.debit || e.credit);
  await api(`/api/account-sets/${SET_ID}/opening-balances`, { method: "PUT", body: { items } });
  toast("期初余额已保存");
});

// ------------------------------------------------------------------ 凭证
async function loadVouchers() {
  if (!SET_ID) return $("#voucherList").innerHTML = "";
  const p = $("#vPeriod").value, s = $("#vStatus").value;
  const qs = new URLSearchParams(); if (p) qs.set("period", p); if (s) qs.set("status", s);
  const list = await api(`/api/account-sets/${SET_ID}/vouchers?${qs}`);
  $("#voucherList").innerHTML = !list.length ? `<p class="hint">暂无凭证</p>` :
    `<table><thead><tr><th>期间</th><th>字号</th><th>日期</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th>状态</th><th>操作</th></tr></thead>
     <tbody>${list.map((v) => `<tr><td>${v.period}</td><td>${v.word}-${String(v.number).padStart(3, "0")}</td><td>${v.voucher_date}</td>
       <td>${esc(v.summary)}</td><td class="num">${money(v.total_debit)}</td><td class="num">${money(v.total_credit)}</td>
       <td><span class="badge ${v.status}">${v.status === "posted" ? "已过账" : "草稿"}</span></td>
       <td>${v.status === "posted"
          ? `<button data-act="unpost" data-id="${v.id}">反过账</button>`
          : `<button data-act="edit" data-id="${v.id}">编辑</button><button data-act="post" data-id="${v.id}">过账</button><button class="danger" data-act="del" data-id="${v.id}">删除</button>`}
       </td></tr>`).join("")}</tbody></table>`;
}
function bindVoucherActions(root) {
  root.onclick = guard(async (ev) => {
    const b = ev.target.closest("button[data-act]"); if (!b) return;
    const id = +b.dataset.id, act = b.dataset.act;
    if (act === "post") { await api(`/api/account-sets/${SET_ID}/vouchers/${id}/post`, { method: "POST" }); toast("已过账"); }
    if (act === "unpost") { await api(`/api/account-sets/${SET_ID}/vouchers/${id}/unpost`, { method: "POST" }); toast("已反过账"); }
    if (act === "del") { if (!confirm("确认删除该草稿凭证？")) return; await api(`/api/account-sets/${SET_ID}/vouchers/${id}`, { method: "DELETE" }); toast("已删除"); }
    if (act === "edit") { const v = await api(`/api/account-sets/${SET_ID}/vouchers/${id}`); return openEditor(v); }
    await loadVouchers();
  });
}

function lineRow(e = {}) {
  return `<tr>
    <td class="code"><select class="l-code">${ACCOUNTS.map((a) =>
      `<option value="${a.code}" ${e.code === a.code ? "selected" : ""}>${a.code} ${esc(a.name)}</option>`).join("")}</select></td>
    <td><input class="l-sum" value="${esc(e.summary || "")}" placeholder="摘要" /></td>
    <td class="amt"><input class="l-debit" type="number" step="0.01" value="${e.debit ? money(e.debit) : ""}" /></td>
    <td class="amt"><input class="l-credit" type="number" step="0.01" value="${e.credit ? money(e.credit) : ""}" /></td>
    <td><button class="danger" data-del="1">×</button></td></tr>`;
}
function openEditor(v) {
  const wrap = $("#voucherEditor");
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="row">
      <strong>${v ? "编辑凭证" : "录入凭证"}</strong>
      <label>期间 <input type="month" id="ePeriod" value="${v?.period || $("#vPeriod").value || SET.start_period}" /></label>
      <label>日期 <input type="date" id="eDate" value="${v?.voucher_date || today()}" /></label>
      <label>字号 <input id="eWord" style="width:56px" value="${v?.word || "记"}" /> - <span>${v ? String(v.number).padStart(3, "0") : "自动"}</span></label>
    </div>
    <div class="row"><label style="flex:1">摘要 <input id="eSummary" style="width:100%" value="${esc(v?.summary || "")}" /></label></div>
    <table class="vlines"><thead><tr><th>科目</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th></th></tr></thead>
      <tbody id="eLines">${(v?.entries?.length ? v.entries : [{}, {}]).map(lineRow).join("")}</tbody></table>
    <div class="vtotals"><span>借方合计 <b id="tDebit">0.00</b></span><span>贷方合计 <b id="tCredit">0.00</b></span><span id="tDiff"></span></div>
    <div class="row" style="justify-content:flex-end">
      <button id="eAddLine">+ 加一行</button>
      <button id="eCancel">取消</button>
      <button id="eDraft">存草稿</button>
      <button id="ePost" class="primary">保存并过账</button>
    </div>`;
  wrap.dataset.vid = v?.id || "";
  const recalc = () => {
    let d = 0, c = 0;
    $$("#eLines tr").forEach((tr) => { d += Number($(".l-debit", tr).value) || 0; c += Number($(".l-credit", tr).value) || 0; });
    $("#tDebit").textContent = money(d); $("#tCredit").textContent = money(c);
    const diff = Math.round((d - c) * 100) / 100;
    $("#tDiff").innerHTML = `<span class="${diff === 0 ? "ok" : "diff"}">${diff === 0 ? "借贷平衡" : "差额 " + money(diff)}</span>`;
  };
  wrap.oninput = recalc;
  wrap.onclick = (ev) => {
    if (ev.target.id === "eAddLine") { $("#eLines").insertAdjacentHTML("beforeend", lineRow()); recalc(); }
    if (ev.target.dataset.del) { ev.target.closest("tr").remove(); recalc(); }
  };
  $("#eCancel").onclick = () => wrap.classList.add("hidden");
  const collect = () => ({
    period: $("#ePeriod").value, voucher_date: $("#eDate").value, word: $("#eWord").value.trim() || "记",
    summary: $("#eSummary").value.trim(),
    entries: $$("#eLines tr").map((tr) => ({
      code: $(".l-code", tr).value, summary: $(".l-sum", tr).value.trim(),
      debit: Number($(".l-debit", tr).value) || 0, credit: Number($(".l-credit", tr).value) || 0
    })).filter((e) => e.debit || e.credit)
  });
  const save = guard(async (post) => {
    const body = { ...collect(), status: post ? "posted" : "draft" };
    const vid = wrap.dataset.vid;
    if (vid) { await api(`/api/account-sets/${SET_ID}/vouchers/${vid}`, { method: "DELETE" }).catch(() => {}); }
    await api(`/api/account-sets/${SET_ID}/vouchers`, { method: "POST", body });
    wrap.classList.add("hidden"); $("#voucherList").onsubmit; await loadVouchers(); toast(post ? "凭证已过账" : "草稿已保存");
  });
  $("#eDraft").onclick = () => save(false);
  $("#ePost").onclick = () => save(true);
  recalc();
}

// ------------------------------------------------------------------ 资产
async function renderAssets() {
  if (!SET_ID) return $("#assetList").innerHTML = "";
  const list = await api(`/api/account-sets/${SET_ID}/assets`);
  $("#assetList").innerHTML = !list.length ? `<p class="hint">暂无资产卡片</p>` :
    `<table><thead><tr><th>ID</th><th>类型</th><th>名称</th><th class="num">原值</th><th class="num">残值率</th>
      <th class="num">月计提</th><th class="num">已提</th><th class="num">剩余</th><th>起提</th><th>操作</th></tr></thead><tbody>
      ${list.map((a) => `<tr><td>${a.id}</td><td>${a.kind === "fixed" ? "固定资产" : "无形资产"}</td><td>${esc(a.name)}</td>
        <td class="num">${money(a.original_cost)}</td><td class="num">${(a.residual_rate * 100).toFixed(0)}%</td>
        <td class="num">${money(a.monthly)}</td><td class="num">${money(a.accumulated)}</td><td class="num">${money(a.remaining)}</td>
        <td>${a.start_period}</td><td><button class="danger" data-del="${a.id}">删除</button></td></tr>`).join("")}</tbody></table>`;
  $("#assetList").onclick = guard(async (ev) => {
    const b = ev.target.closest("button[data-del]"); if (!b) return;
    if (!confirm("确认删除该资产卡片？")) return;
    await api(`/api/account-sets/${SET_ID}/assets/${b.dataset.del}`, { method: "DELETE" });
    await renderAssets(); toast("已删除");
  });
  await renderDepRuns();
}
async function renderDepRuns() {
  if (!SET_ID) return;
  const runs = await api(`/api/account-sets/${SET_ID}/depreciation-runs`);
  $("#depRunList").innerHTML = !runs.length ? "" :
    `<h4>计提记录</h4><table><thead><tr><th>期间</th><th>资产ID</th><th class="num">金额</th><th>凭证ID</th></tr></thead><tbody>
     ${runs.slice(0, 60).map((r) => `<tr><td>${r.period}</td><td>${r.asset_id}</td><td class="num">${money(r.amount)}</td><td>${r.voucher_id ?? ""}</td></tr>`).join("")}</tbody></table>`;
}
function addAssetDialog() {
  if (!SET_ID) return toast("请先新建账套", true);
  const d = document.createElement("dialog");
  d.innerHTML = `<h3>新增资产</h3>
    <div class="row"><label>类型 <select id="asKind"><option value="fixed">固定资产</option><option value="intangible">无形资产</option></select></label>
      <label>名称 <input id="asName" /></label></div>
    <div class="row"><label>原值 <input type="number" step="0.01" id="asCost" /></label>
      <label>残值率 <input type="number" step="0.01" id="asResidual" value="0.05" /></label>
      <label>使用月数 <input type="number" id="asLife" value="60" /></label></div>
    <div class="row"><label>起提期间 <input type="month" id="asStart" value="${$("#aPeriod").value || SET.start_period}" /></label>
      <label>费用科目 <select id="asExpense"></select></label></div>
    <div class="row" style="justify-content:flex-end"><button id="asCancel">取消</button><button id="asOk" class="primary">新增</button></div>`;
  document.body.appendChild(d); d.showModal();
  $("#asExpense", d).innerHTML = ACCOUNTS.filter((a) => a.category === "损益")
    .map((a) => `<option value="${a.code}">${a.code} ${esc(a.name)}</option>`).join("");
  $("#asExpense", d).value = "5602";
  $("#asCancel", d).onclick = () => d.close(); d.addEventListener("close", () => d.remove());
  $("#asOk", d).onclick = guard(async () => {
    await api(`/api/account-sets/${SET_ID}/assets`, { method: "POST", body: {
      kind: $("#asKind", d).value, name: $("#asName", d).value.trim(), original_cost: Number($("#asCost", d).value),
      residual_rate: Number($("#asResidual", d).value), useful_life_months: Number($("#asLife", d).value),
      start_period: $("#asStart", d).value, expense_account: $("#asExpense", d).value } });
    d.close(); await renderAssets(); toast("资产卡片已新增");
  });
}

// ------------------------------------------------------------------ 报表
function fillCodeSelect() { $("#rCode").innerHTML = ACCOUNTS.map((a) => `<option value="${a.code}">${a.code} ${esc(a.name)}</option>`).join(""); }
async function downloadReport() {
  const status = $("#reportExportStatus"), button = $("#btnExportReport");
  status.textContent = "";
  if (!SET_ID) { status.textContent = "请先选择或新建账套"; return; }
  const kind = $("#rKind").value, period = $("#rPeriod").value, code = $("#rCode").value;
  const source = `${SET?.name || `账套 ${SET_ID}`} · ${period}`;
  if (!period) { status.textContent = "请选择报表期间"; return; }
  if (kind === "ledger" && !code) { status.textContent = "请选择明细账科目"; return; }
  const query = new URLSearchParams({ period, format: "csv" });
  if (kind === "ledger") query.set("code", code);
  button.disabled = true;
  status.textContent = "正在生成 CSV…";
  try {
    const response = await fetch(`/api/account-sets/${SET_ID}/reports/${kind}/export?${query}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const messages = {
        period_required: "请选择报表期间", period_invalid: "报表期间格式不正确", period_before_start: "期间早于账套启用期间",
        period_not_registered: "该期间尚未登记，请先在期间页登记", account_set_not_found: "账套不存在，请重新选择",
        account_code_required: "请选择明细账科目", account_not_found: "所选科目不存在，请重新选择",
        report_kind_unsupported: "不支持此报表类型", report_format_unsupported: "不支持此导出格式",
      };
      throw new Error(messages[error.error] || error.message || `导出失败（HTTP ${response.status}）`);
    }
    if (!/^text\/csv\b/i.test(response.headers.get("content-type") || "")) throw new Error("服务器未返回 CSV，下载已取消");
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : `${kind}-${period}.csv`;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `${source}：CSV 已生成并开始下载（仅供内部使用）`;
  } catch (e) {
    status.textContent = `${source}：导出失败：${e.message}`;
    toast(status.textContent, true);
  } finally {
    button.disabled = !SET_ID;
  }
}
async function runReport() {
  if (!SET_ID) return toast("请先新建账套", true);
  const kind = $("#rKind").value, period = $("#rPeriod").value;
  $("#rCodeWrap").classList.toggle("hidden", kind !== "ledger");
  $("#reportOut").innerHTML = "";
  $("#reportWarnings").textContent = "";
  const query = new URLSearchParams({ period });
  if (kind === "ledger") query.set("code", $("#rCode").value);
  const report = await api(`/api/account-sets/${SET_ID}/reports/${kind}/export-data?${query}`);
  const d = report.data;
  $("#reportWarnings").textContent = report.warnings.map((warning) => warning.message).join(" ");
  if (kind === "ledger") {
    const summary = (label, values, balance = "") => `<tr class="strong"><td colspan="3">${label}</td><td class="num">${money(values.debit)}</td><td class="num">${money(values.credit)}</td><td class="num">${balance}</td></tr>`;
    $("#reportOut").innerHTML = `<h3>明细账 · ${esc(d.period)} · ${esc(d.code)} ${esc(d.name)}</h3>
      <table><thead><tr><th>日期 / 科目</th><th>凭证</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th class="num">余额（借正贷负）</th></tr></thead><tbody>
      ${summary("期间期初余额", d.opening, money(d.opening.debit - d.opening.credit))}
      ${d.items.map((it) => `<tr><td>${esc(it.voucher_date)} / ${esc(it.code)}</td><td>${esc(it.word)}-${esc(String(it.number).padStart(3, "0"))}</td><td>${esc(it.summary)}</td>
        <td class="num">${money(it.debit)}</td><td class="num">${money(it.credit)}</td><td class="num">${money(it.balance)}</td></tr>`).join("")}
      ${summary("本期发生合计", d.current)}${summary("本年累计发生", d.ytd)}${summary("期末余额", d.closing, money(d.closing.debit - d.closing.credit))}
      </tbody></table>`;
    return;
  }
  if (kind === "trial-balance") {
    $("#reportOut").innerHTML = `<h3>科目余额表 · ${esc(period)}</h3>
      <table><thead><tr><th>编码</th><th>名称</th><th class="num">期间期初借</th><th class="num">期间期初贷</th>
      <th class="num">本期借</th><th class="num">本期贷</th><th class="num">本年累计借</th><th class="num">本年累计贷</th><th class="num">期末借</th><th class="num">期末贷</th></tr></thead><tbody>
      ${d.lines.map((l) => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)}</td><td class="num">${money(l.opening_debit)}</td><td class="num">${money(l.opening_credit)}</td>
        <td class="num">${money(l.period_debit)}</td><td class="num">${money(l.period_credit)}</td><td class="num">${money(l.ytd_debit)}</td><td class="num">${money(l.ytd_credit)}</td><td class="num">${money(l.closing_debit)}</td><td class="num">${money(l.closing_credit)}</td></tr>`).join("")}
      <tr class="total"><td colspan="2">合计</td><td class="num">${money(d.totals.opening_debit)}</td><td class="num">${money(d.totals.opening_credit)}</td>
        <td class="num">${money(d.totals.period_debit)}</td><td class="num">${money(d.totals.period_credit)}</td>
        <td class="num">${money(d.totals.ytd_debit)}</td><td class="num">${money(d.totals.ytd_credit)}</td>
        <td class="num">${money(d.totals.closing_debit)}</td><td class="num">${money(d.totals.closing_credit)}</td></tr></tbody></table>`;
    return;
  }
  if (kind === "balance-sheet") {
    const rowsOf = (arr) => arr.map((l) => `<tr class="${l.strong ? "strong" : ""}"><td>${esc(l.label)}</td><td class="num">${money(l.value)}</td></tr>`).join("");
    $("#reportOut").innerHTML = `<h3>资产负债表 · ${period} ${d.balanced ? "" : '<span style="color:#d03050">（不平衡，请检查期初/凭证）</span>'}</h3>
      <div class="two-col"><table><thead><tr><th>资产</th><th class="num">期末余额</th></tr></thead><tbody>${rowsOf(d.assets)}</tbody></table>
      <table><thead><tr><th>负债和所有者权益</th><th class="num">期末余额</th></tr></thead><tbody>${rowsOf(d.liabilities)}</tbody></table></div>`;
    return;
  }
  if (kind === "cash-flow-statement") {
    const rowsOf = (arr) => arr.map((l) => `<tr><td>${esc(l.code)} ${esc(l.name)}</td><td class="num">${money(l.value)}</td></tr>`).join("");
    const sec = (title, arr, total) => `<tr class="strong"><td colspan="2">${title}</td></tr>${rowsOf(arr)}
      <tr class="total"><td>小计</td><td class="num">${money(total)}</td></tr>`;
    $("#reportOut").innerHTML = `<h3>现金流量表 · ${period} · ${esc(d.method)}${d.reconciles ? "" : ' <span style="color:#d03050">（与货币资金变动不平）</span>'}</h3>
      <div class="two-col">
        <table><thead><tr><th>项目</th><th class="num">金额</th></tr></thead><tbody>
          ${sec("一、经营活动产生的现金流量", d.operating, d.totals.operating)}
          ${sec("二、投资活动产生的现金流量", d.investing, d.totals.investing)}
          ${sec("三、筹资活动产生的现金流量", d.financing, d.totals.financing)}
          <tr class="total"><td>四、现金及现金等价物净增加额</td><td class="num">${money(d.totals.net_increase)}</td></tr>
          <tr><td>期初现金及现金等价物余额</td><td class="num">${money(d.cash.begin)}</td></tr>
          <tr><td>期末现金及现金等价物余额</td><td class="num">${money(d.cash.end)}</td></tr>
        </tbody></table>
        <table><thead><tr><th>补充资料（间接法）</th><th class="num">金额</th></tr></thead><tbody>
          ${Object.entries(d.supplement_indirect).map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, "："))}</td><td class="num">${money(v)}</td></tr>`).join("")}
        </tbody></table></div>`;
    return;
  }
  const R = (label, k) => `<tr><td>${label}</td><td class="num">${money(d.current[k])}</td><td class="num">${money(d.ytd[k])}</td></tr>`;
  $("#reportOut").innerHTML = `<h3>利润表 · ${period}</h3>
    <table><thead><tr><th>项目</th><th class="num">本期金额</th><th class="num">本年累计</th></tr></thead><tbody>
    ${R("一、营业收入", "营业收入")}${R("减：营业成本", "营业成本")}${R("税金及附加", "税金及附加")}
    ${R("销售费用", "销售费用")}${R("管理费用", "管理费用")}${R("财务费用", "财务费用")}
    ${R("加：投资收益", "投资收益")}<tr class="strong">${`<td>二、营业利润</td><td class="num">${money(d.current.营业利润)}</td><td class="num">${money(d.ytd.营业利润)}</td>`}</tr>
    ${R("加：营业外收入", "营业外收入")}${R("减：营业外支出", "营业外支出")}
    <tr class="strong"><td>三、利润总额</td><td class="num">${money(d.current.利润总额)}</td><td class="num">${money(d.ytd.利润总额)}</td></tr>
    ${R("减：所得税费用", "所得税费用")}
    <tr class="total"><td>四、净利润</td><td class="num">${money(d.current.净利润)}</td><td class="num">${money(d.ytd.净利润)}</td></tr>
    </tbody></table>`;
}

// ------------------------------------------------------------------ 期间
async function renderPeriods() {
  if (!SET_ID) return $("#periodList").innerHTML = "";
  const ps = await api(`/api/account-sets/${SET_ID}/periods`);
  $("#periodList").innerHTML = `<table><thead><tr><th>期间</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${ps.map((p) => `<tr><td>${p.period}</td><td><span class="badge ${p.status}">${p.status === "closed" ? "已结账" : "启用中"}</span></td>
      <td>${p.status === "closed" ? `<button data-p="${p.period}" data-s="open">反结账</button>` : `<button data-p="${p.period}" data-s="closed">结账</button>`}</td></tr>`).join("")}</tbody></table>`;
  $("#periodList").onclick = guard(async (ev) => {
    const b = ev.target.closest("button[data-p]"); if (!b) return;
    await api(`/api/account-sets/${SET_ID}/periods`, { method: "POST", body: { period: b.dataset.p, status: b.dataset.s } });
    await renderPeriods(); toast("期间状态已更新");
  });
}

// ------------------------------------------------------------------ 税局导入企业（福建省漳州市，人工登录）
// 采集草稿：真实登录尚未实测。全局单一会话 + 单一 dialog；所有税局操作串行（TB.busy）；
// 关闭（按钮或 Esc）结束本地会话、清空 preview/勾选/导入结果并移除 dialog；
// 每次异步写回前复核 dialog 生命周期（TB.lifecycle）与 sid，迟到响应不得污染新会话；
// 启动中取消时，迟到的会话返回后立即关闭；关闭失败保留安全重试引用（TB.pendingClose）。
const TB = {
  config: null, token: null, sessionId: null, session: null, preview: [], checked: new Set(),
  dialog: null, busy: false, closed: false,
  lifecycle: 0,            // dialog 生命周期序号：close / 新建 dialog 时递增，作废所有在途异步写回
  pendingClose: new Map(), // sid -> { attempts, inflight }：服务端关闭的安全引用（普通错误保留；inflight 为在途 close 请求，重开需先等待其确认）
};

const TB_TERMINAL_CODES = new Set([
  "tax_browser_session_closed", "tax_browser_session_expired", "tax_browser_session_not_found",
]);
/** 终态（404/409closed/410）：会话已关闭/过期/已清理，本地状态必须清空。 */
const tbIsTerminal = (e) => !!e && (TB_TERMINAL_CODES.has(e.code) || e.status === 404 || e.status === 410);

async function tbApi(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body === undefined ? (opts.method === "POST" ? JSON.stringify({}) : undefined) : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = typeof data.error === "string" ? data.error : ""; // 结构化错误码，不靠中文正则判断
    err.status = res.status;
    throw err;
  }
  return data;
}

async function tbFetchConfig() {
  const cfg = await tbApi("/api/tax-browser/config");
  TB.config = cfg;
  TB.token = cfg.loginToken;
  return cfg;
}

const tbCurrent = (d) => !!d && TB.dialog === d && d.isConnected !== false;
function tbStatus(d, text) { const el = tbCurrent(d) ? $("#tbStatus", d) : null; if (el) el.textContent = text || ""; }
function tbError(d, msg) { const el = tbCurrent(d) ? $("#tbError", d) : null; if (el) el.textContent = msg ? `⚠ ${msg}` : ""; }
const dlgOf = (btn) => btn.closest("dialog");

/** 清空本地采集会话状态（sessionId/session/preview/勾选），不触碰服务端。 */
function tbClearSession() { TB.sessionId = null; TB.session = null; TB.preview = []; TB.checked = new Set(); }
function tbHideImportResult(d) { const el = tbCurrent(d) ? $("#tbImportResult", d) : null; if (el) { el.classList.add("hidden"); el.textContent = ""; } }

/** 记录未确认关闭的安全引用（仅普通网络错误）；不自动重试，只在用户重开/重试时再试一次。 */
function tbTrackPendingClose(sid, rec) {
  if (!sid) return;
  const r = rec || TB.pendingClose.get(sid) || { attempts: 0 };
  r.attempts += 1;
  r.inflight = null; // 失败后清除在途标记，保留待办等待用户重开时再试一次
  TB.pendingClose.set(sid, r);
}
/** 真正发送 close 请求：发请求前已把该 sid（inflight 占位）登记进 pendingClose，
 *  使关闭未确认期间的「重开」必须先等待本确认。成功或终态（closed/expired/notfound）
 *  视为已清理；普通错误保留待办并返回 false。 */
function tbSendClose(sid) {
  const rec = TB.pendingClose.get(sid) || { attempts: 0 };
  rec.inflight = null;
  TB.pendingClose.set(sid, rec); // 发请求前登记在途引用：新开必须先 await，绝不并发绕过清理
  rec.inflight = (async () => {
    try {
      await tbApi(`/api/tax-browser/sessions/${sid}/close`, { method: "POST", body: {} });
      TB.pendingClose.delete(sid);
      return true;
    } catch (e) {
      if (tbIsTerminal(e)) { TB.pendingClose.delete(sid); return true; } // 终态即已清理
      tbTrackPendingClose(sid, rec);
      return false;
    }
  })();
  return rec.inflight;
}
/** 关闭单个已捕获会话：同一 sid 已有在途请求时复用之（等待其结果），绝不并发重复 close。 */
function tbTryClose(sid) {
  if (!sid) return Promise.resolve(true);
  const rec = TB.pendingClose.get(sid);
  if (rec && rec.inflight) return rec.inflight;
  return tbSendClose(sid);
}
/** 新开会话前清理所有待确认关闭引用（含在途，等待其确认）；仍有失败则返回 false，由调用方明确阻止新开。 */
async function tbFlushPendingCloses() {
  if (!TB.pendingClose.size) return true;
  let allOk = true;
  for (const sid of [...TB.pendingClose.keys()]) {
    if (!(await tbTryClose(sid))) allOk = false;
  }
  return allOk;
}

/** 统一 busy：同一时刻只允许一个税局操作，避免并发/交错覆盖同一会话。 */
async function withBusy(btn, fn) {
  if (TB.busy) return;
  TB.busy = true;
  const d = dlgOf(btn);
  const life = TB.lifecycle; // 捕获本次操作所属生命周期，迟到错误不得污染新会话
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "处理中…";
  try { await fn(); }
  catch (e) { tbFail(d, e, life); }
  finally {
    TB.busy = false;
    // dialog 已在操作期间关闭时不再恢复按钮，避免更新已移除的旧 dialog
    if (tbCurrent(d)) { btn.disabled = false; btn.textContent = old; }
  }
}

/** 失败处理：终态清空本地会话与预览，避免孤儿数据残留；普通错误保留可重试的 sessionId。
 *  life 为发起操作时捕获的生命周期；与当前不一致说明 dialog/session 已更换，只提示、绝不清理新状态。 */
function tbFail(d, e, life) {
  const stale = life !== undefined && life !== TB.lifecycle;
  if (!stale && tbIsTerminal(e)) { tbClearSession(); tbHideImportResult(d); tbRenderPreview(d); }
  if (tbCurrent(d)) tbError(d, e.message || String(e)); else toast(e.message || String(e), true);
}

async function tbOpenSession(d) {
  const life = TB.lifecycle; // 捕获入口 dialog 生命周期：清理/取令牌期间被取消则不得再开新会话
  const alive = () => TB.lifecycle === life && !TB.closed && tbCurrent(d);
  if (TB.sessionId) { tbStatus(d, "采集会话已打开：请直接读取企业页；如需重开请先关闭当前会话。"); return; }
  // 新开会话前先等待/重试未确认关闭的旧会话（含在途）；仍失败则明确阻止，避免同时留下多个难以回收的会话
  if (!(await tbFlushPendingCloses())) {
    throw new Error("上一次采集会话尚未确认关闭，已重试仍失败；请稍后再试，确认清理后再开启新会话。");
  }
  if (!alive()) return; // 清理期间窗口已关闭/换新：取消后不得在清理完成后继续打开
  const body = { region: "350000", city: "350600" };
  const start = (loginToken) => tbApi("/api/tax-browser/sessions", { method: "POST", body: { ...body, loginToken } });
  let res;
  try {
    const token = TB.token || (await tbFetchConfig()).loginToken;
    if (!alive()) return; // 取令牌后、发 sessions POST 前复核：取消期间不得打开新浏览器
    res = await start(token);
  } catch (e) {
    // 一次性令牌失效按结构化错误码重取一次；其余错误（含暂时网络错误）原样抛出，不掩盖
    if (e.code !== "tax_browser_login_token_invalid") throw e;
    const token = (await tbFetchConfig()).loginToken;
    if (!alive()) return; // 重取令牌后、发 sessions POST 前复核：取消期间不得打开新浏览器
    res = await start(token);
  }
  TB.token = null; // 已消费
  // 启动期间用户可能已关闭 dialog/取消：迟到的会话必须立刻关闭；关闭失败要记录待办，绝不静默留孤儿
  if (TB.closed || !tbCurrent(d)) {
    const ok = await tbTryClose(res.sessionId);
    if (!ok) toast("新会话启动期间窗口已关闭，且服务端关闭未确认；已保留重试引用，重开时会先重试。", true);
    return;
  }
  TB.sessionId = res.sessionId;
  TB.session = res;
  TB.preview = [];
  TB.checked = new Set();
  tbHideImportResult(d);
  tbRenderPreview(d);
  tbError(d, "");
  const tips = (res.manualLogin && res.manualLogin.instructions ? res.manualLogin.instructions : []).join(" ");
  tbStatus(d, `已打开官方登录窗口（真实登录尚未验收）。${tips}`);
}

async function tbRead(d) {
  const life = TB.lifecycle;
  const sid = TB.sessionId;
  if (TB.closed || !tbCurrent(d)) return;
  if (!sid) throw new Error("请先点击「打开官方登录窗口」");
  const res = await tbApi(`/api/tax-browser/sessions/${sid}/read`, { method: "POST", body: {} });
  // 异步写回前复核：本次 dialog 生命周期未变、会话仍是同一 sid；关闭/换会话后不得复活旧数据
  if (TB.lifecycle !== life || TB.closed || !tbCurrent(d) || TB.sessionId !== sid) return;
  TB.session = res.session;
  TB.preview = res.read.items || [];
  // 保留此前勾选（候选 ID 稳定，按税号合并）
  const known = new Set(TB.preview.map((it) => it.candidateId));
  TB.checked = new Set([...TB.checked].filter((cid) => known.has(cid)));
  tbRenderPreview(d);
  tbError(d, "");
  const notAll = res.read.note || "";
  tbStatus(d, `已读取 ${res.read.pagesRead} 次页面 · 累计识别 ${res.read.count} 家企业（本次新增 ${res.newCount}）· 来源 ${res.read.source || "—"}。${notAll}候选企业仅为页面采集草稿，不代表税局全部企业或财务数据。`);
}

/** 关闭本地采集会话：清空 session/preview/勾选/导入结果，立即移除 dialog，再通知服务端关闭。
 *  关闭失败仍清空本地状态并移除 dialog，但把 sid 记入安全重试引用（不吞掉、可重开时重试）。 */
async function tbClose(d) {
  TB.closed = true;
  TB.lifecycle += 1; // 作废所有在途异步写回（read/import/open），防止关闭后内存重新出现企业
  const sid = TB.sessionId;
  tbClearSession();
  tbHideImportResult(d);
  tbRenderPreview(d);
  tbError(d, "");
  tbRemoveDialog(d); // 先移除 dialog，避免关闭请求慢时“重新打开”被旧 dialog 覆盖
  if (sid) {
    const ok = await tbTryClose(sid);
    if (!ok) toast("本地会话已清除；服务端关闭未确认，已保留安全重试引用，重开时会先重试。", true);
  }
}

function tbRemoveDialog(d) {
  if (TB.dialog === d) TB.dialog = null;
  if (d.open) d.close(); else d.remove();
}

function tbRenderPreview(d) {
  if (!tbCurrent(d)) return;
  const el = $("#tbPreview", d);
  if (!el) return;
  if (!TB.preview.length) {
    el.innerHTML = `<p class="hint">尚未识别到企业：请在浏览器窗口登录并打开「办税员可访问企业」列表页，再点「读取当前企业页」；可翻页后多次读取，按税号合并。</p>`;
    return;
  }
  const allChecked = TB.preview.every((it) => TB.checked.has(it.candidateId));
  el.innerHTML = `<table><thead><tr>
      <th><input type="checkbox" id="tbAll" ${allChecked ? "checked" : ""} /></th>
      <th>企业名称</th><th>纳税人识别号</th><th>出现页次</th><th>首次读取</th></tr></thead><tbody>
    ${TB.preview.map((it) => `<tr>
      <td><input type="checkbox" data-cid="${esc(it.candidateId)}" ${TB.checked.has(it.candidateId) ? "checked" : ""} /></td>
      <td>${esc(it.name)}</td><td>${esc(it.taxpayerId)}</td><td>${it.occurrences}</td>
      <td>${esc(String(it.firstSeenAt || "").replace("T", " ").slice(0, 19))}</td></tr>`).join("")}
    </tbody></table>`;
  $("#tbAll", el).onchange = (ev) => {
    TB.checked = ev.target.checked ? new Set(TB.preview.map((it) => it.candidateId)) : new Set();
    tbRenderPreview(d);
  };
  el.onclick = (ev) => {
    const cb = ev.target.closest("input[data-cid]");
    if (!cb) return;
    if (cb.checked) TB.checked.add(cb.dataset.cid); else TB.checked.delete(cb.dataset.cid);
  };
}

function tbShowResult(d, r) {
  if (!tbCurrent(d)) return;
  const el = $("#tbImportResult", d);
  el.classList.remove("hidden");
  const s = r.summary || {};
  const lines = (r.results || []).map((x) =>
    `${x.action === "created" ? "新建空账套" : x.action === "existing" ? "已存在（跳过）" : x.action === "bind" ? "绑定空账套" : x.action === "bound_idempotent" ? "已绑定（幂等）" : x.action} · ${x.name}（${x.taxpayerId}） → 账套 #${x.accountSetId}${x.nameChange ? ` · 名称「${x.nameChange.from}」→「${x.nameChange.to}」` : ""}`
  ).join("\n");
  el.textContent = `导入完成：新建 ${s.created ?? 0} / 已存在 ${s.existing ?? 0} / 绑定 ${s.bound ?? 0}。\n${lines}\n提示：本次仅建立企业基本档案，历史凭证、期初余额需另行导入。`;
}

async function tbImport(d) {
  if (TB.closed || !tbCurrent(d)) return;
  if (!TB.sessionId) throw new Error("请先打开官方登录窗口并读取企业");
  const life = TB.lifecycle;
  const sid = TB.sessionId;
  // 每次异步返回后复核：dialog 生命周期/会话未变，才能继续弹确认或实际导入；成功结果也不回填已关闭/其他 dialog
  const alive = () => TB.lifecycle === life && !TB.closed && tbCurrent(d) && TB.sessionId === sid;
  const cids = [...TB.checked];
  if (!cids.length) throw new Error("请先勾选要导入的企业");
  const mode = $("#tbMode", d).value;
  const path = `/api/tax-browser/sessions/${sid}/import`;
  if (mode === "create") {
    const create = {
      start_period: $("#tbStart", d).value,
      accounting_standard: $("#tbStd", d).value,
      taxpayer_type: $("#tbType", d).value,
    };
    if (!create.start_period) throw new Error("请先选择启用期间（建账参数由您确认，非税局数据）");
    const prev = await tbApi(path, { method: "POST", body: { candidateIds: cids, mode: "create", create, dryRun: true } });
    if (!alive()) return; // dryRun 返回时已关闭/换会话：不再弹确认、不再实际导入
    const ok = confirm(
      `确认导入勾选的 ${cids.length} 家企业？\n` +
      `新建空账套 ${prev.summary.created} 个；税号已存在跳过 ${prev.summary.existing} 个。\n` +
      `启用期间 ${create.start_period} · ${create.accounting_standard} · ${create.taxpayer_type}（本地选择，非税局数据）\n` +
      `仅建立企业基本档案，不生成凭证与期初。`
    );
    if (!ok) return;
    if (!alive()) return;
    const r = await tbApi(path, { method: "POST", body: { candidateIds: cids, mode: "create", create } });
    if (!alive()) return; // 成功结果到达时 dialog 已关闭/换会话：不回填、不刷新、不提示
    tbShowResult(d, r);
    await loadSets().catch(() => {}); // 账套列表刷新失败不丢失已完成的导入结果
    toast(`已从税局导入 ${r.summary.created} 家企业（新建空账套）`);
  } else {
    if (cids.length !== 1) throw new Error("绑定模式一次只能勾选 1 家企业（批量请用「批量新建空账套」）");
    const accountSetId = Number($("#tbBindSet", d).value);
    if (!accountSetId) throw new Error("请选择要绑定的空账套");
    const prev = await tbApi(path, { method: "POST", body: { candidateIds: cids, mode: "bind", accountSetId, dryRun: true } });
    if (!alive()) return;
    let r;
    if (prev.idempotent) {
      r = prev;
    } else {
      const change = prev.results && prev.results[0] && prev.results[0].nameChange;
      if (change) {
        const ok = confirm(`账套名称将与税局登记名称同步：\n「${change.from}」 →「${change.to}」\n确认修改账套名称？`);
        if (!ok) return;
        if (!alive()) return;
        r = await tbApi(path, { method: "POST", body: { candidateIds: cids, mode: "bind", accountSetId, confirmNameChange: true } });
      } else {
        r = await tbApi(path, { method: "POST", body: { candidateIds: cids, mode: "bind", accountSetId } });
      }
    }
    if (!alive()) return;
    tbShowResult(d, r);
    await loadSets().catch(() => {}); // 账套列表刷新失败不丢失已完成的导入结果
    toast("已绑定企业基本信息");
  }
}

function taxBrowserDialog({ bindSetId = null } = {}) {
  if (TB.dialog) { // 单一 dialog：重复打开只复用当前窗口，不叠加、不覆盖 sessionId
    if (!TB.dialog.open) TB.dialog.showModal();
    return TB.dialog;
  }
  const d = document.createElement("dialog");
  TB.dialog = d;
  TB.closed = false; // 新的 dialog 生命周期：允许开启新的采集会话
  TB.lifecycle += 1; // 新生命周期起点，作废上一 dialog 的在途异步写回
  d.style.minWidth = "780px";
  d.innerHTML = `
    <h3>税局导入企业（电子税务局 · 人工登录）</h3>
    <div class="hint">【福建漳州试用】登录与企业读取尚未实测；本次只建立企业档案/空账套，凭证与期初余额需另行导入。</div>
    <div class="row">
      <label>地区
        <select id="tbRegion" disabled>
          <option value="350000/350600">福建省 · 漳州市</option>
        </select>
      </label>
      <span class="hint">其他地区未支持；全国接入是后续目标，当前不代表已接入税局。</span>
    </div>
    <h4>建账参数（由您本地确认，非税局返回数据）</h4>
    <div class="row">
      <label>启用期间 <input type="month" id="tbStart" /></label>
      <label>会计准则 <select id="tbStd">${META.standards.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
      <label>纳税人类型 <select id="tbType"><option>小规模纳税人</option><option>一般纳税人</option></select></label>
    </div>
    <div class="row">
      <button id="tbLogin" class="primary">打开官方登录窗口</button>
      <button id="tbRead">我已登录，读取当前企业页</button>
      <button id="tbCloseBtn" class="danger">关闭本地采集会话</button>
    </div>
    <div id="tbStatus" class="hint"></div>
    <div id="tbError" style="color:#d03050;white-space:pre-wrap"></div>
    <div id="tbPreview" class="card"></div>
    <h4>导入方式</h4>
    <div class="row">
      <label>方式
        <select id="tbMode">
          <option value="create">勾选企业批量新建空账套</option>
          <option value="bind" ${bindSetId ? "selected" : ""}>绑定到已有空账套</option>
        </select>
      </label>
      <label id="tbBindWrap" class="${bindSetId ? "" : "hidden"}">目标账套 <select id="tbBindSet"></select></label>
    </div>
    <div id="tbImportResult" class="card hidden" style="white-space:pre-wrap"></div>
    <div class="row" style="justify-content:flex-end">
      <button id="tbCancel">关闭</button>
      <button id="tbImport" class="primary">导入所选企业</button>
    </div>`;
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener("close", () => { d.remove(); if (TB.dialog === d) TB.dialog = null; });
  // Esc / 点 X：先结束本地会话、清空预览与导入结果，再移除 dialog（不依赖按钮状态恢复）
  d.addEventListener("cancel", (ev) => { ev.preventDefault?.(); void tbClose(d); });
  $("#tbCancel", d).onclick = () => void tbClose(d);
  $("#tbMode", d).onchange = () => {
    const bind = $("#tbMode", d).value === "bind";
    $("#tbBindWrap", d).classList.toggle("hidden", !bind);
  };
  const fillBindSets = () => {
    $("#tbBindSet", d).innerHTML = SETS.length
      ? SETS.map((s) => `<option value="${s.id}">${esc(s.name)}（${esc(s.start_period)}）</option>`).join("")
      : `<option value="">（暂无账套）</option>`;
    if (bindSetId) $("#tbBindSet", d).value = String(bindSetId);
  };
  fillBindSets();
  tbRenderPreview(d);
  tbStatus(d, "尚未打开采集会话。先选择建账参数（导入时确认），再点「打开官方登录窗口」。");
  $("#tbLogin", d).onclick = (ev) => withBusy(ev.target, () => tbOpenSession(d));
  $("#tbRead", d).onclick = (ev) => withBusy(ev.target, () => tbRead(d));
  $("#tbCloseBtn", d).onclick = () => void tbClose(d); // 关闭本地采集会话并移除 dialog
  $("#tbImport", d).onclick = (ev) => withBusy(ev.target, () => tbImport(d));
  return d;
}

// ------------------------------------------------------------------ 事件
$$(".tabs button").forEach((b) => b.onclick = () => {
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
});
$("#accountSetSelect").onchange = guard(async () => { SET_ID = +$("#accountSetSelect").value; await selectSet(); });
$("#btnNewSet").onclick = newSetDialog;
$("#btnImportSet").onclick = importSetDialog;
$("#btnTaxImport").onclick = () => taxBrowserDialog();
$("#btnLoadVouchers").onclick = guard(loadVouchers);
$("#btnNewVoucher").onclick = () => { if (!SET_ID) return toast("请先新建账套", true); openEditor(null); };
$("#btnAddAccount").onclick = addAccountDialog;
$("#btnAddAsset").onclick = addAssetDialog;
$("#btnDepreciate").onclick = guard(async () => {
  const p = $("#aPeriod").value; if (!p) return toast("请选择计提期间", true);
  const r = await api(`/api/account-sets/${SET_ID}/depreciation`, { method: "POST", body: { period: p } });
  await renderAssets(); await loadVouchers();
  toast(r.voucher ? `已计提，凭证 记-${r.voucher.number}` : (r.note || "无计提"));
});
$("#btnCarryForward").onclick = guard(async () => {
  const p = $("#pPeriod").value; if (!p) return toast("请选择期间", true);
  const r = await api(`/api/account-sets/${SET_ID}/carry-forward`, { method: "POST", body: { period: p } });
  await loadVouchers(); await renderPeriods();
  toast(r.voucher ? `已结转损益，净利润 ${money(r.profit)}` : (r.note || "无损益"));
});
$("#btnSaveOpening").onclick = saveOpening;
$("#btnRunReport").onclick = guard(runReport);
$("#btnExportReport").onclick = guard(downloadReport);
$("#rKind").onchange = () => { $("#rCodeWrap").classList.toggle("hidden", $("#rKind").value !== "ledger"); };
$("#btnPrint").onclick = () => window.print();
$("#btnAddPeriod").onclick = guard(async () => {
  const p = $("#pPeriod").value; if (!p) return toast("请选择期间", true);
  await api(`/api/account-sets/${SET_ID}/periods`, { method: "POST", body: { period: p, status: "open" } });
  await renderPeriods(); toast("期间已登记");
});
bindVoucherActions($("#voucherList"));

(async function boot() {
  try { await loadMeta(); await loadSets(); } catch (e) { toast(e.message, true); }
})();
