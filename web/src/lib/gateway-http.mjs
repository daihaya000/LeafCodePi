// Transport-only Undici entries. The broad root also loads SQLite/cache/mock code.
import Agent from "undici/lib/dispatcher/agent.js";
import Client from "undici/lib/dispatcher/client.js";
import { fetch } from "undici/lib/web/fetch/index.js";
export { Agent, Client, fetch };
