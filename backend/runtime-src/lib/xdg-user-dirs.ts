import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { readXdgUserDirs as read } from "@backend-core/xdg-user-dirs.mjs";
export { parseXdgUserDirsFile, type XdgUserDirs } from "@backend-core/xdg-user-dirs.mjs";
export function readXdgUserDirs(options: Parameters<typeof read>[0] = {}) { assertConfigurationOwner(); return read(options); }
