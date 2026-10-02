import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { assertMcpStoragePermissions, createBackendMcpPrivateStorageCheck } from "./mcp-private-storage.mjs";
import { createBackendMcpCredentialOwner } from "./mcp-native-credential-owner.mjs";
const sid = "S-1-5-21-1-2-3-1001", full = 2_032_127;
const ace = (sid, flags = 0, mask = full) => ({ sid, type: 0, mask, flags });
const acl = (rules) => ({ ownerSid: sid, daclPresent: true, rules });
const windows = () => ({ platform: "win32", currentSid: sid, local: true,
  directory: acl([ace(sid, 3), ace("S-1-5-18", 3), ace("S-1-5-32-544", 3)]), file: acl([ace(sid), ace("S-1-5-18")]) });
const linux = () => ({ platform: "linux", currentUid: 1000, fsType: 0xef53, directory: { uid: 1000, mode: 0o40700 }, file: { uid: 1000, mode: 0o100600 } });
const safe = (error) => error instanceof Error && error.message === "MCP private storage permissions unavailable" && error.cause === undefined;
async function privateDirectory(path, broadRead = false) {
  if (process.platform !== "win32") { await mkdir(path, { mode: 0o700 }); return; }
  // Initialize only a NEW temporary fixture directory; never Set-Acl on an existing path.
  const code = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::InputEncoding = $utf8
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$path = $inputData.path
if (Test-Path -LiteralPath $path) { throw 'Fixture already exists' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($user)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
if ($inputData.broadRead) {
  $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
$directory = New-Object IO.DirectoryInfo($path)
$directory.Create($acl)
`;
  childProcess.execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
    { input: Buffer.from(JSON.stringify({ path, broadRead }), "utf8"), timeout: 5000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "leafcode-mcp-private-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, location: { agentDir: root, credentialPath: join(root, "mcp-auth.json") } };
}

test("Windows policy accepts only trusted SID grants and safe child-file inheritance", () => {
  assert.doesNotThrow(() => assertMcpStoragePermissions(windows()));
  const noFile = windows(); noFile.file = null;
  assert.doesNotThrow(() => assertMcpStoragePermissions(noFile));
  const creator = windows(); creator.directory.rules = [ace(sid), ace("S-1-3-0", 11)];
  assert.doesNotThrow(() => assertMcpStoragePermissions(creator));
  const system = windows(); system.currentSid = "S-1-5-18";
  system.directory.ownerSid = system.file.ownerSid = "S-1-5-18";
  system.directory.rules = [ace("S-1-5-18", 3)]; system.file.rules = [ace("S-1-5-18")];
  assert.doesNotThrow(() => assertMcpStoragePermissions(system));
});

test("Windows policy rejects broad principals, unknown/deny ACEs, null DACL and ineffective/incomplete grants", () => {
  const mutations = [
    (s) => s.directory.rules.push(ace("S-1-1-0", 3)),
    (s) => s.file.rules.push(ace("S-1-5-32-545", 0, 1)),
    (s) => { s.directory.ownerSid = "S-1-5-21-9-9-9-1002"; },
    (s) => { s.directory.daclPresent = false; },
    (s) => { s.file.rules = []; },
    (s) => { s.directory.rules[0].flags = 8; },
    (s) => { s.directory.rules[0].flags = 0; },
    (s) => { s.file.rules[0].mask = 1; },
    (s) => { s.directory.rules[0].type = 1; },
    (s) => { s.directory.rules[0].type = 5; },
    (s) => { s.directory.rules[0].mask = -1; },
    (s) => { s.directory.rules[0].flags = 64; },
    (s) => s.directory.rules.push(ace("S-1-3-0", 3)),
    (s) => { s.local = false; },
    (s) => { s.currentSid = "private-bad-sid"; },
  ];
  for (const mutate of mutations) { const s = windows(); mutate(s); assert.throws(() => assertMcpStoragePermissions(s), safe); }
  const inherited = windows(); inherited.directory = Object.create(inherited.directory);
  assert.throws(() => assertMcpStoragePermissions(inherited), safe);
});

test("Linux policy verifies exact UID/private modes and known local filesystem types; unknown POSIX fails closed", () => {
  assert.doesNotThrow(() => assertMcpStoragePermissions(linux()));
  const noFile = linux(); noFile.file = null;
  assert.doesNotThrow(() => assertMcpStoragePermissions(noFile));
  for (const mutate of [
    (s) => { s.directory.uid = 1001; }, (s) => { s.file.uid = 0; },
    (s) => { s.directory.mode = 0o40755; }, (s) => { s.file.mode = 0o100640; },
    (s) => { s.directory.mode = 0o40600; }, (s) => { s.file.mode = 0o100400; },
    (s) => { s.fsType = 0x6969; }, (s) => { s.platform = "darwin"; },
  ]) { const s = linux(); mutate(s); assert.throws(() => assertMcpStoragePermissions(s), safe); }
});

test("constructor/location contracts reject unknown/caller paths without metadata or process activity", async (t) => {
  const { root, location } = await fixture(t);
  t.after(() => mock.restoreAll());
  const exec = mock.method(childProcess, "execFileSync", () => { throw Error("Unexpected execution"); });
  const stat = mock.method(fs, "lstatSync", () => { throw Error("Unexpected metadata read"); });
  for (const input of [undefined, null, [], {}, Object.create({ agentDir: root }), { agentDir: "relative" }, { agentDir: root, command: "private" }]) {
    assert.throws(() => createBackendMcpPrivateStorageCheck(input), safe);
  }
  const check = createBackendMcpPrivateStorageCheck({ agentDir: root });
  assert.equal(exec.mock.callCount(), 0);
  for (const value of [{ ...location, credentialPath: join(root, "private.json") }, { ...location, agentDir: join(root, "project") }, Object.create(location), { ...location, shell: "private" }]) {
    assert.throws(() => check(value), safe);
  }
  assert.equal(exec.mock.callCount(), 0);
  assert.equal(stat.mock.callCount(), 0);
  assert.deepEqual(await readdir(root), []);
});

test("real platform metadata checks missing/existing private store without reading credential bytes or changing mode", { timeout: 12_000 }, async (t) => {
  const { root } = await fixture(t);
  const agentDir = join(root, "日本語 💾 '$literal;");
  await privateDirectory(agentDir);
  const location = { agentDir, credentialPath: join(agentDir, "mcp-auth.json") };
  const check = createBackendMcpPrivateStorageCheck({ agentDir });
  check(location);
  assert.deepEqual(await readdir(agentDir), []);
  const bytes = Buffer.from("private-non-JSON credential bytes");
  await writeFile(location.credentialPath, bytes, { mode: 0o600 });
  const before = fs.statSync(location.credentialPath);
  t.after(() => mock.restoreAll());
  const noRead = mock.method(fs, "readFileSync", () => { throw Error("Unexpected credential read"); });
  check(location);
  noRead.mock.restore();
  assert.deepEqual(await readFile(location.credentialPath), bytes);
  const after = fs.statSync(location.credentialPath);
  assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
  assert.deepEqual(await readdir(agentDir), ["mcp-auth.json"]);
});

test("owner attestation can use the real read-only check; no credential file is created", { timeout: 12_000 }, async (t) => {
  const { root: parent } = await fixture(t);
  const root = join(parent, "private-owner");
  await privateDirectory(root);
  const check = createBackendMcpPrivateStorageCheck({ agentDir: root });
  const owner = createBackendMcpCredentialOwner({ agentDir: root, assertOwner() {}, assertPrivateStorage: check });
  owner.assertOwner({ namespace: "mcp__fixture", serverUrl: "https://example.invalid/mcp" });
  assert.deepEqual(await readdir(root), []);
});

test("real Windows rejects a NEW empty fixture with Everyone read access without changing it", { skip: process.platform !== "win32", timeout: 12_000 }, async (t) => {
  const { root: parent } = await fixture(t);
  const root = join(parent, "unapproved-empty");
  await privateDirectory(root, true);
  const location = { agentDir: root, credentialPath: join(root, "mcp-auth.json") };
  const before = fs.statSync(root);
  assert.throws(() => createBackendMcpPrivateStorageCheck({ agentDir: root })(location), safe);
  const after = fs.statSync(root);
  assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
  assert.deepEqual(await readdir(root), []);
});

test("metadata process failures are sanitized; encoded script is fixed and paths are input data", { skip: process.platform !== "win32" }, async (t) => {
  const { root, location } = await fixture(t);
  const check = createBackendMcpPrivateStorageCheck({ agentDir: root });
  t.after(() => mock.restoreAll());
  const hook = mock.method(childProcess, "execFileSync", (exe, args, options) => {
    assert.equal(exe.endsWith("WindowsPowerShell\\v1.0\\powershell.exe"), true);
    assert.equal(args.includes("-EncodedCommand"), true);
    const code = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.equal(code.includes(root), false);
    assert.equal(/[^\x00-\x7f]/.test(code), false);
    assert.deepEqual(JSON.parse(options.input.toString("utf8")), location);
    assert.equal(options.timeout, 5000);
    throw Error("private-ACL-path-SID");
  });
  assert.throws(() => check(location), safe);
  assert.equal(hook.mock.callCount(), 1);
  hook.mock.restore();
  for (const output of [Buffer.from([0xff]), Buffer.from("private-bad-json"), Buffer.from(JSON.stringify({ ...windows(), file: acl([ace(sid)]) }))]) {
    const bad = mock.method(childProcess, "execFileSync", () => output);
    assert.throws(() => check(location), safe);
    bad.mock.restore();
  }
});
