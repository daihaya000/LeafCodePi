import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Write a file that only the current user may read.
 *
 * `fs.writeFileSync(..., { mode: 0o600 })` is a no-op on Windows: NTFS has no
 * POSIX mode bits, Node reports 0666 back, and the file inherits the parent
 * directory's ACL. Under the default %APPDATA% ACL that still means other
 * standard users cannot read it, but an inherited ACE from a loosened parent
 * (or a %APPDATA% redirected to a shared location) would silently expose
 * password hashes. So on Windows the ACL is set explicitly with icacls.
 *
 * The POSIX mode is still passed through for non-Windows hosts.
 */

/** Cache the outcome so a broken icacls does not spawn a process per write. */
let icaclsUsable = null;

/** Well-known SIDs, used instead of names so a localized Windows still matches. */
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINISTRATORS = '*S-1-5-32-544';

/**
 * Rewrite a file's ACL so only the owner, SYSTEM and Administrators can read it.
 *
 * `/inheritance:r` is required, not optional: `icacls /remove` cannot delete an
 * inherited ACE, so without breaking inheritance first the command reports
 * success while changing nothing. Verified on this machine — %APPDATA% here
 * grants several extra groups (M) purely by inheritance, and a `/remove:g` run
 * left the ACL byte-for-byte identical to an untouched file.
 *
 * Breaking inheritance means SYSTEM and Administrators have to be re-granted
 * explicitly, and the owner needs `D` as well as `R,W`: without delete rights
 * the containing directory can no longer be removed (rmSync fails EPERM),
 * which breaks uninstall and any cleanup path.
 *
 * @param {string} file
 * @param {{ execFile?: typeof execFileSync, platform?: string, onError?: (m: string) => void }} [deps]
 * @returns {boolean} true when the ACL was applied
 */
export function restrictToCurrentUser(file, deps = {}) {
  const {
    execFile = execFileSync,
    platform = process.platform,
    onError,
  } = deps;

  if (platform !== 'win32') return false;
  if (icaclsUsable === false) return false;

  // %USERDOMAIN%\%USERNAME% rather than %USERNAME% alone: a bare name is
  // ambiguous when a local and a domain account share it.
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME;
  if (!user) {
    onError?.('USERNAME is not set; leaving the default ACL in place');
    return false;
  }
  const principal = domain ? `${domain}\\${user}` : user;

  try {
    execFile(
      'icacls',
      [
        file,
        '/inheritance:r',
        '/grant:r',
        `${principal}:(R,W,D)`,
        '/grant:r',
        `${SID_SYSTEM}:(F)`,
        '/grant:r',
        `${SID_ADMINISTRATORS}:(F)`,
      ],
      { stdio: 'pipe', windowsHide: true },
    );
    icaclsUsable = true;
    return true;
  } catch (err) {
    icaclsUsable = false;
    onError?.(
      `icacls failed for ${file}; the file keeps its inherited ACL: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Reset the cached icacls availability. Tests only. */
export function resetIcaclsCache() {
  icaclsUsable = null;
}

/**
 * Create parent directories, write the file, then lock it down.
 *
 * @param {string} file
 * @param {string} contents
 * @param {{ execFile?: typeof execFileSync, platform?: string, onError?: (m: string) => void }} [deps]
 */
export function writeSecretFile(file, contents, deps = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 });
  restrictToCurrentUser(file, deps);
}
