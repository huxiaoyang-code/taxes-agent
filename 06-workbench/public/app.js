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
  if (SET) {
    const info = $("#setMeta");
    info.append(document.createTextNode(SET.enterprise ? ' · 企业身份 ' + SET.enterprise.enterpriseKey : ' · 企业身份未关联'));
    if (!SET.enterprise) {
      const bind = document.createElement('button'); bind.id = 'btnBindEnterprise'; bind.textContent = '关联企业身份';
      bind.onclick = bindEnterpriseDialog; info.append(bind);
    }
  }
  for (const id of ["#vPeriod", "#rPeriod", "#aPeriod", "#pPeriod"]) { const el = $(id); if (!el.value) el.value = SET?.start_period || thisMonth(); }
  renderAccounts(); renderOpening(); await loadVouchers(); renderPeriods(); await renderAssets();
  fillCodeSelect();
  $("#btnExportReport").disabled = !SET_ID;
  $("#reportExportStatus").textContent = "";
  $("#reportOut").innerHTML = "";
  $("#reportWarnings").textContent = "";
}
function bindEnterpriseDialog() {
  if (!SET_ID || SET?.enterprise) return;
  const target = SET_ID;
  const d = document.createElement('dialog');
  d.innerHTML = '<h3>关联历史账套企业身份</h3><p>请核实这是本企业账套；确认关联不会改变原账务，也不能强制换绑。</p>'
    + '<label>稳定企业身份 <input id="bindKey" /></label>'
    + '<label><input type="checkbox" id="bindConfirm" />我已核实并确认此账套属于该企业</label>'
    + '<button id="bindCancel">取消</button><button id="bindOk">确认关联</button>';
  document.body.appendChild(d); d.showModal(); d.addEventListener('close', () => d.remove());
  $('#bindCancel', d).onclick = () => d.close();
  $('#bindOk', d).onclick = guard(async () => {
    await api('/api/account-sets/' + target + '/enterprise', { method: 'POST', body: {
      enterprise: { enterpriseKey: $('#bindKey', d).value }, confirmNewBinding: $('#bindConfirm', d).checked,
    } });
    d.close(); await loadSets(target); toast('企业身份已关联');
  });
}
function newSetDialog() {
  const d = document.createElement("dialog");
  d.innerHTML = `
    <h3>新建账套</h3>
    <div class="row"><label>稳定企业身份 <input id="nsEnterpriseKey" placeholder="统一社会信用代码或稳定的本机企业编号" required /></label></div>
    <p class="hint">一家企业一个账套。已有同企业账套请在首页账套列表选择；显示名称不参与身份判断。</p>
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
      enterprise: { enterpriseKey: $("#nsEnterpriseKey", d).value },
      name: $("#nsName", d).value.trim(), taxpayer_type: $("#nsTax", d).value,
      accounting_standard: $("#nsStd", d).value, start_period: $("#nsStart", d).value } });
    d.close(); await loadSets(set.id); toast("账套已创建，已载入标准科目表");
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
    <div class="row"><label>稳定企业身份 <input id="impEnterpriseKey" required /></label></div>
    <p class="hint">首次导入会创建企业唯一账套；已有同企业账套时拒绝。已有绑定：${SETS.filter(s => s.enterprise).map(s => esc(s.enterprise.enterpriseKey) + ' → #' + s.id + ' ' + esc(s.name)).join('；') || '暂无'}</p>
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
  const enterprise = () => ({ enterpriseKey: $("#impEnterpriseKey", d).value });
  d.addEventListener("input", () => { $("#impConfirm", d).disabled = true; });
  d.addEventListener("change", () => { $("#impConfirm", d).disabled = true; });
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
      const r = await api("/api/import/account-set", { method: "POST", body: { payload, enterprise: enterprise(), dryRun: true } });
      showValidation(r.validation); $("#impConfirm", d).disabled = !r.validation.ok; return;
    }
    const files = { meta: $("#impMeta", d).files[0], accounts: $("#impAccounts", d).files[0],
      openings: $("#impOpenings", d).files[0], vouchers: $("#impVouchers", d).files[0] };
    if (!Object.values(files).some(Boolean)) return toast("请选择 JSON 或至少一张 CSV", true);
    const texts = {};
    for (const [k, f] of Object.entries(files)) if (f) texts[k] = await readFileText(f, enc);
    const r = await api("/api/import/parse", { method: "POST", body: { texts, enterprise: enterprise() } });
    payload = r.payload; showValidation(r.validation); $("#impConfirm", d).disabled = !r.validation.ok;
    if (r.validation.ok) toast("预检通过，可确认导入"); else toast("预检未通过，见下方错误", true);
  });
  $("#impConfirm", d).onclick = guard(async () => {
    const r = await api("/api/import/account-set", { method: "POST", body: { payload, enterprise: enterprise(), dryRun: false } });
    if (!r.created) { showValidation(r.validation); $("#impConfirm", d).disabled = true; return; }
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
const REPORT_FORMATS = {
  csv: {
    label: "CSV", extension: ".csv",
    mime: /^text\/csv\b/i,
    magic: (bytes) => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    magicError: "服务器返回的内容不是带 UTF-8 BOM 的 CSV，下载已取消",
  },
  xlsx: {
    label: "Excel 工作簿", extension: ".xlsx",
    mime: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i,
    magic: (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
    magicError: "服务器返回的内容不是有效的 Excel（XLSX）工作簿，下载已取消",
  },
  pdf: {
    label: "PDF", extension: ".pdf",
    mime: /^application\/pdf\b/i,
    magic: (bytes) => bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-",
    magicError: "服务器返回的内容不是有效的 PDF 文档，下载已取消",
  },
};
// Fixed user-facing wording: never render server stack traces, environment details or font paths.
const REPORT_ERROR_MESSAGES = {
  period_required: "请选择报表期间", period_invalid: "报表期间格式不正确", period_before_start: "期间早于账套启用期间",
  period_not_registered: "该期间尚未登记，请先在期间页登记", account_set_not_found: "账套不存在，请重新选择",
  account_code_required: "请选择明细账科目", account_not_found: "所选科目不存在，请重新选择",
  report_kind_unsupported: "不支持此报表类型", report_format_unsupported: "不支持此导出格式",
  report_data_invalid: "报表金额数据异常（含非有限数值），已取消导出",
  office_text_too_long: "报表中有字段超过单格长度上限，无法生成该格式；请缩短账套名称、科目名称或摘要后重试",
  pdf_font_unavailable: "服务器缺少可嵌入的中文字体，暂时无法生成 PDF；请改用 CSV 或 Excel",
  pdf_font_glyph_missing: "当前中文字体缺少报表所需字符，无法生成 PDF；请改用 CSV 或 Excel",
  report_export_failed: "服务器生成报表失败，请稍后重试",
};
function reportErrorMessage(error, status) {
  if (error && typeof error.error === "string" && REPORT_ERROR_MESSAGES[error.error]) return REPORT_ERROR_MESSAGES[error.error];
  if (status >= 500 || !error?.message) return `导出失败（HTTP ${status}），请稍后重试`;
  return String(error.message);
}
function fillCodeSelect() { $("#rCode").innerHTML = ACCOUNTS.map((a) => `<option value="${a.code}">${a.code} ${esc(a.name)}</option>`).join(""); }
async function downloadReport() {
  const status = $("#reportExportStatus"), button = $("#btnExportReport"), formatSelect = $("#rFormat");
  status.textContent = "";
  if (!SET_ID) { status.textContent = "请先选择或新建账套"; return; }
  const kind = $("#rKind").value, period = $("#rPeriod").value, code = $("#rCode").value;
  const format = formatSelect.value, spec = REPORT_FORMATS[format];
  const source = `${SET?.name || `账套 ${SET_ID}`} · ${period}`;
  if (!spec) { status.textContent = "请选择导出格式"; return; }
  if (!period) { status.textContent = "请选择报表期间"; return; }
  if (kind === "ledger" && !code) { status.textContent = "请选择明细账科目"; return; }
  const query = new URLSearchParams({ period, format });
  if (kind === "ledger") query.set("code", code);
  button.disabled = true; formatSelect.disabled = true;
  status.textContent = `正在生成 ${spec.label}…`;
  try {
    const response = await fetch(`/api/account-sets/${SET_ID}/reports/${kind}/export?${query}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(reportErrorMessage(error, response.status));
    }
    // Check the declared type before reading bytes: an HTML/JSON error page must never be saved as a report.
    const contentType = response.headers.get("content-type") || "";
    if (!spec.mime.test(contentType)) throw new Error(`服务器返回的类型不是 ${spec.label}，下载已取消`);
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : `${kind}-${period}${spec.extension}`;
    if (!filename.toLowerCase().endsWith(spec.extension)) throw new Error(`服务器返回的文件名与所选格式（${spec.label}）不一致，下载已取消`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null && Number(lengthHeader) !== bytes.length) throw new Error("下载内容不完整（长度与响应头不一致），已取消保存");
    if (!spec.magic(bytes)) throw new Error(spec.magicError);
    const blob = new Blob([bytes], { type: contentType });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `${source}：${spec.label} 已生成并开始下载（仅供内部使用，非税局申报文件）`;
  } catch (e) {
    status.textContent = `${source}：导出失败：${e.message}`;
    toast(status.textContent, true);
  } finally {
    button.disabled = !SET_ID;
    formatSelect.disabled = false;
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

// ------------------------------------------------------------------ 事件
$$(".tabs button").forEach((b) => b.onclick = () => {
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
});
$("#accountSetSelect").onchange = guard(async () => { SET_ID = +$("#accountSetSelect").value; await selectSet(); });
$("#btnNewSet").onclick = newSetDialog;
$("#btnImportSet").onclick = importSetDialog;
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
