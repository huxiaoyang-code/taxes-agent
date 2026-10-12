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
  for (const id of ["#vPeriod", "#rPeriod"]) { const el = $(id); if (!el.value) el.value = SET?.start_period || thisMonth(); }
  renderAccounts(); renderOpening(); await loadVouchers(); renderPeriods();
  fillCodeSelect();
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
      <button id="nsCancel">取消</button><button id="nsOk" class="primary">创建</button>
    </div>`;
  document.body.appendChild(d);
  d.showModal();
  $("#nsCancel", d).onclick = () => d.close();
  d.addEventListener("close", () => d.remove());
  $("#nsOk", d).onclick = guard(async () => {
    const set = await api("/api/account-sets", { method: "POST", body: {
      name: $("#nsName", d).value.trim(), taxpayer_type: $("#nsTax", d).value,
      accounting_standard: $("#nsStd", d).value, start_period: $("#nsStart", d).value } });
    d.close(); await loadSets(set.id); toast("账套已创建，已载入标准科目表");
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

// ------------------------------------------------------------------ 报表
function fillCodeSelect() { $("#rCode").innerHTML = ACCOUNTS.map((a) => `<option value="${a.code}">${a.code} ${esc(a.name)}</option>`).join(""); }
async function runReport() {
  if (!SET_ID) return toast("请先新建账套", true);
  const kind = $("#rKind").value, period = $("#rPeriod").value;
  $("#rCodeWrap").classList.toggle("hidden", kind !== "ledger");
  if (kind === "ledger") {
    const code = $("#rCode").value;
    const d = await api(`/api/account-sets/${SET_ID}/ledger?code=${code}&period=${period}`);
    $("#reportOut").innerHTML = `<h3>明细账 · ${esc(d.code)} ${esc(d.name)}</h3>
      <table><thead><tr><th>期间</th><th>凭证</th><th>摘要</th><th class="num">借方</th><th class="num">贷方</th><th class="num">余额</th></tr></thead><tbody>
      <tr class="strong"><td colspan="3">期初余额</td><td class="num">${money(d.opening.debit)}</td><td class="num">${money(d.opening.credit)}</td><td class="num"></td></tr>
      ${d.items.map((it) => `<tr><td>${it.period}</td><td>${it.word}-${String(it.number).padStart(3, "0")}</td><td>${esc(it.summary || it.vsummary)}</td>
        <td class="num">${money(it.debit)}</td><td class="num">${money(it.credit)}</td><td class="num">${money(it.balance)}</td></tr>`).join("")}
      </tbody></table>`;
    return;
  }
  const d = await api(`/api/account-sets/${SET_ID}/reports/${kind}?period=${period}`);
  if (kind === "trial-balance") {
    $("#reportOut").innerHTML = `<h3>科目余额表 · ${period}</h3>
      <table><thead><tr><th>编码</th><th>名称</th><th class="num">期初借</th><th class="num">期初贷</th>
      <th class="num">本期借</th><th class="num">本期贷</th><th class="num">期末借</th><th class="num">期末贷</th></tr></thead><tbody>
      ${d.lines.map((l) => `<tr><td>${l.code}</td><td>${esc(l.name)}</td><td class="num">${money(l.opening_debit)}</td><td class="num">${money(l.opening_credit)}</td>
        <td class="num">${money(l.period_debit)}</td><td class="num">${money(l.period_credit)}</td><td class="num">${money(l.closing_debit)}</td><td class="num">${money(l.closing_credit)}</td></tr>`).join("")}
      <tr class="total"><td colspan="2">合计</td><td class="num">${money(d.totals.opening_debit)}</td><td class="num">${money(d.totals.opening_credit)}</td>
        <td class="num">${money(d.totals.period_debit)}</td><td class="num">${money(d.totals.period_credit)}</td>
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

// ------------------------------------------------------------------ 事件
$$(".tabs button").forEach((b) => b.onclick = () => {
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
});
$("#accountSetSelect").onchange = guard(async () => { SET_ID = +$("#accountSetSelect").value; await selectSet(); });
$("#btnNewSet").onclick = newSetDialog;
$("#btnLoadVouchers").onclick = guard(loadVouchers);
$("#btnNewVoucher").onclick = () => { if (!SET_ID) return toast("请先新建账套", true); openEditor(null); };
$("#btnAddAccount").onclick = addAccountDialog;
$("#btnSaveOpening").onclick = saveOpening;
$("#btnRunReport").onclick = guard(runReport);
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
