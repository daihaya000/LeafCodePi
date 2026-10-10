import { webUiPresentationResponse } from "@shared/webui-presentation.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return webUiPresentationResponse("GET"); }
export function HEAD() { return webUiPresentationResponse("HEAD"); }
export function OPTIONS() { return webUiPresentationResponse("OPTIONS"); }
