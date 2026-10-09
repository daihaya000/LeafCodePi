import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { publicBackendInformationBody } from "@shared/backend-information-contract.mjs";
import { collectSystemUsageCached } from "../../../../lib/sysmon-usage";
import { emptyUsage } from "../../../../lib/sysmon";
export async function GET() {
  assertConfigurationOwner();
  let value;
  try { value = await collectSystemUsageCached(); } catch { value = emptyUsage("取得に失敗しました"); }
  const projected = publicBackendInformationBody("sysmon/usage", value, 200, "GET");
  return projected ? Response.json(projected) : Response.json({ error: "監視結果を確認できません" }, { status: 503 });
}
