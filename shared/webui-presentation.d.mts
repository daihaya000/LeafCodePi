export interface WebUiPresentation { hostname: string; authFileDisplayPath: string }
export function readWebUiPresentation(dataDir?: string): WebUiPresentation;
export function webUiPresentationResponse(method: string): Response;
