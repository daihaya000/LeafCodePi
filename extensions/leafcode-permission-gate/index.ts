/**
 * LeafCode Permission Gate for Pi
 *
 * - 危険なシェルコマンド実行前に承認ダイアログを出す (permission-gate)
 * - user_bash と tool_call の OS 等への変更を調査・計画・明示承認で保護する (system-safety)
 * - 保護パスへの write/edit をブロックする (protected-paths)
 * - WebUI の Composer から設定される「承認モード」に連動して動作を切り替える
 *
 * WebUI からは `/api/tasks/:id/permission` で承認モードを設定する。
 * 未設定時は "allow"（許可）。
 * システム安全ガードの度合いは、データディレクトリの `permission-gate.json` で
 * `"systemSafety": "off"|"low"|"standard"|"strict"`（または旧 boolean）を設定する。
 * 未設定時の既定は `standard`。保護パスと LeafCodePi 自己終了の禁止はどの度合いでも継続。
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { requestWebUiPermission } from "./webui-bridge";

export type PermissionMode = "allow" | "ask" | "deny";
export type SystemSafetyLevel = "off" | "low" | "standard" | "strict";

type StoredConfig = {
  mode: PermissionMode;
  systemSafety?: SystemSafetyLevel;
  sessions?: Record<string, PermissionMode>;
};

const CONFIG_FILE = "permission-gate.json";
/** Kept for WebUI applyPermissionMode / docs; mode is file-backed, not ctx-backed. */
export const SESSION_KEY = "leafcode-permission-gate";

export type SystemSafetyCategory =
  | "os"
  | "user-data"
  | "kernel"
  | "driver"
  | "registry"
  | "service"
  | "boot"
  | "disk"
  | "firmware";

export type SystemSafetyMatch = {
  category: SystemSafetyCategory;
  label: string;
};

type SystemSafetyRule = SystemSafetyMatch & { pattern: RegExp };

const LEAFCODE_PI_STOP_LABEL = "LeafCodePi process termination";
const LEAFCODE_PI_STOP_REASON = "LeafCodePi process termination is prohibited.";
const PROCESS_TERMINATION_COMMAND_PATTERN = /\b(?:taskkill(?:\.exe)?|Stop-Process|Stop-Service|pkill|killall|kill)\b|\bwmic(?:\.exe)?\b[^\r\n]*\b(?:call\s+terminate|delete)\b|\b(?:sc(?:\.exe)?|systemctl|service|launchctl|rc-service)\b[^\r\n]*(?:\b(?:stop|terminate|kill|bootout|unload|delete)\b)/i;
const LEAFCODE_PI_PROCESS_TARGET_PATTERN = /\b(?:leafcodepi|leafcode[-_ ]?pi(?:[-_ ]?(?:host|server))?)(?:\.exe|\.service)?\b|\bhost[\\/]src[\\/]index\.js\b/i;
const SELF_PID_REFERENCE_PATTERN = /(?:%(?:LEAFCODE_PI_(?:PID|PROCESS_ID)|PID|PPID)%|\$(?:\$|(?:\{)?(?:env:)?(?:LEAFCODE_PI_(?:PID|PROCESS_ID)|PID|PPID|BASHPID)\}?)|\bprocess\.(?:pid|ppid)\b|\b(?:os\.)?getpid\s*\(\s*\))/i;
// Child `process.exit()` does not stop LeafCodePi; only kill/getpid self-targets do.
const INLINE_SELF_TERMINATION_PATTERN = /\b(?:node|node\.exe|bun|deno)\b[^\r\n]*(?:process\s*[.]\s*(?:kill|abort)\s*\(|process\s*\[[^\]]+\]\s*\(|os\s*[.]\s*kill\s*\(\s*(?:os\.)?getpid)/i;
// Only `kill -- -1` / `kill -1` as the sole target (broadcast), not `kill -1 <pid>` (signal 1).
const BROAD_KILL_TARGET_PATTERN = /\b(?:kill|pkill)\b[^\r\n]*(?:^|\s)--\s*-1(?:\s|$)|(?:^|[;&|\r\n]\s*)(?:kill|pkill)\s+-1\s*$/im;

/**
 * Return true when a command can terminate LeafCodePi itself. This is kept
 * separate from the normal approval flow: self-termination is never allowed.
 */
export function isLeafCodePiStopCommand(command: string, pid = process.pid): boolean {
  const normalized = command.replace(/\u0000/g, " ");
  if (INLINE_SELF_TERMINATION_PATTERN.test(normalized)) return true;
  if (!PROCESS_TERMINATION_COMMAND_PATTERN.test(normalized)) return false;
  if (LEAFCODE_PI_PROCESS_TARGET_PATTERN.test(normalized)) return true;
  if (SELF_PID_REFERENCE_PATTERN.test(normalized) || BROAD_KILL_TARGET_PATTERN.test(normalized)) return true;
  if (Number.isSafeInteger(pid) && pid > 0 && new RegExp(`\\b${pid}\\b`).test(normalized)) return true;
  // LeafCodePi runs on Node; stopping every Node process would include it.
  return /\b(?:node|node\.exe|nodejs)\b/i.test(normalized);
}

/**
 * Commands in these categories are never covered by permission mode "allow".
 * They may inspect the machine, but a mutation still needs a preflight and an
 * explicit approval for that exact operation.
 *
 * Keep this list to machine-breaking / persistent system changes and obfuscated
 * execution. Everyday coding-agent shell (`node -e`, `bash -c ls`, `Start-Process`
 * without elevation, home-directory mkdir/cp) must NOT hard-gate here.
 */
const SYSTEM_SAFETY_RULES: readonly SystemSafetyRule[] = [
  // Require command position / path-qualified binaries — not `git log --grep=shutdown` / `echo Stop-Computer`.
  {
    category: "os",
    label: "OS shutdown/restart",
    // Soft prefixes may wrap the binary (flags only — not path args); still not `echo Stop-Computer`.
    // Exclude -v/-V/--help/--version so `command -v shutdown` is not treated as running shutdown.
    pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:(?:env|busybox|timeout|exec|nohup|nice|command|time|call|start|stdbuf|setsid|xargs|flock|ionice|nsenter|unshare|chroot|watch|systemd-run|parallel|spawn|ssh(?:\.exe)?|docker(?:\.exe)?|podman(?:\.exe)?|nerdctl(?:\.exe)?|lxc|machinectl|firejail|ctr|kubectl|wsl(?:\.exe)?)(?:\s+(?!-[vV]\b|--(?:help|version)\b)--?[\w.-]+(?:=\S+)?|\s+--(?=\s)|\s+\/[A-Za-z]+\b|\s+""|\s+\d+|\s+(?!-[vV]\b)-\w+\s+\S+|\s+(?!(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:shutdown|reboot|poweroff|halt|sudo|doas|pkexec|runas|gsudo|su)(?:\.exe)?(?![\w-]))(?:(?:~\/?|%[\w]+%|\$\{?[\w:]+\}?|\.\.?\/|[A-Za-z]:[\\/]|\/)[A-Za-z0-9_./\\:%~${}$-]*|[A-Za-z_][\w.@-]*))*\s+)*(?:sudo\s+)?(?:\\\\[?.]\\)?(?:%(?:WINDIR|SYSTEMROOT)%[\\/]|\$(?:\{)?(?:env:)?(?:WINDIR|SYSTEMROOT|SystemRoot)\}?[\\/])?(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:Windows[\\/]System32[\\/])?["']?(?:shutdown|reboot|poweroff|halt)["']?(?:\.exe)?(?![\w-])|\b(?:systemctl|loginctl)\b[^\r\n]*\b(?:reboot|poweroff|halt|hibernate)\b|\bgnome-session-quit\b[^\r\n]*--(?:power-off|reboot)\b|\bosascript\b[\s\S]{0,200}\b(?:shut\s+down|restart)\b|\b(?:wmic(?:\.exe)?\b[^\r\n]*\b(?:os|computersystem)\b[^\r\n]*\bcall\s+(?:reboot|shutdown)\b)|\b(?:Invoke-CimMethod|Get-CimInstance|Get-WmiObject)\b[^\r\n]*\b(?:Win32(?:_OperatingSystem)?|Win32Shutdown|Reboot|Shutdown)\b|\.\s*Reboot\s*\(|\brundll32(?:\.exe)?\b[^\r\n]*\bExitWindowsEx\b|\b(?:dbus-send|busctl)\b[^\r\n]*\b(?:Reboot|PowerOff)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*|[{]\s*|&\s*[{]\s*|\\)(?:[\w.]+\\)?(?:Stop-Computer|Restart-Computer|logoff(?:\.exe)?)\b|\b(?:Start-Process|saps)\b[^\r\n]*\b(?:Stop-Computer|shutdown|reboot)(?:\.exe)?(?![\w-])|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:init|telinit)\s+[06]\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:virsh|qm|pct)\b[^\r\n]*\b(?:shutdown|destroy|reboot|reset|stop)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)VBoxManage(?:\.exe)?\b[^\r\n]*\bcontrolvm\b[^\r\n]*\b(?:poweroff|reset|savestate|acpipowerbutton)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:xl|xe)\b[^\r\n]*\b(?:shutdown|destroy|reboot|vm-shutdown|vm-reboot)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*|[{]\s*|&\s*[{]\s*)(?:Stop-VM|Restart-VM|Suspend-VM)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)aws\b[^\r\n]*\bec2\b[^\r\n]*\b(?:stop|reboot|terminate)-instances\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)az\b[^\r\n]*\bvm\b[^\r\n]*\b(?:stop|deallocate|restart|delete)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)gcloud\b[^\r\n]*\bcompute\b[^\r\n]*\binstances\b[^\r\n]*\b(?:stop|reset|delete)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:nova|openstack\s+server)\b[^\r\n]*\b(?:stop|reboot|delete|shelve)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)kubectl\b[^\r\n]*\b(?:delete\s+nodes?|drain)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)doctl\b[^\r\n]*\b(?:power-off|reboot|shutdown|power_off)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:linode-cli|vultr-cli|hcloud)\b[^\r\n]*\b(?:shutdown|stop|reboot|poweroff|power-off)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:multipass|limactl|colima|minikube)\b[^\r\n]*\b(?:stop|restart|delete|poweroff)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)vagrant\b[^\r\n]*\b(?:halt|destroy|suspend|reload)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:kind|k3d)\b[^\r\n]*\b(?:delete|stop)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)docker\b[^\r\n]*\bdesktop\b[^\r\n]*\bstop\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)orb\s+(?:stop|delete|restart)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)podman\b[^\r\n]*\bmachine\b[^\r\n]*\b(?:stop|rm|remove)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:rdctl|finch|utmctl|prlctl|vmrun)\b[^\r\n]*\b(?:shutdown|stop|delete|suspend|pause)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)wsl(?:\.exe)?\b[^\r\n]*--(?:shutdown|terminate|unregister)\b/i,
  },
  // Same soft-prefix + command-position rule — not `git log --grep=sudo` / `npm install sudo-prompt`.
  {
    category: "os",
    label: "privilege elevation",
    pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:(?:env|busybox|timeout|exec|nohup|nice|command|time|stdbuf|call|start|setsid|xargs|flock|ionice|nsenter|unshare|chroot|watch|systemd-run|parallel|spawn|ssh(?:\.exe)?|docker(?:\.exe)?|podman(?:\.exe)?|nerdctl(?:\.exe)?|lxc|machinectl|firejail|ctr|kubectl|wsl(?:\.exe)?)(?:\s+(?!-[vV]\b|--(?:help|version)\b)--?[\w.-]+(?:=\S+)?|\s+--(?=\s)|\s+\/[A-Za-z]+\b|\s+""|\s+\d+|\s+(?!-[vV]\b)-\w+\s+\S+|\s+(?!(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:shutdown|reboot|poweroff|halt|sudo|doas|pkexec|runas|gsudo|su)(?:\.exe)?(?![\w-]))(?:(?:~\/?|%[\w]+%|\$\{?[\w:]+\}?|\.\.?\/|[A-Za-z]:[\\/]|\/)[A-Za-z0-9_./\\:%~${}$-]*|[A-Za-z_][\w.@-]*))*\s+)*(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:sudo|doas|pkexec|runas|sudoedit|gsudo|su)(?:\.exe)?\b|\b(?:Start-Process|saps)\b[^\r\n]*-Verb\s*:?\s*['"]?RunAs['"]?\b/i,
  },
  { category: "os", label: "system policy/account/firewall change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Set-ExecutionPolicy|setx|icacls|net(?:\.exe)?\s+(?:user|localgroup)|(?:New|Remove|Add|Disable|Enable)-Local(?:User|GroupMember)|(?:New|Set|Remove)-(?:NetFirewallRule|WindowsOptionalFeature)|(?:Enable|Disable)-WindowsOptionalFeature)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)dism(?:\.exe)?\b[^\r\n]*\/(?:enable-feature|disable-feature|add-package|remove-package)|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)msiexec(?:\.exe)?\b[^\r\n]*\/(?:i|uninstall)\b/i },
  { category: "os", label: "system package change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:apt(?:-get)?|dnf|yum|pacman|zypper|apk|brew|winget|choco)(?:\.exe)?\b[^\r\n]*(?:install|remove|purge|upgrade|update|add|delete|uninstall|-[SRU][A-Za-z]*)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:npm|pnpm|yarn|pip|pip3)\b[^\r\n]*(?:--global|\s-g\b)\b/i },
  { category: "os", label: "scheduled task change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Register|Unregister|New|Remove)-ScheduledTask\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)schtasks(?:\.exe)?\b[^\r\n]*\/(?:create|delete|change|run)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)crontab\s+(?:-e|-r)\b/i },
  // Obfuscated / encoded execution only. Plain `node -e`, `bash -c`, aliases, and
  // unelevated Start-Process are normal agent tools and stay out of this gate.
  { category: "os", label: "dynamic/elevated script execution", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*-(?:EncodedCommand|enc)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Invoke-Expression|\biex\b)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?<![-/])eval\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)Invoke-Command\b[^\r\n]*(?:-ComputerName|-Session)\b|(?:^|[;|&\r\n])\s*&\s*(?:\(|['"])|(?:^|[;|&\r\n])\s*["']?\$(?:\{)?[A-Za-z_]\w*\}?["']?\s+(?:stop|start|restart|kill|terminate|disable|enable|delete|remove|uninstall|format|erase|wipe|shutdown|reboot)\b/i },
  { category: "os", label: "downloaded script execution", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\r\n]*(?:\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd|iex|Invoke-Expression)\b|(?:-o|--output)\s*-\s*&&)/i },
  // IaC teardown can wipe fleets; gate at standard like shutdown (not `terraform plan` / `echo terraform destroy`).
  { category: "os", label: "infrastructure destroy", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:terraform|tofu|terragrunt|pulumi|cdk|sam|serverless|cdktf)(?:\.exe)?\b[^\r\n]*\b(?:destroy|delete)\b/i },
  // Require "kernel" (or load/unload module) — bare "install modules" is a package name, not sysadmin.
  { category: "kernel", label: "kernel/module change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:modprobe|insmod|rmmod|kexec)(?:\.exe)?\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)sysctl\b[^\r\n]*(?:-w|--write|[^\r\n]*=)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)dkms\b[^\r\n]*\b(?:install|remove|autoinstall)\b|\b(?:load|unload)\s+(?:the\s+)?kernel(?:\s+modules?)?\b|\b(?:install|remove|update)\s+the\s+kernel(?:\s+modules?)?\b|\b(?:load|unload)\s+(?:the\s+)?modules?\b/i },
  // Bare "install driver" / "npm install driver" is a package name; require device-driver wording or tools.
  { category: "driver", label: "device-driver change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)pnputil(?:\.exe)?\b[^\r\n]*\/(?:add-driver|delete-driver)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)devcon(?:\.exe)?\s+(?:install|remove|update)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)dism(?:\.exe)?\b[^\r\n]*\/(?:add-driver|remove-driver)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Add|Remove|Install|Uninstall)-WindowsDriver\b|\b(?:install|uninstall|remove|update|load)\s+(?:the\s+)?device\s+drivers?\b/i },
  { category: "registry", label: "Windows registry change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)reg(?:\.exe)?\s+(?:add|delete|import|copy|restore|load|unload)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|New-Item|Remove-Item)\b[^\r\n]*(?:HK(?:LM|CU|CR|U|CC)\b|Registry::|CurrentControlSet|Software[\\/]Classes)|\b(?:add|set|write|delete|remove|import|update)\s+(?:the\s+)?(?:Windows\s+)?registry\b/i },
  { category: "service", label: "service/daemon change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)sc(?:\.exe)?\s+(?:create|config|delete|start|stop|failure|privs)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:New|Remove|Set|Start|Stop|Restart)-(?:Windows)?Service\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)systemctl\s+(?:enable|disable|start|stop|restart|mask|unmask|link|preset)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)service\s+\S+\s+(?:start|stop|restart)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable)|rc-service\s+\S+\s+(?:start|stop|restart))\b|\b(?:start|stop|restart|enable|disable)\s+(?:the\s+)?(?:service|daemon)s?\b|\b(?:start|stop|restart|enable|disable)[_-](?:service|daemon)s?\b/i },
  // Require bootloader/configuration — bare "update boot" is a commit message / package name.
  { category: "boot", label: "boot configuration change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:bcdboot(?:\.exe)?|grub-install|update-grub|update-initramfs)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)bootrec(?:\.exe)?\b[^\r\n]*\/(?:fixmbr|fixboot|rebuildbcd)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)efibootmgr\b[^\r\n]*(?:\s-[cCbBdDoOnN]|--(?:create|delete|disk|bootorder|bootnext))\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)reagentc(?:\.exe)?\b[^\r\n]*\/(?:enable|disable|setreimage|boottore)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)bootcfg(?:\.exe)?\b[^\r\n]*\/(?:add|delete|raw)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)bcdedit(?:\.exe)?\b[^\r\n]*[\/-](?:set|delete(?:value)?|create|import|export|store|timeout|default|displayorder|bootsequence|ems|dbgsettings|hypervisorsettings)\b|\b(?:change|modify|update|repair|write|set)\s+(?:the\s+)?boot(?:loader|configuration)\b/i },
  // `format C:` / mkfs / diskpart / *-Volume require command position — not `echo mkfs` / `Get-Command Format-Volume`.
  { category: "disk", label: "disk/partition/volume change", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:(?:env|busybox|timeout|exec|nohup|nice|command|time|call|start|stdbuf|setsid)(?:\s+(?!-[vV]\b|--(?:help|version)\b)--?[\w.-]+(?:=\S+)?|\s+--(?=\s)|\s+\/[A-Za-z]+\b|\s+""|\s+\d+|\s+(?!-[vV]\b)-\w+\s+\S+|\s+(?!(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:shutdown|reboot|poweroff|halt|sudo|doas|pkexec|runas|gsudo|su)(?:\.exe)?(?![\w-]))(?:(?:~\/?|%[\w]+%|\$\{?[\w:]+\}?|\.\.?\/|[A-Za-z]:[\\/]|\/)[A-Za-z0-9_./\\:%~${}$-]*|[A-Za-z_][\w.@-]*))*\s+)*(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:mkfs(?:\.\w+)?|fdisk|sfdisk|parted|cfdisk|sgdisk|wipefs|diskpart(?:\.exe)?|diskutil)(?:\.exe)?\b|\bdd\b[^\r\n]*\b(?:if|of)=(?:\/(?:dev|etc|boot|sys|proc|usr|var|opt|root|sbin|bin|lib|private)\/|\\\\\.\\|[A-Za-z]:[\\/])|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:(?:[\w.]+=\S+\s+)*)?(?:(?:env|busybox|timeout|exec|nohup|nice|command|time|call|start|stdbuf|setsid)(?:\s+(?!-[vV]\b|--(?:help|version)\b)--?[\w.-]+(?:=\S+)?|\s+--(?=\s)|\s+\/[A-Za-z]+\b|\s+""|\s+\d+|\s+(?!-[vV]\b)-\w+\s+\S+|\s+(?!(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:shutdown|reboot|poweroff|halt|sudo|doas|pkexec|runas|gsudo|su)(?:\.exe)?(?![\w-]))(?:(?:~\/?|%[\w]+%|\$\{?[\w:]+\}?|\.\.?\/|[A-Za-z]:[\\/]|\/)[A-Za-z0-9_./\\:%~${}$-]*|[A-Za-z_][\w.@-]*))*\s+)*(?:[A-Za-z]:[\\/])?(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:format(?:\.com|\.exe)\b|format(?:\s+[\/\-][A-Za-z0-9:]+)*\s+[A-Za-z]:(?:\s|$|\/))|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Clear|Initialize|Set|New|Remove)-(?:Disk|Partition|Volume)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Format|Resize|New|Remove|Set)-Volume\b|\b(?:format|erase|wipe|partition|resize|initialize)\s+(?:the\s+)?(?:disk|drive|volume|partition)s?\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)vssadmin(?:\.exe)?\b[^\r\n]*\bdelete\b[^\r\n]*\bshadows\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)cipher(?:\.exe)?\b[^\r\n]*\/w\b/i },
  // Require flash/write/the firmware — bare "npm install firmware" is a package name.
  { category: "firmware", label: "firmware/BIOS update", pattern: /(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)fwupdmgr\b[^\r\n]*\b(?:install|update|refresh)\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)flashrom\b[^\r\n]*(?:-w|--write|\bwrite\b)|\b(?:flash|update|write|set)[ -]*(?:bios|uefi)\b|\b(?:flash|write)\s+(?:the\s+)?firmware\b|(?:^|[;&|\r\n]\s*|&&\s*|\|\|\s*)(?:Update|Set|Write)-Firmware\b|\b(?:flash|update|write|install|erase)\s+the\s+(?:firmware|bios|uefi)\b/i }
];

/** Soft shell wrappers: re-scan the nested payload, do not hard-gate the wrapper alone. */
const NESTED_SHELL_WRAPPER_PATTERN = /\b(?:(?:bash|sh|zsh|dash|ash|ksh|fish|csh|tcsh|tclsh|wish)(?:\.exe)?\b|(?:powershell|pwsh)(?:\.exe)?\b|cmd(?:\.exe)?\b|(?:python|python3|node|perl|ruby|php|lua|Rscript|julia|elixir|bun|deno|erl)(?:\.exe)?\b|\bscript(?:\.exe)?\b|\bosascript\b|\bssh(?:\.exe)?\b|\bansible\b|\bexpect\b|\b(?:at|batch)\b|(?:Invoke-Expression|\biex|eval)\b|\bschtasks(?:\.exe)?\b)/i;
const FIND_MUTATING_ACTION_PATTERN = /\bfind\b[^\r\n]*\s-(?:delete|exec|execdir|ok|okdir)\b/i;

const MUTATING_COMMAND_PATTERN = /\b(?:rm|mv|cp|mkdir|touch|install|truncate|shred|unlink|del|erase|rd|rmdir|copy|move|rename|Set-Content|Add-Content|Clear-Content|Clear-Item|Out-File|Export-Csv|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Expand-Archive|Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|ri|ni|mi|ci|tar|unzip|tee|rsync|ln|mount|umount|chmod|chown|setfacl|robocopy|xcopy)\b|\b(?:sed|perl)\b[^\r\n]*(?:\s-i\b|--in-place\b)|\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\r\n]*(?:-O\b|--output\b|-OutFile\b)\s*\S+|(?<![0-9])>{1,2}(?!&)|[0-9]>{1,2}(?!&)/i;
const USER_DATA_COMMAND_PATH_PATTERN = /(?:~(?:[A-Za-z0-9._-]+)?(?:[\\/]|$)|(?:%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)%|\$(?:\{)?(?:env:)?(?:USERPROFILE|HOME|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)\}?)(?:[\\/]|$)|(?:[A-Za-z]:[\\/]|\/)(?:Users|home|Documents and Settings)(?:[\\/]|$))/i;
// Absolute OS roots only — not project-relative `src/lib` / `docs/dev` / Windows `C:\dev`.
// `/dev/null` and friends are not system mutations. `/*` and `/.` count as root wipes.
const SYSTEM_COMMAND_PATH_PATTERN = /(?:%(?:WINDIR|SYSTEMROOT|PROGRAMFILES|PROGRAMDATA)%|\$(?:\{)?(?:env:)?(?:WINDIR|SYSTEMROOT|PROGRAMFILES|PROGRAMDATA|SystemRoot)\}?|[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData|EFI)(?:[\\/\s"';&|]|$)|(?:^|[\s"'=<>])\/(?:private\/)?(?:etc|boot|sys|proc|usr|var|opt|root|sbin|bin|lib)(?:[\\/\s"';&|]|$)|(?:^|[\s"'=<>])\/dev\/(?!null(?:\b|$)|zero(?:\b|$)|stdin(?:\b|$)|stdout(?:\b|$)|stderr(?:\b|$)|fd(?:[\\/]|$)|tty(?:\b|$)|random(?:\b|$)|urandom(?:\b|$))|(?:^|[\s"'=])\/(?:\*+|\/|\.\/?)*(?:[\s"';&|]|$)|(?:^|[\s"'=])[A-Za-z]:[\\/](?:[\s"';&|]|$))/i;
const KERNEL_COMMAND_PATH_PATTERN = /(?:\/(?:proc\/sys|sys)(?:[\\/]|$)|\/(?:lib|usr\/lib)\/modules(?:[\\/]|$)|(?:[A-Za-z]:[\\/]Windows[\\/]System32[\\/]drivers)(?:[\\/]|$))/i;
// Project paths like src/modules must not count as driver mutations.
const DRIVER_COMMAND_PATH_PATTERN = /(?:\/(?:lib|usr\/lib)\/modules(?:[\\/]|$)|(?:[A-Za-z]:[\\/]Windows[\\/]System32[\\/]drivers)(?:[\\/]|$))/i;
const BOOT_COMMAND_PATH_PATTERN = /(?:\/(?:boot|efi)(?:[\\/]|$)|(?:[A-Za-z]:[\\/])(?:boot|efi)(?:[\\/]|$))/i;
const DISK_COMMAND_PATH_PATTERN = /(?:\/dev\/(?:sd|nvme|vd|xvd|mmcblk|disk)|\\\\\.\\physicaldrive)/i;
const FIRMWARE_COMMAND_PATH_PATTERN = /(?:\/sys\/firmware(?:[\\/]|$)|\/sys\/devices\/virtual\/dmi(?:[\\/]|$)|(?:[A-Za-z]:[\\/](?:Windows[\\/]System32[\\/])?firmware)(?:[\\/]|$))/i;

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[rf]*|--recursive|--force)/i, label: "rm -rf / rm --recursive" },
  { pattern: /\bsudo\b/i, label: "sudo" },
  { pattern: /\b(chmod|chown)\b.*777/i, label: "chmod/chown 777" },
  { pattern: /\bdd\s+(if|of)=/i, label: "dd disk write" },
  { pattern: /\bmkfs\./i, label: "mkfs" },
  { pattern: /\b(fdisk|parted)\b/i, label: "partition tool" },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh/i, label: "pipe-to-shell" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh/i, label: "pipe-to-shell" },
  { pattern: /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|curl\.exe|wget\.exe)\b[^\r\n]*\|\s*(?:Invoke-Expression|iex)\b/i, label: "pipe-to-powershell" },
  { pattern: /\b(?:Remove-Item|ri)\b(?=[^\r\n]*(?:-Recurse|-r)\b)(?=[^\r\n]*(?:-Force|-f)\b)/i, label: "Remove-Item -Recurse -Force" },
  { pattern: /\b(?:Set-ExecutionPolicy)\b[^\r\n]*(?:Bypass|Unrestricted)\b/i, label: "Set-ExecutionPolicy" },
  { pattern: /\b(?:Invoke-Expression|iex)\b/i, label: "Invoke-Expression" },
  { pattern: /\bgit\s+push\s+--force\b/i, label: "git push --force" },
  { pattern: /\b(git\s+reset\s+--hard|git\s+clean\s+-fd)/i, label: "destructive git" },
];

function leafcodeDataDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

function configPath(): string {
  return join(leafcodeDataDir(), CONFIG_FILE);
}

function parseMode(value: unknown): PermissionMode | undefined {
  if (value === "allow" || value === "ask" || value === "deny") return value;
  return undefined;
}

function parseSystemSafetyLevel(value: unknown): SystemSafetyLevel | undefined {
  if (value === false) return "off";
  if (value === true) return "standard";
  if (value === "off" || value === "low" || value === "standard" || value === "strict") return value;
  return undefined;
}

function safetyConfigOf(level: SystemSafetyLevel | undefined): { systemSafety?: SystemSafetyLevel } {
  return level === undefined ? {} : { systemSafety: level };
}

function systemSafetyLevelOf(config: StoredConfig): SystemSafetyLevel {
  return config.systemSafety ?? "standard";
}

/** Critical machine-breaking matches kept at the "low" intensity. */
function isLowIntensityMatch(match: SystemSafetyMatch): boolean {
  if (match.label === LEAFCODE_PI_STOP_LABEL) return true;
  if (
    match.category === "disk"
    || match.category === "firmware"
    || match.category === "boot"
    || match.category === "kernel"
    || match.category === "driver"
  ) {
    return true;
  }
  if (match.category === "os") {
    return match.label === "OS shutdown/restart"
      || match.label === "privilege elevation"
      || match.label === "protected OS path"
      || match.label === "system path mutation"
      || match.label === "infrastructure destroy";
  }
  return false;
}

function readConfig(): StoredConfig {
  try {
    const { readFileSync } = require("node:fs");
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as {
      mode?: unknown;
      systemSafety?: unknown;
      sessions?: unknown;
    };
    const mode = parseMode(raw?.mode) ?? "allow";
    const hasSafety = raw != null && Object.prototype.hasOwnProperty.call(raw, "systemSafety");
    const systemSafety = hasSafety ? parseSystemSafetyLevel(raw.systemSafety) : undefined;
    const sessions: Record<string, PermissionMode> = {};
    if (raw?.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions)) {
      for (const [key, value] of Object.entries(raw.sessions as Record<string, unknown>)) {
        const parsed = parseMode(value);
        if (parsed) sessions[key] = parsed;
      }
    }
    return Object.keys(sessions).length > 0
      ? { mode, ...safetyConfigOf(systemSafety), sessions }
      : { mode, ...safetyConfigOf(systemSafety) };
  } catch {
    /* ignore */
  }
  return { mode: "allow" };
}

function writeConfig(mode: PermissionMode, sessionId?: string): void {
  try {
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { dirname } = require("node:path");
    const file = configPath();
    const current = readConfig();
    const next: StoredConfig = sessionId
      ? { mode: current.mode, ...safetyConfigOf(current.systemSafety), sessions: { ...current.sessions, [sessionId]: mode } }
      : { mode, ...safetyConfigOf(current.systemSafety), sessions: current.sessions };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn("[leafcode-permission-gate] failed to persist permission mode:", error);
  }
}

/**
 * Pi recreates ExtensionContext per event (createContext()), so mode cannot
 * live on the ctx object. Persist to disk and re-read on every tool_call.
 * Session-scoped entries win; `mode` is only the default for new sessions.
 */
function sessionMode(ctx: ExtensionContext, config = readConfig()): PermissionMode {
  const sessionId = extensionSessionId(ctx);
  if (sessionId && config.sessions?.[sessionId]) return config.sessions[sessionId];
  return config.mode;
}

export function configuredSafetyMatches(
  config: StoredConfig,
  matches: readonly SystemSafetyMatch[],
): readonly SystemSafetyMatch[] {
  const level = systemSafetyLevelOf(config);
  if (level === "off") {
    return matches.filter((match) => match.label === LEAFCODE_PI_STOP_LABEL);
  }
  // low/standard: only machine-breaking ops. Everyday work (git show, services,
  // packages, etc.) does not enter the approval flow.
  if (level === "low" || level === "standard") {
    return matches.filter((match) => isLowIntensityMatch(match));
  }
  return matches;
}

function setSessionMode(ctx: ExtensionContext, mode: PermissionMode): void {
  writeConfig(mode, extensionSessionId(ctx) || undefined);
}

export function getPermissionMode(ctx: ExtensionContext): PermissionMode {
  return sessionMode(ctx);
}

export function setPermissionMode(ctx: ExtensionContext, mode: PermissionMode): void {
  setSessionMode(ctx, mode);
}

const USER_DATA_PATH_PATTERN = /^(?:~(?:[A-Za-z0-9._-]+)?(?:\/|$)|%(?:userprofile|appdata|localappdata|homedrive|homepath)%(?:\/|$)|\$(?:\{)?(?:env:)?(?:userprofile|home|appdata|localappdata|homedrive|homepath)\}?(?:\/|$)|(?:[a-z]:\/|\/)(?:users|home|documents and settings)(?:\/|$))/i;
const OS_PATH_PATTERN = /^(?:%(?:windir|systemroot|programfiles|programdata)%(?:\/|$)|\$(?:\{)?(?:env:)?(?:windir|systemroot|programfiles|programdata|systemroot)\}?(?:\/|$)|[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata|efi)(?:\/|$)|[a-z]:\/$|\/(?:private\/)?(?:etc|boot|sys|proc|usr|var|opt|root|sbin|bin|lib)(?:\/|$)|\/dev\/(?!null(?:\/|$)|zero(?:\/|$)|stdin(?:\/|$)|stdout(?:\/|$)|stderr(?:\/|$)|fd(?:\/|$)|tty(?:\/|$)|random(?:\/|$)|urandom(?:\/|$))|\/$)/i;
const KERNEL_PATH_PATTERN = /^(?:\/(?:proc\/sys|sys|lib\/modules|usr\/lib\/modules)(?:\/|$)|[a-z]:\/windows\/system32\/drivers(?:\/|$))/i;
const DRIVER_PATH_PATTERN = /^(?:\/(?:lib\/modules|usr\/lib\/modules)(?:\/|$)|[a-z]:\/windows\/system32\/drivers(?:\/|$))/i;
const BOOT_PATH_PATTERN = /^(?:\/(?:boot|efi)(?:\/|$)|[a-z]:\/(?:boot|efi)(?:\/|$))/i;
const DISK_PATH_PATTERN = /^(?:\/dev\/(?:sd|nvme|vd|xvd|mmcblk|disk)|\/\/\.\/physicaldrive)/i;
const FIRMWARE_PATH_PATTERN = /^(?:\/sys\/firmware(?:\/|$)|\/sys\/devices\/virtual\/dmi(?:\/|$)|[a-z]:\/(?:windows\/system32\/)?firmware(?:\/|$))/i;
const REGISTRY_PATH_PATTERN = /^(?:registry::|(?:hkey_(?:local_machine|current_user|classes_root|users|current_config)|hk(?:lm|cu|cr|u|cc))(?:[\/:]|$))/i;

// Only real command-bearing fields. prompt/message/query must not trigger hard-gates
// from prose like "do not run Stop-Computer".
const COMMAND_INPUT_KEYS = new Set([
  "command",
  "cmd",
  "commandline",
  "command_line",
  "script",
  "code",
  "shell",
  "args",
  "parameters",
]);
const PATH_INPUT_KEYS = new Set([
  "path",
  "filepath",
  "file_path",
  "target",
  "destination",
  "source",
  "file",
  "directory",
  "dir",
  "location",
  "root",
  "volume",
  "device",
  "key",
  "registry",
  "registrypath",
]);
const CUSTOM_SYSTEM_TOOL_RULES: readonly SystemSafetyRule[] = [
  // Narrow names: bare "run"/"execute" false-positives docker/blender MCP tools.
  { category: "os", label: "custom system-command tool", pattern: /(?:^|[_:.-])(?:shell|terminal|powershell|bash|cmd)(?:[_:.-]|$)|(?:^|[_:.-])exec(?:[_:.-]|$)/i },
  { category: "os", label: "custom command-execution tool", pattern: /(?:^|[_:.-])(?:run|exec|execute)[_-](?:command|shell|script|code)(?:[_:.-]|$)/i },
  { category: "kernel", label: "custom kernel mutation tool", pattern: /(?:kernel.*(?:load|unload|write|update)|(?:load|unload|write|update).*kernel)/i },
  { category: "driver", label: "custom driver mutation tool", pattern: /(?:driver.*(?:install|uninstall|remove|update|write)|(?:install|uninstall|remove|update|write).*driver)/i },
  { category: "registry", label: "custom registry mutation tool", pattern: /(?:(?:registry|reg).*?(?:add|set|write|delete|remove|import|update)|(?:add|set|write|delete|remove|import|update).*?(?:registry|reg))/i },
  { category: "service", label: "custom service mutation tool", pattern: /(?:(?:service|systemd).*?(?:create|config|start|stop|restart|enable|disable|delete|remove)|(?:create|config|start|stop|restart|enable|disable|delete|remove).*?(?:service|systemd))/i },
  { category: "boot", label: "custom boot mutation tool", pattern: /(?:boot.*?(?:write|set|update|install|repair|delete)|(?:write|set|update|install|repair|delete).*?boot)/i },
  { category: "disk", label: "custom disk mutation tool", pattern: /(?:(?:disk|partition|volume).*?(?:write|erase|format|wipe|create|delete|resize)|(?:write|erase|format|wipe|create|delete|resize).*?(?:disk|partition|volume))/i },
  { category: "firmware", label: "custom firmware mutation tool", pattern: /(?:(?:firmware|bios|uefi).*?(?:flash|write|update|install|erase)|(?:flash|write|update|install|erase).*?(?:firmware|bios|uefi))/i },
];
const CUSTOM_COMMAND_TOOL_PATTERN = /(?:^|[_:.-])(?:shell|terminal|powershell|bash|cmd)(?:[_:.-]|$)|(?:^|[_:.-])exec(?:[_:.-]|$)|(?:^|[_:.-])(?:run|exec|execute)[_-](?:command|shell|script|code)(?:[_:.-]|$)|(?:^|[_:.-])(?:python|node|perl|ruby|eval|script)[_-](?:exec|run|evaluate)(?:[_:.-]|$)/i;
const CUSTOM_PATH_MUTATION_TOOL_PATTERN = /(?:^|[_:.-])(?:write|edit|delete|remove|move|copy|create|install|uninstall|update|set|format|erase|wipe|flash)(?:[_:.-]|$)/i;

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) return false;
  return /[\\/]|^~|^[A-Za-z]:|^%|^\$(?:\{)?(?:env:)?(?:USERPROFILE|HOME|WINDIR|SYSTEMROOT)|^(?:HK(?:LM|CU|CR|U|CC)|HKEY_|Registry::)/i.test(trimmed);
}

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function pushSafetyMatch(matches: SystemSafetyMatch[], match: SystemSafetyMatch): void {
  if (!matches.some((current) => current.category === match.category && current.label === match.label)) {
    matches.push(match);
  }
}

function isReadOnlyDiskInspection(command: string): boolean {
  const normalized = command.trim();
  if (/[\r\n;&|`]/.test(normalized)) return false;
  // Help-only invocations are not destructive: `format.com /?`, `mkfs --help`, `Format-Volume -?`
  if (/\b(?:mkfs(?:\.\w+)?|fdisk|sfdisk|parted|cfdisk|sgdisk|wipefs|diskpart|diskutil|format(?:\.com|\.exe)?|(?:Format|Resize|New|Remove|Set)-Volume|vssadmin|cipher)\b[^\r\n]*(?:\/\?|--help|-h\b|-\?)/i.test(normalized)
    && !/\s+[A-Za-z]:(?:\s|$|\/)/.test(normalized)
    && !/\/w\b/i.test(normalized)
    && !/\bdelete\b[^\r\n]*\bshadows\b/i.test(normalized)) {
    return true;
  }
  return [
    /^diskutil\s+list(?:\s+\S+)?$/i,
    /^diskutil\s+info\s+\S+$/i,
    /^diskutil\s+apfs\s+list(?:\s+\S+)?$/i,
    /^(?:fdisk|sfdisk)\s+(?:-l|--list)(?:\s+\S+)?$/i,
    /^parted\s+(?:(?:-l|--list)|\S+\s+print)$/i,
    /^sgdisk\s+(?:-p|--print)(?:\s+\S+)*$/i,
  ].some((pattern) => pattern.test(normalized));
}

/** `cp /etc/os-release .` copies out of OS paths — not a system-path mutation. */
function isCopyOutFromSystemPath(command: string): boolean {
  if (!/\b(?:cp|copy|Copy-Item|ci|rsync|xcopy|robocopy)\b/i.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const dest = (tokens[tokens.length - 1] ?? "").replace(/^["']|["']$/g, "");
  if (!dest || dest === "." || dest === ".." || /^\.\.?[\\/]/.test(dest)) return true;
  // Destination itself is an OS path → still a mutation into the system tree.
  return !SYSTEM_COMMAND_PATH_PATTERN.test(` ${dest} `);
}

/** Pull nested payloads from soft wrappers like `bash -c '...'` / `node -e "..."` / EncodedCommand. */
function extractNestedShellCommands(command: string): string[] {
  if (
    !NESTED_SHELL_WRAPPER_PATTERN.test(command)
    && !/[-\/](?:EncodedCommand|enc|encoded|ec|e)\b/i.test(command)
    && !/\b(?:os\.system|os\.execute|subprocess\.|child_process|execSync|execFile|passthru|Deno\.Command|Bun\.spawn)\b/i.test(command)
    && !/\b(?:system|exec|passthru|shell_exec)\s*\(/i.test(command)
    && !/\bos:cmd\s*\(/i.test(command)
    && !/\bdo\s+shell\s+script\b/i.test(command)
    && !/\|\s*(?:(?:env|busybox|nice|time|xargs)\s+)*(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:bash|sh|zsh|dash|ash|pwsh|powershell|cmd)\b/i.test(command)
  ) {
    return [];
  }
  const nested: string[] = [];
  const push = (value: string | undefined) => {
    const payload = value?.trim();
    if (payload && !/^\$?['"]$/.test(payload)) nested.push(payload.replace(/^\$/, ""));
  };
  const quoted = [
    // Flags may appear before -c; allow bash.exe / dash / ash / ANSI-C $'...'
    /\b(?:bash|sh|zsh|dash|ash|ksh|fish|csh|tcsh)(?:\.exe)?\b[^\r\n]*?-[^\s]*c[^\s]*\s+(\$)?(['"])([\s\S]*?)\2/gi,
    // Value-bearing flags before -Command: -WindowStyle Hidden -Command '...'
    // Also slash forms: /Command /c
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?[-\/](?:c|Command)\s+(['"])([\s\S]*?)\1/gi,
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?[-\/](?:c|Command)\s+\{([\s\S]*?)\}/gi,
    // cmd /c /k /r and git-bash //c
    /\bcmd(?:\.exe)?\b(?:\s+\S+)*?\s+\/\/?[ckr]\s+(['"])([\s\S]*?)\1/gi,
    // Interpreters with leading -r / --eval / -p flags
    // Interpreters with leading -r / --eval / -p flags
    /\b(?:python|python3|node|perl|ruby|php|lua|Rscript|julia|elixir|bun|deno|erl)(?:\.exe)?\b[^\r\n]*?\s+(?:-e|--eval|-p|-c|-r|eval)\s+(['"])([\s\S]*?)\1/gi,
    // script(1) -c '...'
    /\bscript(?:\.exe)?\b[^\r\n]*?-c\s+(['"])([\s\S]*?)\1/gi,
    // schtasks /tr "payload"
    /\bschtasks(?:\.exe)?\b[^\r\n]*\/tr\s+(['"])([\s\S]*?)\1/gi,
    // osascript -e '...'
    /\bosascript\b[^\r\n]*?-e\s+(['"])([\s\S]*?)\1/gi,
    // ssh user@host 'remote command'
    /\bssh(?:\.exe)?\b[^\r\n]*?\s+(['"])([\s\S]*?)\1/gi,
    // ansible ... -a 'command'
    /\bansible\b[^\r\n]*?-a\s+(['"])([\s\S]*?)\1/gi,
    // expect -c '...'
    /\bexpect\b[^\r\n]*?-c\s+(['"])([\s\S]*?)\1/gi,
    /\b(?:Invoke-Expression|\biex|eval)\b\s+(['"])([\s\S]*?)\1/gi,
    /\bInvoke-Command\b[^\r\n]*-ScriptBlock\s*\{([\s\S]*?)\}/gi,
    /\b(?:Start-Process|saps)\b[^\r\n]*-(?:ArgumentList|Args)\s+(['"])([\s\S]*?)\1/gi,
  ];
  for (const pattern of quoted) {
    for (const match of command.matchAll(pattern)) {
      push(match[3] ?? match[2] ?? match[1]);
    }
  }
  for (const match of command.matchAll(/&\s*\{([\s\S]*?)\}/g)) push(match[1]);
  for (const match of command.matchAll(
    /\b(?:bash|sh|zsh|dash|ash|ksh|fish|csh|tcsh)(?:\.exe)?\b[^\r\n]*?-[^\s]*c[^\s]*\s+(?!['"{$])(\S+)/gi,
  )) {
    push(match[1]);
  }
  for (const match of command.matchAll(/\bscript(?:\.exe)?\b[^\r\n]*?-c\s+(?!['"])(\S+)/gi)) {
    push(match[1]);
  }
  for (const match of command.matchAll(/\bschtasks(?:\.exe)?\b[^\r\n]*\/tr\s+(?!['"])(\S+)/gi)) {
    push(match[1]);
  }
  for (const match of command.matchAll(/\bcmd(?:\.exe)?\b(?:\s+\S+)*?\s+\/\/?[ckr]\s+(?!['"])(.+?)(?=$|[;&\n])/gi)) {
    push(match[1]);
  }
  for (const match of command.matchAll(
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?[-\/](?:c|Command)\s+(?!['"{])(.+?)(?=$|[;&\n])/gi,
  )) {
    push(match[1]);
  }
  for (const match of command.matchAll(
    /\b(?:Invoke-Expression|\biex|eval)\b\s+(?!['"])(.+?)(?=$|[;&\n])/gi,
  )) {
    push(match[1]);
  }
  for (const match of command.matchAll(
    /\b(?:Start-Process|saps)\b[^\r\n]*-(?:ArgumentList|Args)\s+(?!['"])(\S+)/gi,
  )) {
    push(match[1]);
  }
  for (const match of command.matchAll(
    /\b(?:os\.system|os\.popen|os\.execl|os\.execute|System\.cmd|subprocess\.(?:call|run|Popen|check_call|check_output)|(?:require\s*\(\s*['"]child_process['"]\s*\)\s*\.)?(?:exec|execSync|execFile|spawn|spawnSync)|child_process\.(?:exec|execSync|execFile|spawn|spawnSync)|system|exec|passthru|shell_exec|popen)\s*\(\s*(['"])([\s\S]*?)\1/gi,
  )) {
    push(match[2]);
  }
  for (const match of command.matchAll(
    /\bdo\s+shell\s+script\s+(['"])([\s\S]*?)\1/gi,
  )) {
    push(match[2]);
  }
  // Deno.Command('shutdown', ...) / Bun.spawn([...]) first argv
  for (const match of command.matchAll(
    /\b(?:Deno\.Command|Bun\.spawn(?:Sync)?)\s*\(\s*(['"])([^'"]+)\1/gi,
  )) {
    push(match[2]);
  }
  // Erlang os:cmd("...")
  for (const match of command.matchAll(/\bos:cmd\s*\(\s*(['"])([\s\S]*?)\1/gi)) {
    push(match[2]);
  }
  // Julia run(`cmd`) / Cmd literals
  for (const match of command.matchAll(/\brun\s*\(\s*`([^`]+)`\s*\)/gi)) {
    push(match[1]);
  }
  // tclsh/wish here-strings: tclsh <<< 'exec shutdown'
  for (const match of command.matchAll(
    /\b(?:tclsh|wish)(?:\.exe)?\b[^\r\n]*<<<\s*(['"])([\s\S]*?)\1/gi,
  )) {
    push(match[2]);
  }
  // tcl exec payload
  for (const match of command.matchAll(/\bexec\s+((?:shutdown|reboot|poweroff|halt)\b[^\r\n]*)/gi)) {
    push(match[1]);
  }
  for (const match of command.matchAll(
    /(?:^|[;&|\r\n]\s*)(?:echo|printf|print)\b([^|\r\n]*)\|\s*(?:at|batch)\b/gi,
  )) {
    push((match[1] ?? "").replace(/^['"\s]+|['"\s]+$/g, ""));
  }
  for (const match of command.matchAll(
    /\b(?:subprocess\.(?:call|run|Popen|check_call|check_output)|(?:require\s*\(\s*['"]child_process['"]\s*\)\s*\.)?(?:exec|execSync|execFile|spawn|spawnSync)|os\.execl)\s*\(\s*[\[(]\s*(['"])([^'"]+)\1/gi,
  )) {
    push(match[2]);
  }
  for (const match of command.matchAll(
    /\.\s*(?:spawn|execFile)(?:Sync)?\s*\(\s*(['"])([^'"]+)\1/gi,
  )) {
    push(match[2]);
  }
  for (const match of command.matchAll(
    /(?:^|[;&|\r\n]\s*)(?:echo|printf|print)\b([^|\r\n]*)\|\s*(?:(?:env|busybox|nice|time|xargs(?:\s+-[^\s|]+)*)\s+)*(?:[\\/]*(?:[\w.-]+[\\/])*)?(?:bash|sh|zsh|dash|ash|pwsh|powershell|cmd)(?:\.exe)?\b/gi,
  )) {
    push((match[1] ?? "").replace(/^['"\s]+|['"\s]+$/g, ""));
  }
  for (const match of command.matchAll(
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*[-\/](?:EncodedCommand|enc|encoded|ec|e)\s+([A-Za-z0-9+/=]+)/gi,
  )) {
    const encoded = match[1];
    if (!encoded) continue;
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf16le");
      push(decoded);
    } catch {
      /* ignore malformed base64 */
    }
  }
  return [...new Set(nested.filter(Boolean))];
}

/** `echo …` / `Write-Host …` with no unquoted shell operators — do not unwrap or path-gate. */
function isDocumentationOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!/^(?:echo|printf|print|Write-Host|Write-Output)\b/i.test(trimmed)) return false;
  const unquoted = trimmed.replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
  return !/[;&|]/.test(unquoted);
}

/** Drop heredoc bodies so `cat <<EOF` + shutdown text is not treated as running shutdown. */
function maskHeredocBodies(command: string): string {
  return command.replace(
    /(<<-?\s*['"]?)(\w+)(['"]?[^\r\n]*\r?\n)([\s\S]*?)(\r?\n\2\b)/gi,
    (_full, open: string, tag: string, mid: string, _body: string, close: string) =>
      `${open}${tag}${mid}${close}`,
  );
}

function matchSystemSafetyCommandInner(command: string, depth: number): SystemSafetyMatch[] {
  // Decode obfuscation the same way protected-path scanning does, so
  // `& ('Stop-' + 'Computer')` still hits the shutdown rule at low/standard.
  const masked = maskHeredocBodies(command);
  const docsOnly = isDocumentationOnlyCommand(masked);
  // Plain `echo 'shutdown; rm -rf /'` is documentation — do not classify the quoted body.
  if (docsOnly) {
    return [];
  }
  const decoded = collapseConcatenatedStrings(decodeCharCodes(masked));
  // Strip incidental quotes around command tokens: `"shutdown" /s`
  const normalized = decoded.replace(/\u0000/g, " ").replace(/(["'])(shutdown|reboot|poweroff|halt|Stop-Computer|Restart-Computer)\1/gi, "$2");
  const matches: SystemSafetyMatch[] = [];
  if (isLeafCodePiStopCommand(normalized)) {
    pushSafetyMatch(matches, { category: "os", label: LEAFCODE_PI_STOP_LABEL });
  }
  for (const rule of SYSTEM_SAFETY_RULES) {
    if (rule.category === "disk" && isReadOnlyDiskInspection(normalized)) continue;
    if (rule.pattern.test(normalized)) pushSafetyMatch(matches, rule);
  }

  const mutating = MUTATING_COMMAND_PATTERN.test(normalized)
    || FIND_MUTATING_ACTION_PATTERN.test(normalized);
  // Home / Users paths are normal coding targets on Windows. Do not hard-gate them;
  // destructive cases still hit DANGEROUS_PATTERNS / protected-paths.
  if (mutating && SYSTEM_COMMAND_PATH_PATTERN.test(normalized) && !isCopyOutFromSystemPath(normalized)) {
    pushSafetyMatch(matches, { category: "os", label: "system path mutation" });
  }
  if (mutating && KERNEL_COMMAND_PATH_PATTERN.test(normalized)) {
    pushSafetyMatch(matches, { category: "kernel", label: "kernel path mutation" });
  }
  if (mutating && DRIVER_COMMAND_PATH_PATTERN.test(normalized)) {
    pushSafetyMatch(matches, { category: "driver", label: "driver/module path mutation" });
  }
  if (mutating && BOOT_COMMAND_PATH_PATTERN.test(normalized)) {
    pushSafetyMatch(matches, { category: "boot", label: "boot path mutation" });
  }
  if (mutating && DISK_COMMAND_PATH_PATTERN.test(normalized)) {
    pushSafetyMatch(matches, { category: "disk", label: "device path mutation" });
  }
  if (mutating && FIRMWARE_COMMAND_PATH_PATTERN.test(normalized)) {
    pushSafetyMatch(matches, { category: "firmware", label: "firmware path mutation" });
  }

  // Allow deeper nesting (bash -c "bash -c \"bash -c shutdown\"") without unbounded recursion.
  if (depth < 4) {
    for (const nested of extractNestedShellCommands(masked)) {
      for (const match of matchSystemSafetyCommandInner(nested, depth + 1)) {
        pushSafetyMatch(matches, match);
      }
    }
    // Also scan the decoded form for nested wrappers that appeared after concat collapse.
    if (decoded !== masked) {
      for (const nested of extractNestedShellCommands(decoded)) {
        for (const match of matchSystemSafetyCommandInner(nested, depth + 1)) {
          pushSafetyMatch(matches, match);
        }
      }
    }
    // at/batch/deno heredocs may schedule or embed real commands; scan bodies before they are masked away.
    if (/\b(?:at|batch|deno)\b/i.test(command)) {
      for (const match of command.matchAll(
        /(<<-?\s*['"]?)(\w+)(['"]?[^\r\n]*\r?\n)([\s\S]*?)(\r?\n\2\b)/gi,
      )) {
        const body = match[4]?.trim();
        if (!body) continue;
        for (const nestedMatch of matchSystemSafetyCommandInner(body, depth + 1)) {
          pushSafetyMatch(matches, nestedMatch);
        }
      }
    }
  }
  return matches;
}

export function matchSystemSafetyCommand(command: string): SystemSafetyMatch[] {
  return matchSystemSafetyCommandInner(command, 0);
}

function normalizePathCandidate(value: string): string {
  let normalized = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  // Strip Windows extended-length / device prefixes so \\?\C:\Windows matches OS paths.
  normalized = normalized.replace(/^(?:\/\/\?\/|\/\/\.\/)/i, "");
  return normalized;
}

function pathCandidates(filePath: string, cwd: string): string[] {
  const candidates = [normalizePathCandidate(filePath)];
  try {
    candidates.push(normalizePathCandidate(resolvePath(cwd, filePath)));
  } catch {
    /* malformed paths remain covered by the raw candidate */
  }
  return [...new Set(candidates)];
}

export function matchSystemSafetyPath(filePath: string, cwd = process.cwd()): SystemSafetyMatch[] {
  const matches: SystemSafetyMatch[] = [];
  const rawInput = filePath.trim();
  // Relative paths like `src/lib/utils.ts` must not become "user data" just because cwd is under Users/.
  const relativeInput = !/^(?:[a-zA-Z]:[\\/]|\/|~|%|\$|\\\\)/.test(rawInput);
  for (const candidate of pathCandidates(filePath, cwd)) {
    const skipUserData = relativeInput && candidate !== normalizePathCandidate(rawInput);
    if (!skipUserData && USER_DATA_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "user-data", label: "user data path" });
    }
    if (OS_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "os", label: "protected OS path" });
    }
    if (KERNEL_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "kernel", label: "kernel path" });
    }
    if (DRIVER_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "driver", label: "driver/module path" });
    }
    if (BOOT_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "boot", label: "boot path" });
    }
    if (DISK_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "disk", label: "physical disk path" });
    }
    if (FIRMWARE_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "firmware", label: "firmware path" });
    }
    if (REGISTRY_PATH_PATTERN.test(candidate)) {
      pushSafetyMatch(matches, { category: "registry", label: "registry path" });
    }
  }
  return matches;
}

function collectLeafStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeafStrings(item, output);
    return;
  }
  const record = asRecord(value);
  if (record) {
    for (const child of Object.values(record)) collectLeafStrings(child, output);
  }
}

function collectStringFields(value: unknown, keys: ReadonlySet<string>, output: string[]): void {
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) for (const item of value) collectStringFields(item, keys, output);
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key.toLowerCase())) collectLeafStrings(child, output);
    else collectStringFields(child, keys, output);
  }
}

export function matchSystemSafetyForTool(
  toolName: string,
  input: unknown,
  cwd = process.cwd(),
): SystemSafetyMatch[] {
  if (toolName === "bash" || toolName === "powershell") {
    const command = asRecord(input)?.command;
    return typeof command === "string" ? matchSystemSafetyCommand(command) : [];
  }
  if (toolName === "write" || toolName === "edit") {
    const filePath = asRecord(input)?.path;
    if (typeof filePath !== "string") return [];
    const matches = matchSystemSafetyPath(filePath, cwd);
    // user-data is informational for path classification only; never hard-gate it.
    return matches.filter((match) => match.category !== "user-data");
  }
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return [];

  const matches: SystemSafetyMatch[] = [];
  for (const rule of CUSTOM_SYSTEM_TOOL_RULES) {
    if (rule.pattern.test(toolName)) pushSafetyMatch(matches, rule);
  }
  const commands: string[] = typeof input === "string" ? [input] : [];
  collectStringFields(input, COMMAND_INPUT_KEYS, commands);
  for (const command of [...new Set(commands)]) {
    if (!command) continue;
    for (const match of matchSystemSafetyCommand(command)) pushSafetyMatch(matches, match);
  }
  const paths: string[] = typeof input === "string" && looksLikePath(input) ? [input] : [];
  collectStringFields(input, PATH_INPUT_KEYS, paths);
  if (CUSTOM_PATH_MUTATION_TOOL_PATTERN.test(toolName)) {
    const leafs: string[] = [];
    collectLeafStrings(input, leafs);
    for (const leaf of leafs) {
      if (looksLikePath(leaf)) paths.push(leaf);
    }
  }
  for (const filePath of [...new Set(paths)]) {
    if (!looksLikePath(filePath)) continue;
    for (const match of matchSystemSafetyPath(filePath, cwd)) {
      if (match.category === "user-data") continue;
      pushSafetyMatch(matches, match);
    }
  }
  if (CUSTOM_COMMAND_TOOL_PATTERN.test(toolName) && commands.length === 0) {
    pushSafetyMatch(matches, { category: "os", label: "custom command execution" });
  }
  return matches;
}

function messageText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const block = asRecord(part);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("\n");
}

function hasSafetyPlanText(text: string): boolean {
  return /(?:影響|impact|scope|対象)/iu.test(text) && /(?:復旧|ロールバック|recovery|rollback|restore|backup)/iu.test(text);
}

function isExplicitApprovalText(text: string): boolean {
  return /^(?:yes|y|はい|承認(?:します)?|許可(?:します)?|実行(?:して|します)?|進めて|続行)(?:[!！。、,，\s]|$)/iu.test(text.trim());
}

function hasSafetyPlan(messages: AgentEndEvent["messages"]): boolean {
  return messages.some((message) => message.role === "assistant" && hasSafetyPlanText(messageText(message)));
}

function isReadOnlyInvestigation(
  toolName: string,
  input: unknown,
  categories: ReadonlySet<SystemSafetyCategory>,
  cwd: string,
): boolean {
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    const paths: string[] = [];
    collectStringFields(input, PATH_INPUT_KEYS, paths);
    return (paths.length > 0 ? paths : [cwd]).some((filePath) => matchSystemSafetyPath(filePath, cwd)
      .some((match) => categories.has(match.category)));
  }
  if (toolName !== "bash" && toolName !== "powershell") return false;
  const command = asRecord(input)?.command;
  if (typeof command !== "string" || matchedDanger(command).dangerous || MUTATING_COMMAND_PATTERN.test(command)) return false;
  const rules: Array<[SystemSafetyCategory, RegExp]> = [
    ["os", /\b(?:Get-ComputerInfo|systeminfo|uname|sw_vers|ver\b|hostname|Get-CimInstance\b[^\r\n]*Win32_OperatingSystem)\b/i],
    ["user-data", USER_DATA_COMMAND_PATH_PATTERN],
    ["kernel", /\b(?:uname|lsmod|modinfo|sysctl\s+-a|Get-CimInstance)\b/i],
    ["driver", /\b(?:driverquery|lsmod|modinfo|pnputil(?:\.exe)?\s+\/(?:enum-drivers|enum-devices))\b/i],
    ["registry", /\b(?:reg(?:\.exe)?\s+query|Get-(?:Item|ItemProperty)\b[^\r\n]*(?:HK(?:LM|CU|CR|U|CC)|Registry::))\b/i],
    ["service", /\b(?:Get-Service|systemctl\s+(?:status|show|list)|sc(?:\.exe)?\s+query|service\s+\S+\s+status)\b/i],
    ["boot", /\b(?:bcdedit(?:\.exe)?\s+\/enum|efibootmgr\s*$)\b/i],
    ["disk", /\b(?:lsblk|findmnt|Get-Disk|Get-Volume|Get-Partition)\b/i],
    ["firmware", /\b(?:dmidecode|fwupdmgr\s+(?:get-devices|get-updates))\b/i],
  ];
  return (isReadOnlyDiskInspection(command) && categories.has("disk"))
    || rules.some(([category, pattern]) => categories.has(category) && pattern.test(command));
}

function operationIdentity(toolName: string, input: unknown): string {
  try {
    return `${toolName}:${JSON.stringify(input) ?? ""}`;
  } catch {
    return `${toolName}:unserializable`;
  }
}

function operationText(toolName: string, input: unknown): string {
  const record = asRecord(input);
  if (toolName === "bash" || toolName === "powershell") {
    const command = record?.command;
    if (typeof command === "string") return command;
  }
  if (toolName === "write" || toolName === "edit") {
    const filePath = record?.path;
    if (typeof filePath === "string") return `${toolName}: ${filePath}`;
  }
  const commands: string[] = typeof input === "string" ? [input] : [];
  collectStringFields(input, COMMAND_INPUT_KEYS, commands);
  if (commands[0]) return `${toolName}: ${commands.join(" ")}`;
  const paths: string[] = [];
  collectStringFields(input, PATH_INPUT_KEYS, paths);
  if (paths[0]) return `${toolName}: ${paths[0]}`;
  return `${toolName}: details redacted`;
}

function safetyLabels(matches: readonly SystemSafetyMatch[]): string[] {
  return [...new Set(matches.map((match) => `${match.category}: ${match.label}`))];
}

function safetyKey(matches: readonly SystemSafetyMatch[]): string {
  return [...new Set(matches.map((match) => match.category))].sort().join("|");
}

function preflightRequiredReason(operation: string, matches: readonly SystemSafetyMatch[]): string {
  return [
    `System safety guard blocked this operation: ${operation}`,
    `検出: ${safetyLabels(matches).join(", ")}`,
    "実行前に read-only の調査を行い、対象・影響範囲・失敗時の復旧手順をユーザーへ提示してください。",
    "その内容を確認したユーザーが、この操作を明示承認するまで実行・再試行しないでください。",
  ].join("\n");
}

async function requireSystemSafetyApproval(
  ctx: ExtensionContext,
  operation: string,
  matches: readonly SystemSafetyMatch[],
): Promise<{ block: true; reason: string; terminate: true } | undefined> {
  const labels = safetyLabels(matches);
  const message = [
    "システム安全ガード: OS・ユーザーデータ・カーネル・ドライバー・レジストリ・サービス・boot・disk・firmware に影響する可能性があります。",
    "read-only 調査と、対象・影響範囲・失敗時の復旧手順の提示を確認しました。",
    `検出: ${labels.join(", ")}`,
    `対象: ${operation}`,
    "この操作を今回1回だけ明示的に許可しますか?",
  ].join("\n");
  try {
    if (!ctx.hasUI) {
      const approved = await requestWebUiPermission({
        sessionId: extensionSessionId(ctx),
        command: operation,
        labels,
        message,
      });
      if (approved === true) return undefined;
      return {
        block: true,
        terminate: true,
        reason: approved === null
          ? "System safety guard blocked the operation (no UI for explicit approval)"
          : "System safety guard: operation denied by user",
      };
    }
    const choice = await ctx.ui.select(message, ["Yes", "No"]);
    if (choice === "Yes") return undefined;
    return { block: true, terminate: true, reason: "System safety guard: operation denied by user" };
  } catch {
    return { block: true, terminate: true, reason: "System safety guard blocked the operation (approval prompt failed)" };
  }
}

function blockedUserBashResult(reason: string) {
  return {
    result: {
      output: reason,
      exitCode: 126,
      cancelled: false,
      truncated: false,
    },
  };
}

function isProtectedPath(path: string): { protected: boolean; reason?: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const protectedSegments = segments.map((segment) => segment.toLowerCase());
  // Windows paths are case-insensitive; use the same protection on every platform
  // so a path's casing cannot bypass the guard when a project moves between hosts.
  // Match `.env`, `.env.local`, `.env.production`, etc.
  if (protectedSegments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return { protected: true, reason: 'protected path ".env*"' };
  }
  if (protectedSegments.includes(".git")) return { protected: true, reason: 'protected path ".git/"' };
  if (protectedSegments.includes("node_modules")) {
    return { protected: true, reason: 'protected path "node_modules/"' };
  }
  if (protectedSegments.includes(".ssh")) return { protected: true, reason: 'protected path ".ssh/"' };
  if (protectedSegments.includes(".aws")) return { protected: true, reason: 'protected path ".aws/"' };
  const authPath = ".pi/agent/auth.json";
  const normalizedLower = normalized.toLowerCase();
  if (normalizedLower === authPath || normalizedLower.endsWith(`/${authPath}`)) {
    return { protected: true, reason: `protected path "${authPath}"` };
  }
  return { protected: false };
}

/** Secrets stay blocked even for Pi `read`/`grep`/`ls`; `.git` / `node_modules` may be inspected. */
function isSecretProtectedReason(reason?: string): boolean {
  if (!reason) return false;
  return reason.includes('".env*"')
    || reason.includes('".ssh/"')
    || reason.includes('".aws/"')
    || reason.includes("auth.json");
}

const SECRET_PATH_INPUT_KEYS = new Set([
  "path",
  "filepath",
  "file_path",
  "target",
  "glob",
  "include",
  "file",
  "directory",
  "dir",
  "location",
  "root",
]);

function secretPathFromCandidate(candidate: string): { protected: boolean; reason?: string } {
  const asPath = isProtectedPath(candidate);
  if (asPath.protected && isSecretProtectedReason(asPath.reason)) return asPath;
  // Globs like `.env*` / `**/.ssh/**` are not valid path segments for isProtectedPath.
  if (/(?:^|[\\/])\.env(?:\.|[*?]|$)/i.test(candidate) || /^\.env(?:\.[\w.-]*)?[*?]?$/i.test(candidate.trim())) {
    return { protected: true, reason: 'protected path ".env*"' };
  }
  if (/(?:^|[\\/])\.ssh(?:[\\/]|[*?]|$)/i.test(candidate) || /^\.ssh(?:[\\/].*)?[*?]?$/i.test(candidate.trim())) {
    return { protected: true, reason: 'protected path ".ssh/"' };
  }
  if (/(?:^|[\\/])\.aws(?:[\\/]|[*?]|$)/i.test(candidate) || /^\.aws(?:[\\/].*)?[*?]?$/i.test(candidate.trim())) {
    return { protected: true, reason: 'protected path ".aws/"' };
  }
  if (/(?:^|[\\/])\.pi[\\/]agent[\\/]auth\.json$/i.test(candidate) || /auth\.json$/i.test(candidate.trim())) {
    // Only treat clear auth.json path targets as secret, not arbitrary "auth.json" prose in patterns.
    if (/auth\.json/i.test(candidate) && (/[\\/]/.test(candidate) || /^\.?pi\b/i.test(candidate) || candidate.trim() === "auth.json")) {
      return { protected: true, reason: 'protected path ".pi/agent/auth.json"' };
    }
  }
  return { protected: false };
}

/** Block when tool inputs name secret paths (e.g. grep glob=".env*", path=".env.local"). */
function toolInputTouchesSecretPath(toolName: string, input: unknown): { protected: boolean; reason?: string } {
  const candidates: string[] = [];
  collectStringFields(input, SECRET_PATH_INPUT_KEYS, candidates);
  // `find` uses `pattern` as a filename glob; `grep` uses it as content — only check find.
  if (toolName === "find") {
    collectStringFields(input, new Set(["pattern"]), candidates);
  }
  for (const candidate of [...new Set(candidates)]) {
    const hit = secretPathFromCandidate(candidate);
    if (hit.protected) return hit;
  }
  return { protected: false };
}

function decodeCharCodes(command: string): string {
  let text = command;
  text = text.replace(/String\.fromCharCode\s*\(([\d,\s]+)\)/gi, (full, nums: string) => {
    const codes = nums.split(",").map((part) => Number(part.trim()));
    if (codes.length === 0 || codes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) {
      return full;
    }
    return codes.map((code) => String.fromCharCode(code)).join("");
  });
  text = text.replace(/\b(?:chr|fromCharCode)\s*\(\s*(\d+)\s*\)/gi, (full, raw: string) => {
    const code = Number(raw);
    return Number.isInteger(code) && code >= 0 && code <= 255 ? String.fromCharCode(code) : full;
  });
  text = text.replace(/\[char\[\]\]\s*\(([\d,\s]+)\)/gi, (full, nums: string) => {
    const codes = nums.split(",").map((part) => Number(part.trim()));
    if (codes.length === 0 || codes.some((code) => !Number.isInteger(code) || code < 0 || code > 255)) {
      return full;
    }
    return codes.map((code) => String.fromCharCode(code)).join("");
  });
  text = text.replace(/\[(?:string\s*)?char\]\s*(\d+)/gi, (full, raw: string) => {
    const code = Number(raw);
    return Number.isInteger(code) && code >= 0 && code <= 255 ? String.fromCharCode(code) : full;
  });
  text = text.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  // ANSI-C / shell octal escapes: \164 → t
  text = text.replace(/\\([0-7]{1,3})/g, (full, oct: string) => {
    const code = parseInt(oct, 8);
    return Number.isInteger(code) && code <= 255 ? String.fromCharCode(code) : full;
  });
  // cmd.exe caret escapes: shut^down → shutdown
  text = text.replace(/\^(.)/g, "$1");
  return text;
}

function collapseConcatenatedStrings(command: string): string {
  let text = command;
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/(['"])([^'"]*)\1\s*\+\s*(['"])([^'"]*)\3/g, "$1$2$4$1");
    text = text.replace(/(\.[A-Za-z0-9._-]*)\s*\+\s*(['"])([^'"]*)\2/g, "$1$3");
    text = text.replace(/(['"])([^'"]*)\1\s*\+\s*(\.[A-Za-z0-9._-]*)/g, "$2$3");
    text = text.replace(/([A-Za-z0-9._-]+)\s*-join\s*(['"])\2/gi, "$1");
  }
  // Unwrap PowerShell call-operator forms: & ('Stop-Computer') → Stop-Computer
  previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/&\s*\(\s*(['"])([^'"]*)\1\s*\)/g, "$2");
    // ([char]46)+'env' after decode becomes (.)+'env'
    text = text.replace(/\(\s*\.\s*\)\s*\+\s*(['"])([^'"]*)\1/g, ".$2");
  }
  return text;
}

function commandVariantsForProtectedPath(command: string): string[] {
  const decoded = collapseConcatenatedStrings(decodeCharCodes(command));
  const variants = [command, decoded];
  for (const source of [command, decoded]) {
    for (const nested of extractNestedShellCommands(source)) {
      variants.push(nested, collapseConcatenatedStrings(decodeCharCodes(nested)));
    }
  }
  return [...new Set(variants.filter(Boolean))];
}

function matchProtectedPathLiteral(command: string): { protected: boolean; reason?: string } {
  if (/(?:^|[^A-Za-z0-9])\.env(?:\.[\w.-]+)?(?:$|[^A-Za-z0-9])/i.test(command)) {
    return { protected: true, reason: 'protected path ".env*"' };
  }
  if (/(?:^|[^A-Za-z0-9])\.git(?:$|[^A-Za-z0-9])/i.test(command)) {
    return { protected: true, reason: 'protected path ".git/"' };
  }
  if (/(?:^|[^A-Za-z0-9])\.ssh(?:$|[^A-Za-z0-9])/i.test(command)) {
    return { protected: true, reason: 'protected path ".ssh/"' };
  }
  if (/(?:^|[^A-Za-z0-9])\.aws(?:$|[^A-Za-z0-9])/i.test(command)) {
    return { protected: true, reason: 'protected path ".aws/"' };
  }
  // Require a path-like boundary so `process.env.NODE_MODULES` is not a hit.
  if (/(?:^|[\\/'":=\s])node_modules(?:[\\/'"\s]|$)/i.test(command)) {
    return { protected: true, reason: 'protected path "node_modules/"' };
  }
  if (/(?:^|[^A-Za-z0-9])\.pi[\\/]agent[\\/]auth\.json(?:$|[^A-Za-z0-9])/i.test(command)) {
    return { protected: true, reason: 'protected path ".pi/agent/auth.json"' };
  }
  return { protected: false };
}

/** Read-only git porcelain used constantly by agents; never treat as a protected-path hit. */
// Bare `git stash` defaults to push. Keep list/show/get/branch as read-only.
const GIT_MUTATING_SUBCOMMAND_PATTERN = /\bgit(?:\.exe)?\b[^\r\n]*\b(?:commit|push|add|reset|clean|rebase|merge|cherry-pick|am|apply|checkout|switch|restore|init|clone|fetch|pull|gc|repack|filter-branch|update-ref|branch\s+-[dDmM]|tag\s+-[dD]|stash(?!\s+(?:list|show|get|branch)\b)|remote\s+(?:add|remove|rm|rename|set-url)|config\s+(?!--(?:get|list)))\b/i;
const GIT_COMMAND_PATTERN = /(^|[;&|\n])\s*git(?:\.exe)?\b/i;
const READ_ONLY_FILE_COMMAND_PATTERN = /(^|[;&|\n])\s*(?:cat|head|tail|less|more|type|Get-Content|gc|Get-ChildItem|gci|ls|dir|Get-Item|gi|Test-Path|rg|grep|findstr|find|Select-String|cd|Set-Location|Push-Location|Pop-Location|pushd|popd)\b/i;

function isReadOnlyGitCommand(command: string): boolean {
  if (!GIT_COMMAND_PATTERN.test(command)) return false;
  return !GIT_MUTATING_SUBCOMMAND_PATTERN.test(command);
}

function isReadOnlyFileCommand(command: string): boolean {
  if (!READ_ONLY_FILE_COMMAND_PATTERN.test(command)) return false;
  // Unix `find .git -delete` is a mutation despite the command name.
  if (FIND_MUTATING_ACTION_PATTERN.test(command)) return false;
  return true;
}

/**
 * `.git` / `node_modules` may be inspected read-only under normal agent workflows
 * (`git show`, `cat .git/HEAD`, `ls node_modules`).
 * Searching for the string `.env` via grep/rg is allowed; opening the secret file is not.
 */
function allowsReadOnlyProtectedPathAccess(
  command: string,
  reason: string,
): boolean {
  const relaxableGitOrModules = reason.includes('".git/"') || reason.includes('"node_modules/"');
  const secretMention = isSecretProtectedReason(reason);
  if (!relaxableGitOrModules && !secretMention) return false;
  if (MUTATING_COMMAND_PATTERN.test(command) || matchedDanger(command).dangerous) return false;
  if (relaxableGitOrModules) {
    if (isReadOnlyGitCommand(command)) return true;
    return isReadOnlyFileCommand(command);
  }
  // Secret string search in docs/code — not `cat .env` / `grep x .env`.
  if (!/\b(?:grep|egrep|fgrep|rg|findstr|Select-String)\b/i.test(command)) return false;
  if (secretAppearsAsFileOperand(command)) return false;
  return true;
}

/** True when a secret path is a file being read/searched-in, not a grep pattern. */
function secretAppearsAsFileOperand(command: string): boolean {
  if (/(?:^|[\s])(?:cat|head|tail|less|more|type|Get-Content|gc)\b[^\r\n]*\.env\b/i.test(command)) {
    return true;
  }
  if (/[<>]\s*(?:\.[\\/])?\.env\b/i.test(command)) return true;
  // Select-String -Path .env / positional Select-String x .env / rg --glob=.env* / -g'.env'
  if (/\bSelect-String\b[^\r\n]*-(?:Path|LiteralPath)\s+\S*\.env\b/i.test(command)) return true;
  if (/\bSelect-String\b[^\r\n]*\s\.env(?:\.[\w.-]+)?(?:[\s"';&|]|$)/i.test(command)) return true;
  if (/\brg\b[^\r\n]*(?:--glob|--iglob|-g)\s*=?\s*['"]?[^'"\s]*\.env/i.test(command)) return true;
  if (/\b(?:grep|egrep|fgrep)\b[^\r\n]*--include\s*=?\s*['"]?[^'"\s]*\.env/i.test(command)) return true;
  // `grep PATTERN .env` / `rg PATTERN path/.env` — secret is a path operand after the pattern.
  if (/\b(?:grep|egrep|fgrep|rg|findstr)\b(?:\s+-[A-Za-z0-9]+|\s+--\S+)*\s+\S+[^\r\n]*?(?:^|[\s])(?:\.[\\/])?(?:[\w.-]+[\\/])*\.env(?:\.[\w.-]+)?(?:[\s"';&|]|$)/im.test(command)) {
    // Heuristic: if `.env` is the first positional arg after options, it is the pattern.
    const grepHead = command.match(
      /\b(?:grep|egrep|fgrep|rg|findstr)\b((?:\s+-[A-Za-z0-9]+|\s+--\S+)*)\s+(\S+)/i,
    );
    if (grepHead && /^["']?\.env(?:\.[\w.-]+)?["']?$/i.test(grepHead[2])) {
      return false;
    }
    return true;
  }
  return false;
}

/** Detect shell commands that write or touch protected paths (bypass of write/edit gate). */
function commandTouchesProtectedPath(command: string): { protected: boolean; reason?: string } {
  for (const variant of commandVariantsForProtectedPath(command)) {
    const match = matchProtectedPathLiteral(variant);
    if (!match.protected) continue;
    if (allowsReadOnlyProtectedPathAccess(variant, match.reason ?? "")) continue;
    return match;
  }
  return { protected: false };
}

function matchedDanger(command: string): { dangerous: boolean; labels: string[] } {
  const labels = DANGEROUS_PATTERNS
    .filter(({ label }) => !(label === "partition tool" && isReadOnlyDiskInspection(command)))
    .filter(({ pattern }) => pattern.test(command))
    .map((d) => d.label);
  return { dangerous: labels.length > 0, labels };
}

function extensionSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI): void {
  let safetyInvestigationObserved = false;
  let safetyPlanPresented = false;
  let pendingSafetyKey = "";
  const pendingSafetyCategories = new Set<SystemSafetyCategory>();
  const pendingInvestigationCalls = new Set<string>();

  const resetSafetyFlow = (): void => {
    safetyInvestigationObserved = false;
    safetyPlanPresented = false;
    pendingSafetyKey = "";
    pendingSafetyCategories.clear();
    pendingInvestigationCalls.clear();
  };

  pi.on("session_start", async () => {
    resetSafetyFlow();
  });

  pi.on("input", (event) => {
    if (event.source === "extension" || !pendingSafetyKey) return;
    if (safetyInvestigationObserved && hasSafetyPlanText(event.text)) {
      safetyPlanPresented = true;
      return;
    }
    if (safetyInvestigationObserved && safetyPlanPresented && isExplicitApprovalText(event.text)) return;
    resetSafetyFlow();
  });

  pi.on("message_end", (event) => {
    if (pendingSafetyKey && safetyInvestigationObserved && event.message.role === "assistant" && hasSafetyPlanText(messageText(event.message))) {
      safetyPlanPresented = true;
    }
  });

  pi.on("agent_end", (event) => {
    if (pendingSafetyKey && safetyInvestigationObserved && hasSafetyPlan(event.messages)) safetyPlanPresented = true;
  });

  pi.on("tool_result", (event) => {
    if (!pendingInvestigationCalls.delete(event.toolCallId)) return;
    if (!event.isError && pendingSafetyKey) safetyInvestigationObserved = true;
  });

  const requireSystemApproval = async (
    ctx: ExtensionContext,
    mode: PermissionMode,
    level: SystemSafetyLevel,
    operation: string,
    identity: string,
    safetyMatches: readonly SystemSafetyMatch[],
  ): Promise<{ block: true; terminate: true; reason: string } | undefined> => {
    const operationKey = `${safetyKey(safetyMatches)}\n${identity}`;
    if (mode === "deny") {
      resetSafetyFlow();
      return {
        block: true,
        terminate: true,
        reason: `${preflightRequiredReason(operation, safetyMatches)}\nPermission mode is deny.`,
      };
    }
    // low/standard: one-shot explicit approval without investigation/plan gates.
    if (level === "low" || level === "standard") {
      const result = await requireSystemSafetyApproval(ctx, operation, safetyMatches);
      resetSafetyFlow();
      return result;
    }
    if (pendingSafetyKey !== operationKey) {
      resetSafetyFlow();
      pendingSafetyKey = operationKey;
      for (const match of safetyMatches) pendingSafetyCategories.add(match.category);
      return {
        block: true,
        terminate: true,
        reason: preflightRequiredReason(operation, safetyMatches),
      };
    }
    if (!safetyInvestigationObserved || !safetyPlanPresented) {
      return {
        block: true,
        terminate: true,
        reason: preflightRequiredReason(operation, safetyMatches),
      };
    }
    const result = await requireSystemSafetyApproval(ctx, operation, safetyMatches);
    resetSafetyFlow();
    return result;
  };

  pi.on("tool_call", async (event, ctx) => {
    const config = readConfig();
    const mode = sessionMode(ctx, config);
    const level = systemSafetyLevelOf(config);
    const safetyMatches = configuredSafetyMatches(
      config,
      matchSystemSafetyForTool(event.toolName, event.input, ctx.cwd),
    );
    if (safetyMatches.some((match) => match.label === LEAFCODE_PI_STOP_LABEL)) {
      resetSafetyFlow();
      return { block: true, terminate: true, reason: LEAFCODE_PI_STOP_REASON };
    }
    if (level === "strict" && mode !== "deny" && pendingSafetyKey && isReadOnlyInvestigation(
      event.toolName,
      event.input,
      pendingSafetyCategories,
      ctx.cwd,
    )) {
      pendingInvestigationCalls.add(event.toolCallId);
    }

    if (event.toolName === "bash" || event.toolName === "powershell") {
      if (mode === "deny") {
        return { block: true, reason: "Shell execution blocked (permission mode: deny)" };
      }
      const command = (event.input as { command?: string }).command ?? "";
      const protectedPath = commandTouchesProtectedPath(command);
      if (protectedPath.protected) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked shell access to ${protectedPath.reason}`, "warning");
        }
        return {
          block: true,
          reason: `Shell command touches ${protectedPath.reason}`,
        };
      }
      if (safetyMatches.length > 0) return requireSystemApproval(
        ctx,
        mode,
        level,
        operationText(event.toolName, event.input),
        operationIdentity(event.toolName, event.input),
        safetyMatches,
      );
      const { dangerous, labels } = matchedDanger(command);
      if (dangerous) {
        if (mode === "ask") {
          const prompt = `危険なコマンドを検出しました:\n  ${command}\n\n許可しますか?`;
          if (!ctx.hasUI) {
            const approved = await requestWebUiPermission({
              sessionId: extensionSessionId(ctx),
              command,
              labels,
              message: prompt,
            });
            if (approved === null) {
              return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
            }
            if (!approved) {
              return { block: true, reason: "Blocked by user" };
            }
            return undefined;
          }
          const choice = await ctx.ui.select(prompt, ["Yes", "No"]);
          if (choice !== "Yes") {
            return { block: true, reason: "Blocked by user" };
          }
        }
      }
      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path ?? "";
      const check = isProtectedPath(path);
      if (check.protected) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write to ${check.reason}`, "warning");
        }
        return { block: true, reason: `Path "${path}" is protected (${check.reason})` };
      }
      if (safetyMatches.length > 0) return requireSystemApproval(
        ctx,
        mode,
        level,
        operationText(event.toolName, event.input),
        operationIdentity(event.toolName, event.input),
        safetyMatches,
      );
      return undefined;
    }

    if (
      event.toolName === "read"
      || event.toolName === "grep"
      || event.toolName === "find"
      || event.toolName === "ls"
    ) {
      const secret = toolInputTouchesSecretPath(event.toolName, event.input);
      if (secret.protected) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked read of ${secret.reason}`, "warning");
        }
        return {
          block: true,
          reason: `Path is protected (${secret.reason})`,
        };
      }
    }

    if (safetyMatches.length > 0) return requireSystemApproval(
      ctx,
      mode,
      level,
      operationText(event.toolName, event.input),
      operationIdentity(event.toolName, event.input),
      safetyMatches,
    );
    return undefined;
  });

  pi.on("user_bash", async (event, ctx) => {
    const config = readConfig();
    const mode = sessionMode(ctx, config);
    const level = systemSafetyLevelOf(config);
    if (mode === "deny") {
      return blockedUserBashResult("Shell execution blocked (permission mode: deny)");
    }
    const protectedPath = commandTouchesProtectedPath(event.command);
    if (protectedPath.protected) {
      return blockedUserBashResult(`Shell command touches ${protectedPath.reason}`);
    }
    const safetyMatches = configuredSafetyMatches(
      config,
      matchSystemSafetyCommand(event.command),
    );
    if (safetyMatches.some((match) => match.label === LEAFCODE_PI_STOP_LABEL)) {
      resetSafetyFlow();
      return blockedUserBashResult(LEAFCODE_PI_STOP_REASON);
    }
    if (safetyMatches.length > 0) {
      const decision = await requireSystemApproval(
        ctx,
        mode,
        level,
        event.command,
        `user_bash:${event.command}`,
        safetyMatches,
      );
      return decision ? blockedUserBashResult(decision.reason) : undefined;
    }
    const { dangerous, labels } = matchedDanger(event.command);
    if (dangerous && mode === "ask") {
      const prompt = `危険なコマンドを検出しました:\n  ${event.command}\n\n許可しますか?`;
      if (!ctx.hasUI) {
        const approved = await requestWebUiPermission({
          sessionId: extensionSessionId(ctx),
          command: event.command,
          labels,
          message: prompt,
        });
        return approved === true ? undefined : blockedUserBashResult(
          approved === null
            ? "Dangerous command blocked (no UI for confirmation)"
            : "Blocked by user",
        );
      }
      const choice = await ctx.ui.select(prompt, ["Yes", "No"]);
      if (choice !== "Yes") return blockedUserBashResult("Blocked by user");
    }
    return undefined;
  });

  pi.registerCommand("leafcode-permission", {
    description: "Set LeafCode permission mode: allow, ask, deny",
    handler: async (args, ctx) => {
      const mode = args.trim() as PermissionMode;
      if (mode !== "allow" && mode !== "ask" && mode !== "deny") {
        ctx.ui.notify("Usage: /leafcode-permission allow|ask|deny", "warning");
        return;
      }
      setSessionMode(ctx, mode);
      ctx.ui.notify(`Permission mode set to: ${mode}`, "info");
    },
  });
}
