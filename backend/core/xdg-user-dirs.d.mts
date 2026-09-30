export type XdgUserDirs = {
  desktop?: string;
  documents?: string;
  downloads?: string;
  pictures?: string;
};

export function parseXdgUserDirsFile(contents: string, home: string): XdgUserDirs;

export function readXdgUserDirs(options?: {
  home?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}): XdgUserDirs;
