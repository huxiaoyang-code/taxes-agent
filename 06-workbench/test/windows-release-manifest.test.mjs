#!/usr/bin/env node
// Focused source-bundle tests. All fixtures (including refusals) are retained; no cleanup is attempted.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const WORKBENCH = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(WORKBENCH);
const uuid = randomUUID();
const root = process.env.WINDOWS_RELEASE_MANIFEST_TEST_ROOT || join(WORKBENCH, "tmp", "w2a", uuid);
assert(isAbsolute(root));
assert(/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(root), "fixture root must end in a full fresh UUID");
function auditAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      assert(!stat.isSymbolicLink() && stat.isDirectory(), `plain ancestor required: ${current}`);
      assert.equal(fs.realpathSync(current).toLowerCase(), current.toLowerCase());
    }
    if (dirname(current) === current) break;
  }
}
auditAncestors(root);
assert(!fs.existsSync(root), "never reuse a fixture root");
fs.mkdirSync(root, { recursive: true });
auditAncestors(root);
// Set the complete scope before importing delivery or any business-adjacent module.
process.env.TEMP = join(root, "tmp");
process.env.TMP = join(root, "tmp");
process.env.WORKBENCH_DATA_DIR = join(root, "fallback-data");
process.env.KEEP_FIXTURES = "1";
process.env.WORKBENCH_TEST_KEEP_FIXTURES = "1";
fs.mkdirSync(process.env.TEMP);
const {
  inspectRelease, inspectReleaseBundle, copyReleaseWhitelist, validateReleaseManifest,
  REQUIRED_BUNDLE_FILES, RELEASE_BUNDLE_MANIFEST, digestTree, parseArgs,
} = await import("../scripts/windows-delivery-check.mjs");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const children = [];
let sequence = 0;
const next = (label) => join(root, `${++sequence}-${label}`);
// Seed real, verified whitelist bytes inside our owned root. Source and cold destination are siblings,
// so the default in-repository fixture obeys the same containment guard as an external fixture.
const repositorySource = inspectReleaseBundle(REPO);
const sourceRoot = join(root, "source");
fs.mkdirSync(sourceRoot);
for (const entry of repositorySource.bundleManifest.files) {
  const source = join(REPO, entry.path);
  auditAncestors(dirname(source));
  const before = fs.lstatSync(source);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const buffer = fs.readFileSync(source);
  const afterRead = fs.lstatSync(source);
  assert.equal(afterRead.dev, before.dev);
  assert.equal(afterRead.ino, before.ino);
  assert.equal(afterRead.mtimeMs, before.mtimeMs);
  assert.equal(afterRead.ctimeMs, before.ctimeMs);
  assert(afterRead.isFile() && !afterRead.isSymbolicLink() && afterRead.nlink === 1);
  auditAncestors(dirname(source));
  assert.equal(buffer.length, entry.bytes);
  assert.equal(sha(buffer), entry.sha256);
  const target = join(sourceRoot, entry.path);
  auditAncestors(dirname(target));
  fs.mkdirSync(dirname(target), { recursive: true });
  auditAncestors(dirname(target));
  fs.writeFileSync(target, buffer, { flag: "wx" });
  assert.equal(sha(fs.readFileSync(target)), entry.sha256);
}
assert.equal(inspectReleaseBundle(REPO).bundleDigest, repositorySource.bundleDigest);
const original = inspectReleaseBundle(sourceRoot);
assert.deepEqual(original.bundleManifest, repositorySource.bundleManifest);
const cold = copyReleaseWhitelist(original, next("cold"), { fullBundle: true });
const coldSource = () => inspectReleaseBundle(cold.destRoot);
function expectNoCopy(source, target, code) {
  assert.throws(() => copyReleaseWhitelist(source, target, { fullBundle: true }), code ? { code } : undefined);
  assert(!fs.existsSync(target), "rejection must precede destination creation");
}
function resign(manifest) {
  manifest.digest = sha(JSON.stringify({ schemaVersion: manifest.schemaVersion, kind: manifest.kind, packageVersion: manifest.packageVersion, files: manifest.files }));
}
function cloneCold(label) { return copyReleaseWhitelist(coldSource(), next(label), { fullBundle: true }); }

async function child(script, args, input = "") {
  const result = { script: script.slice(cold.destRoot.length + 1), args, exitObserved: false, closeObserved: false, timedOut: false, stdout: "", stderr: "" };
  children.push(result);
  await new Promise((done, reject) => {
    const env = {};
    for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec"]) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { TEMP: process.env.TEMP, TMP: process.env.TMP, WORKBENCH_DATA_DIR: process.env.WORKBENCH_DATA_DIR,
      KEEP_FIXTURES: "1", WORKBENCH_TEST_KEEP_FIXTURES: "1", NODE_OPTIONS: "", FINANCE_API_BASE: "http://127.0.0.1:1" });
    const owned = spawn(process.execPath, [script, ...args], { cwd: cold.workbenchDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let hard;
    const timer = setTimeout(() => {
      result.timedOut = true;
      owned.kill();
      hard = setTimeout(() => { owned.stdout.destroy(); owned.stderr.destroy(); owned.unref(); reject(new Error("owned child did not close")); }, 5000);
    }, 15000);
    owned.once("error", (error) => { result.spawnError = error.code; });
    owned.once("exit", (code, signal) => { result.exitObserved = true; result.exitCode = code; result.exitSignal = signal; });
    owned.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(hard);
      result.closeObserved = true; result.closeCode = code; result.closeSignal = signal;
      done();
    });
    owned.stdout.on("data", (buffer) => { result.stdout += buffer; if (result.stdout.length > 1024 * 1024) owned.kill(); });
    owned.stderr.on("data", (buffer) => { result.stderr += buffer; if (result.stderr.length > 1024 * 1024) owned.kill(); });
    owned.stdin.on("error", () => {});
    owned.stdin.end(input);
  });
  assert.equal(result.spawnError, undefined);
  assert(result.exitObserved && result.closeObserved && !result.timedOut);
  assert.equal(result.exitSignal, null);
  assert.equal(result.closeCode, result.exitCode);
  return result;
}

test("complete source bundle has exact version, canonical hashes, directories and independent core digest", () => {
  const manifest = original.bundleManifest;
  assert(validateReleaseManifest(manifest));
  assert.equal(manifest.packageVersion, JSON.parse(fs.readFileSync(join(REPO, "06-workbench/package.json"))).version);
  assert.equal(cold.bundleDigest, manifest.digest);
  assert.equal(cold.digest, digestTree(cold.workbenchDir, ["server", "public", "package.json", "package-lock.json"]));
  assert.notEqual(cold.digest, cold.bundleDigest);
  assert.deepEqual(JSON.parse(fs.readFileSync(cold.manifestPath, "utf8")), manifest);
  assert.equal(cold.manifestPath, join(cold.destRoot, RELEASE_BUNDLE_MANIFEST));
  assert.deepEqual(cold.optionalMissing, []);
  assert.equal(cold.copied.length, manifest.files.length);
  for (const entry of manifest.files) {
    const source = fs.readFileSync(join(REPO, entry.path));
    const target = fs.readFileSync(join(cold.destRoot, entry.path));
    assert(source.equals(target), entry.path);
    assert.equal(entry.bytes, target.length);
    assert.equal(entry.sha256, sha(target));
    assert.equal(fs.lstatSync(join(cold.destRoot, entry.path)).nlink, 1);
  }
  for (const path of REQUIRED_BUNDLE_FILES) assert(manifest.files.some((entry) => entry.path === path));
  assert(!fs.existsSync(join(cold.workbenchDir, "node_modules")));
  assert(!fs.existsSync(join(cold.workbenchDir, "data")));
  assert(!fs.existsSync(join(cold.destRoot, "05-reconstruction/codex/skills")));
  assert.deepEqual(inspectRelease(cold.destRoot, { fullBundle: true }).bundleManifest, manifest);
});

test("full-bundle CLI flag is explicit; old packaged-tooling gate keeps its own meaning", async () => {
  const parsed = parseArgs(["--phase", "install-start", "--release", cold.destRoot, "--out", next("out"), "--npm", "explicit-npm", "--cache", next("cache"), "--full-bundle"]);
  assert.equal(parsed.options.fullBundle, true);
  assert.equal(parsed.options.requirePackagedTooling, false);
  assert.equal(parseArgs(["--full-bundle", "--full-bundle"]).error.code, "usage_duplicate_option");
  const help = await child(join(cold.workbenchDir, "scripts/windows-delivery-check.mjs"), ["--help"]);
  assert.equal(help.exitCode, 0);
  assert(JSON.parse(help.stdout).usage.includes("--full-bundle"));
});

test("every fixed required file is mandatory, even when the historical optional list would allow it", () => {
  for (const rel of REQUIRED_BUNDLE_FILES) {
    const source = coldSource();
    const file = join(cold.destRoot, rel);
    const held = next("held");
    fs.renameSync(file, held);
    try { expectNoCopy(source, next("missing")); }
    finally { fs.renameSync(held, file); }
  }
});

test("same-length wrong bytes and changed tool bytes after inspection reject before mkdir", () => {
  for (const rel of ["06-workbench/scripts/local-batch.mjs", "05-reconstruction/codex/mcp/finance-mcp/server.mjs", "06-workbench/server/server.mjs"]) {
    const source = coldSource();
    const file = join(cold.destRoot, rel);
    const before = fs.readFileSync(file);
    const wrong = Buffer.from(before); wrong[0] ^= 1;
    fs.writeFileSync(file, wrong);
    try { expectNoCopy(source, next("changed"), "bundle_source_changed"); }
    finally { fs.writeFileSync(file, before); }
  }
});

test("manifest unknown fields, paths, duplicates, traversal, aliases and bytes cannot authorize writes", () => {
  const cases = [
    (m) => { m.extra = true; },
    (m) => { m.files[0].extra = true; },
    (m) => { m.files[0].path = "../outside.mjs"; },
    (m) => { m.files[0].path = "06-workbench/server/../outside.mjs"; },
    (m) => { m.files[0].path = "06-workbench/server/file.mjs:stream"; },
    (m) => { m.files[0].path = "06-workbench/server/file.mjs."; },
    (m) => { m.files[0].path = "06-workbench/scripts/unknown-tool.mjs"; },
    (m) => { m.files.push({ ...m.files[0] }); },
    (m) => { m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() }); },
    (m) => { m.files[0].bytes += 1; },
    (m) => { m.files[0].sha256 = "0".repeat(64); },
    (m) => { m.files.splice(m.files.findIndex((entry) => entry.path.endsWith("local-backup.mjs")), 1); },
  ];
  for (const mutate of cases) {
    const source = structuredClone(coldSource());
    mutate(source.bundleManifest); resign(source.bundleManifest); source.bundleDigest = source.bundleManifest.digest;
    expectNoCopy(source, next("bad-manifest"));
  }
});

test("unmanifested build source and a valid persistent cold manifest both remain valid sources", () => {
  assert.equal(original.manifestSha256, null);
  const published = coldSource();
  assert.equal(published.manifestSha256, sha(fs.readFileSync(cold.manifestPath)));
  const second = copyReleaseWhitelist(published, next("persistent-positive"), { fullBundle: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(second.manifestPath)), published.bundleManifest);
  assert.equal(inspectReleaseBundle(second.destRoot).bundleDigest, published.bundleDigest);
});

test("persistent disk manifest attacks reject on fresh inspect and never rewrite corrupt evidence", () => {
  const fixture = cloneCold("disk-manifest");
  const pristine = fs.readFileSync(fixture.manifestPath);
  const cases = [
    (m) => { m.extra = true; },
    (m) => { m.files[0].extra = true; },
    (m) => { m.files.splice(m.files.findIndex((entry) => entry.path.endsWith("local-batch.mjs")), 1); resign(m); },
    (m) => { m.files.push({ ...m.files[0] }); resign(m); },
    (m) => { m.files[0].path = "../outside.mjs"; resign(m); },
    (m) => { m.digest = "0".repeat(64); },
    (m) => { m.files[0].bytes += 1; resign(m); },
    (m) => { m.files[0].sha256 = "0".repeat(64); resign(m); },
    (m) => { m.packageVersion += "-corrupt"; resign(m); },
  ];
  for (const mutate of cases) {
    const manifest = JSON.parse(pristine);
    mutate(manifest);
    const corrupt = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(fixture.manifestPath, corrupt);
    const destination = next("bad-disk-copy");
    try {
      assert.throws(() => copyReleaseWhitelist(inspectReleaseBundle(fixture.destRoot), destination, { fullBundle: true }));
      assert(!fs.existsSync(destination));
      assert(fs.readFileSync(fixture.manifestPath).equals(corrupt), "do not resign or rewrite disk evidence");
      fs.writeFileSync(next("bad-disk-evidence.json"), corrupt);
    } finally { fs.writeFileSync(fixture.manifestPath, pristine); }
  }
  fs.writeFileSync(fixture.manifestPath, "{");
  try { assert.throws(() => inspectReleaseBundle(fixture.destRoot), { code: "bundle_manifest_invalid" }); }
  finally { fs.writeFileSync(fixture.manifestPath, pristine); }
  const tool = join(fixture.workbenchDir, "scripts/local-batch.mjs");
  const toolBytes = fs.readFileSync(tool);
  const wrong = Buffer.from(toolBytes); wrong[0] ^= 1;
  fs.writeFileSync(tool, wrong);
  const destination = next("corrupt-published-tool");
  try {
    assert.throws(() => copyReleaseWhitelist(inspectReleaseBundle(fixture.destRoot), destination), { code: "bundle_source_changed" });
    assert(!fs.existsSync(destination));
    assert(fs.readFileSync(fixture.manifestPath).equals(pristine));
    assert(fs.readFileSync(tool).equals(wrong));
    fs.writeFileSync(next("bad-tool-evidence.mjs"), wrong);
  } finally { fs.writeFileSync(tool, toolBytes); }
  fs.writeFileSync(join(fixture.workbenchDir, "server/published-extra.mjs"), "export const unexpected = true;\n");
  assert.throws(() => inspectReleaseBundle(fixture.destRoot), { code: "bundle_source_changed" });
});

test("persistent manifest bytes are frozen across inspection and copying; manifest hardlinks reject", () => {
  const fixture = cloneCold("manifest-hardlink");
  fs.linkSync(fixture.manifestPath, next("manifest-hardlink-evidence.json"));
  assert.equal(fs.lstatSync(fixture.manifestPath).nlink, 2);
  assert.throws(() => inspectReleaseBundle(fixture.destRoot), { code: "bundle_file_refused" });
  const source = coldSource();
  const pristine = fs.readFileSync(cold.manifestPath);
  fs.writeFileSync(cold.manifestPath, Buffer.concat([pristine, Buffer.from("\n")]));
  try { expectNoCopy(source, next("changed-manifest-bytes"), "bundle_source_changed"); }
  finally { fs.writeFileSync(cold.manifestPath, pristine); }
  const duringCopySource = coldSource();
  const destination = next("manifest-during-copy");
  const write = fs.writeFileSync;
  let mutated = false;
  fs.writeFileSync = function (path, ...rest) {
    const result = write.call(this, path, ...rest);
    if (!mutated && String(path).startsWith(destination)) {
      mutated = true; write(cold.manifestPath, Buffer.concat([pristine, Buffer.from("\n")]));
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => copyReleaseWhitelist(duringCopySource, destination), { code: "bundle_source_changed" });
    assert(mutated && fs.existsSync(destination) && fs.readdirSync(destination).length > 0);
    assert(!fs.existsSync(join(destination, RELEASE_BUNDLE_MANIFEST)));
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); fs.writeFileSync(cold.manifestPath, pristine); }
});

test("new nested server source is dynamically included; a stale list cannot omit it", () => {
  const fixture = cloneCold("dynamic");
  // Future development is an unmanifested build tree; published bundles cannot silently gain files.
  fs.renameSync(fixture.manifestPath, next("dynamic-build-manifest-held"));
  const before = inspectReleaseBundle(fixture.destRoot);
  const extra = "06-workbench/server/future-component/new-file.mjs";
  fs.mkdirSync(dirname(join(fixture.destRoot, extra)));
  fs.writeFileSync(join(fixture.destRoot, extra), "export const future = true;\n");
  expectNoCopy(before, next("stale-dynamic"), "bundle_source_changed");
  const current = inspectReleaseBundle(fixture.destRoot);
  assert(current.bundleManifest.files.some((file) => file.path === extra));
  const copied = copyReleaseWhitelist(current, next("dynamic-copy"), { fullBundle: true });
  assert.equal(fs.readFileSync(join(copied.destRoot, extra), "utf8"), "export const future = true;\n");
});

test("source and destination roots / ancestors reject junctions, containment and existing targets", () => {
  const alias = next("source-junction");
  fs.symlinkSync(cold.destRoot, alias, "junction");
  assert.throws(() => inspectReleaseBundle(alias));
  expectNoCopy({ ...coldSource(), root: alias, workbenchDir: join(alias, "06-workbench") }, next("alias-source"));
  expectNoCopy(coldSource(), join(alias, "child"));
  expectNoCopy(coldSource(), join(cold.destRoot, "inside"), "copy_destination_inside_source");
  const existing = next("existing"); fs.mkdirSync(existing); fs.writeFileSync(join(existing, "sentinel"), "preserve");
  assert.throws(() => copyReleaseWhitelist(coldSource(), existing), { code: "copy_destination_exists" });
  assert.equal(fs.readFileSync(join(existing, "sentinel"), "utf8"), "preserve");
  const nested = join(root, "nested-parent"); fs.mkdirSync(nested);
  const fixture = copyReleaseWhitelist(coldSource(), join(nested, "source"));
  assert.throws(() => copyReleaseWhitelist(inspectReleaseBundle(fixture.destRoot), nested));
  assert(fs.existsSync(fixture.manifestPath));
});

test("ordinary-file hardlinks and directory aliases in whitelist fail without copying", () => {
  const fixture = cloneCold("hardlinks");
  fs.linkSync(join(fixture.workbenchDir, "server/server.mjs"), join(fixture.workbenchDir, "server/linked.mjs"));
  assert.equal(fs.lstatSync(join(fixture.workbenchDir, "server/server.mjs")).nlink, 2);
  assert.throws(() => inspectReleaseBundle(fixture.destRoot), { code: "bundle_file_refused" });
  const dirAlias = cloneCold("dir-alias");
  fs.symlinkSync(join(dirAlias.workbenchDir, "public"), join(dirAlias.workbenchDir, "server/alias"), "junction");
  assert.throws(() => inspectReleaseBundle(dirAlias.destRoot), { code: "bundle_file_refused" });
});

test("copy-time source mutation fails and retains the actual partially copied destination", () => {
  const source = coldSource();
  const target = next("during-copy");
  const path = join(cold.workbenchDir, "scripts/local-batch.mjs");
  const before = fs.readFileSync(path);
  const write = fs.writeFileSync;
  let mutated = false;
  fs.writeFileSync = function (file, ...rest) {
    const result = write.call(this, file, ...rest);
    if (!mutated && String(file).startsWith(target)) { mutated = true; write(path, Buffer.concat([before, Buffer.from("\n// changed during copy\n")])); }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => copyReleaseWhitelist(source, target), { code: "bundle_source_changed" });
    assert(mutated && fs.existsSync(target));
    assert(fs.readdirSync(target).length > 0);
    assert(!fs.existsSync(join(target, RELEASE_BUNDLE_MANIFEST)));
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); fs.writeFileSync(path, before); }
});

test("legacy core-only release remains usable and is never promoted to complete bundle", () => {
  const legacy = next("legacy"); fs.mkdirSync(legacy);
  for (const file of cold.bundleManifest.files.filter((entry) => /^06-workbench\/(server\/|public\/|package(?:-lock)?\.json$)/.test(entry.path))) {
    const destination = join(legacy, file.path);
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.copyFileSync(join(cold.destRoot, file.path), destination);
  }
  const inspected = inspectRelease(legacy);
  assert.equal(inspected.bundleManifest, undefined);
  const copied = copyReleaseWhitelist(inspected, next("legacy-copy"));
  assert.equal(copied.digest, inspected.digest);
  assert.equal(copied.optionalMissing.length, 5);
  expectNoCopy(inspected, next("legacy-full"));
  assert.throws(() => inspectReleaseBundle(legacy));
});

test("cold-copy five local CLIs and MCP initialize / list load without a default database", async () => {
  const script = (file) => join(cold.workbenchDir, "scripts", file);
  for (const name of ["local-backup.mjs", "bank-reconcile.mjs", "local-auxiliary.mjs", "local-batch.mjs"]) {
    const result = await child(script(name), ["help"]);
    assert.equal(result.exitCode, 0, `${name}: ${result.stdout} ${result.stderr}`);
    if (name === "local-batch.mjs") assert.match(result.stdout, /本机持久批量 CLI/);
    else assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const missingDb = join(root, "missing", "workbench.db");
  const audit = await child(script("local-audit.mjs"), ["schema", "--db", missingDb]);
  assert.equal(audit.exitCode, 3);
  assert.match(audit.stderr, /"error":"audit_database_missing"/);
  const bank = await child(script("bank-reconcile.mjs"), ["status", "--db", missingDb, "--account-set", "1"]);
  assert.notEqual(bank.exitCode, 0);
  assert.equal(JSON.parse(bank.stderr.match(/\{[\s\S]*\}/)[0]).error.code, "db_not_found");
  const batch = await child(script("local-batch.mjs"), ["status", "--data-dir", dirname(missingDb), "--job-key", "synthetic"]);
  assert.equal(batch.exitCode, 3);
  assert.equal(JSON.parse(batch.stdout).error.code, "database_not_found");
  const input = join(root, "input.json"); fs.writeFileSync(input, "{}");
  const aux = await child(script("local-auxiliary.mjs"), ["entries", "--db", missingDb, "--input", input]);
  assert.equal(aux.exitCode, 2);
  assert.equal(JSON.parse(aux.stdout).ok, false);
  const mcp = await child(join(cold.destRoot, "05-reconstruction/codex/mcp/finance-mcp/server.mjs"), [], [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "w2a-fixture", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map((request) => JSON.stringify(request)).join("\n") + "\n");
  assert.equal(mcp.exitCode, 0, mcp.stderr);
  const messages = mcp.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(messages.find((message) => message.id === 1).result.serverInfo.name, "finance-mcp");
  const tools = messages.find((message) => message.id === 2).result.tools;
  assert(tools.some((tool) => tool.name === "finance_query_catalog"));
  assert(tools.length > 0);
  assert(!fs.existsSync(missingDb));
  assert(!fs.existsSync(dirname(missingDb)));
  assert(!fs.existsSync(process.env.WORKBENCH_DATA_DIR));
  assert(!fs.existsSync(join(cold.workbenchDir, "data")));
});

after(() => {
  const evidence = { root, sourceRoot, repositoryRoot: REPO, uuid: root.slice(-36), retained: true, children, bundleDigest: cold.bundleDigest, coreDigest: cold.digest,
    files: cold.bundleManifest.files.length, noDefaultDatabase: !fs.existsSync(process.env.WORKBENCH_DATA_DIR) };
  fs.writeFileSync(join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`W2a evidence retained: ${root}`);
});
