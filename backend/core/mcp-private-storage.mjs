import childProcess from "node:child_process";
import fs from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failed = () => new Error("MCP private storage permissions unavailable");
const own = (value, keys) => plain(value) && keys.every((key) => Object.hasOwn(value, key));
const FULL_CONTROL = 2_032_127;
// Known Linux LOCAL filesystem types only: ext*, XFS, tmpfs, btrfs, overlayfs.
const LOCAL_LINUX_TYPES = new Set([0xef53, 0x58465342, 0x01021994, 0x9123683e, 0x794c7630]);

function windowsAcl(acl, kind, currentSid) {
  const trusted = new Set([currentSid, "S-1-5-18", "S-1-5-32-544"]);
  if (!own(acl, ["ownerSid", "daclPresent", "rules"]) || !trusted.has(acl.ownerSid)
    || acl.daclPresent !== true || !Array.isArray(acl.rules) || acl.rules.length === 0) throw failed();
  let self = false, child = false;
  for (const ace of acl.rules) {
    if (!own(ace, ["sid", "type", "mask", "flags"]) || typeof ace.sid !== "string"
      || ace.type !== 0 || !Number.isSafeInteger(ace.mask) || ace.mask < 0 || ace.mask > 0x7fffffff
      || !Number.isSafeInteger(ace.flags) || ace.flags < 0 || ace.flags > 31) throw failed();
    const inheritOnly = (ace.flags & 8) !== 0;
    // CREATOR OWNER may grant only future children; it never grants another existing account.
    const creator = kind === "directory" && ace.sid === "S-1-3-0" && inheritOnly && (ace.flags & 1) !== 0;
    if (!trusted.has(ace.sid) && !creator && ace.mask !== 0) throw failed();
    if (creator && (ace.mask & FULL_CONTROL) === FULL_CONTROL) child = true;
    if (ace.sid === currentSid && (ace.mask & FULL_CONTROL) === FULL_CONTROL) {
      if (!inheritOnly) self = true;
      if ((ace.flags & 1) !== 0) child = true;
    }
  }
  if (!self || (kind === "directory" && !child)) throw failed();
}

/** INTERNAL pure fail-closed policy. No ACL/mode changes, secret reads or public diagnostic details. */
export function assertMcpStoragePermissions(input) {
  try {
    const data = structuredClone(input);
    if (!own(data, ["platform", "directory", "file"])) throw failed();
    if (data.platform === "win32") {
      if (!own(data, ["currentSid", "local"]) || typeof data.currentSid !== "string"
        || !/^S-1-\d+(?:-\d+)+$/.test(data.currentSid) || data.local !== true) throw failed();
      windowsAcl(data.directory, "directory", data.currentSid);
      if (data.file !== null) windowsAcl(data.file, "file", data.currentSid);
    } else if (data.platform === "linux") {
      if (!own(data, ["currentUid", "fsType"]) || !Number.isSafeInteger(data.currentUid) || data.currentUid < 0
        || !LOCAL_LINUX_TYPES.has(data.fsType)) throw failed();
      for (const [value, mode] of [[data.directory, 0o700], [data.file, 0o600]]) {
        if (value === null && mode === 0o600) continue;
        if (!own(value, ["uid", "mode"]) || value.uid !== data.currentUid || !Number.isSafeInteger(value.mode)
          || value.mode < 0 || value.mode > 0x1ffff || (value.mode & 0o7777) !== mode) throw failed();
      }
    } else throw failed(); // Unknown POSIX platforms/filesystems require a separate reviewed policy.
  } catch { throw failed(); }
}

// Fixed ASCII script. Paths are UTF-8 JSON DATA on stdin, never executable interpolation.
const WINDOWS_READER = String.raw`
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine('Storage permissions unavailable'); exit 1 }
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$location = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Read-AclMetadata([string]$path) {
  $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
  $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
  $entries = @()
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ([int]$ace.AceType -notin @(0, 1)) { throw 'Unsupported ACE' }
    $entries += @{ sid = $ace.SecurityIdentifier.Value; type = [int]$ace.AceType; mask = [long]$ace.AccessMask; flags = [int]$ace.AceFlags }
  }
  return @{ ownerSid = $raw.Owner.Value; daclPresent = (($raw.ControlFlags -band 4) -ne 0 -and $null -ne $raw.DiscretionaryAcl); rules = @($entries) }
}
$drive = New-Object System.IO.DriveInfo([IO.Path]::GetPathRoot($location.agentDir))
$file = $null
if (Test-Path -LiteralPath $location.credentialPath -ErrorAction Stop) { $file = Read-AclMetadata $location.credentialPath }
$result = @{ platform = 'win32'; currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; local = ($drive.DriveType -eq [IO.DriveType]::Fixed); directory = (Read-AclMetadata $location.agentDir); file = $file }
[Console]::Write(($result | ConvertTo-Json -Depth 8 -Compress))
`;
function statLocation(location) {
  const directory = fs.lstatSync(location.agentDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw failed();
  let file;
  try {
    file = fs.lstatSync(location.credentialPath);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw failed();
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { directory, file };
}

/**
 * INTERNAL synchronous owner callback, fixed paths, fresh metadata on each call.
 * Constructor performs no IO. Windows trusts only process-user/SYSTEM/Administrators
 * and constrained CREATOR OWNER inheritance, requiring user full control and child-file
 * inheritance. Complex/deny/unknown ACLs fail closed; no effective-group-access guessing.
 * Linux checks UID/0700/0600 and known local filesystems. Other POSIX platforms fail closed.
 * No credential bytes, permission changes, fallback, cache, migration or session activation.
 * Metadata checks do not remove path-replacement/ancestor/TOCTOU races or provide a sandbox.
 * Windows launches the trusted Backend environment's built-in PowerShell (bounded 5s).
 */
function createStorageCheck(options, fileName, pathKey) {
  try {
    if (!own(options, ["agentDir"]) || Object.keys(options).some((key) => key !== "agentDir")) throw failed();
    const value = options.agentDir;
    if (typeof value !== "string" || !isAbsolute(value)) throw failed();
    const agentDir = resolve(value), credentialPath = join(agentDir, fileName);
    const powershell = process.platform === "win32" ? join(process.env.SystemRoot ?? "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined;
    return (input) => {
      try {
        if (!own(input, ["agentDir", pathKey]) || Object.keys(input).some((key) => !["agentDir", pathKey].includes(key))) throw failed();
        // Metadata transport retains its private field name; selectors stay fixed by factory,
        // never by caller input. No config/credential file bytes are read.
        const location = Object.freeze({ agentDir: input.agentDir, credentialPath: input[pathKey] });
        if (location.agentDir !== agentDir || location.credentialPath !== credentialPath) throw failed();
        const before = statLocation(location);
        let data;
        if (process.platform === "win32") {
          if (!isAbsolute(powershell)) throw failed();
          const bytes = childProcess.execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_READER, "utf16le").toString("base64")],
            { input: Buffer.from(JSON.stringify(location), "utf8"), timeout: 5000, maxBuffer: 65_536, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (data.platform !== "win32" || (data.file === null) !== (before.file === undefined)) throw failed();
        } else if (process.platform === "linux") {
          data = { platform: "linux", currentUid: process.getuid(), fsType: fs.statfsSync(agentDir).type,
            directory: { uid: before.directory.uid, mode: before.directory.mode },
            file: before.file ? { uid: before.file.uid, mode: before.file.mode } : null };
        } else throw failed();
        const after = statLocation(location);
        for (const key of ["directory", "file"]) {
          if (!!before[key] !== !!after[key] || (before[key] && ["ino", "dev", "uid", "gid", "mode"].some((field) => before[key][field] !== after[key][field]))) throw failed();
        }
        assertMcpStoragePermissions(data);
      } catch { throw failed(); }
    };
  } catch { throw failed(); }
}

/** Fixed mcp-auth.json attestor; no caller-selected target or constructor IO. */
export function createBackendMcpPrivateStorageCheck(options) {
  return createStorageCheck(options, "mcp-auth.json", "credentialPath");
}

/** Fixed mcp.json attestor for the atomic config writer. Same strict/read-only policy,
 * including private replacement inheritance. No default writer, ACL changes or activation. */
export function createBackendMcpConfigStorageCheck(options) {
  return createStorageCheck(options, "mcp.json", "configPath");
}
