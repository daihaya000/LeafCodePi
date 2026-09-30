export function basenameKey(entryPath: string): string;
export function isWebUiRequiredExtension(name: string): boolean;

/** The model-facing runtime context block, built from the loaded extensions. */
export function botRuntimeContext(extensions: readonly { path: string }[]): string;
