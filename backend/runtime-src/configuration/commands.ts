import { join } from "node:path";
import { createConfigurationCommands } from "@backend-core/configuration-command.mjs";
import { dataDir } from "@/lib/paths";
/** Configuration and definitions share one owner queue/ledger, including their live application. */
export const configurationCommands = createConfigurationCommands({ ledgerPath: () => join(dataDir(), "configuration-command.json") });
