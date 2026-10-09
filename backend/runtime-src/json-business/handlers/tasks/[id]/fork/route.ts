import type { ConfigurationRequest } from "../../../../../configuration/http";
import { handleTaskSessionOperation } from "../../../../task-session";
export function POST(request: ConfigurationRequest, context: { params: Promise<{ id: string }> }) {
  return handleTaskSessionOperation(request, context, "fork");
}
