export function dataDir(): string;
export function storePath(): string;
export function webUiAuthConfigPath(): string;
export function displayLeafcodePiDataPath(
  relative?: string,
  platform?: string,
  dataDirOverride?: string,
): string;
export function pathKey(value: string, platform?: string): string;
export function samePath(left: string, right: string, platform?: string): boolean;
export function sameOrDescendantPath(value: string, parent: string, platform?: string): boolean;
export function resolveNoProjectRoot(options?: {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  exists?: (path: string) => boolean;
}): string;
export function noProjectRoot(): string;
export function noProjectSessionDir(date?: Date): string;
export function isAbsolutePath(value: string): boolean;
