export function parseCsv(text, lineNumbers) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQ = false, line = 1, start = 1;
  function finishRow() {
    row.push(field);
    if (row.some(cell => cell.trim() !== "")) {
      rows.push(row);
      lineNumbers?.push(start);
    }
    row = []; field = ""; start = line + 1;
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") finishRow();
    else if (c !== "\r") field += c;
    if (c === "\n") line++;
  }
  if (field !== "" || row.length) finishRow();
  return rows;
}
