import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { listTasks } from "@/lib/store";
export async function GET() {
  assertConfigurationOwner();
  return Response.json({ source: "backend", tasks: [...listTasks(true), ...listTasks(true, "bot")] });
}
