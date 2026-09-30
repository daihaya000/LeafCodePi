import { createPermissionBridge, type WebUiPermissionRequest } from "@backend-core/webui-bridge.mjs";

export type { WebUiPermissionRequest };

// Compatibility entrypoint. The process-global handler slot remains the shared
// contract with extensions/leafcode-permission-gate/webui-bridge.ts.
const bridge = createPermissionBridge();

export const registerWebUiPermissionHandler = bridge.registerWebUiPermissionHandler;
export const requestWebUiPermission = bridge.requestWebUiPermission;
