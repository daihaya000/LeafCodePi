import { createSettingSync } from "@/lib/setting-sync";
import {
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";

export {
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";

const sync = createSettingSync({
  storageKey: "webui:generation-model",
  serverPath: `/api/settings/${GENERATION_MODEL_SETTING_KEY}`,
  eventName: "webui:generation-model",
});

const effortSync = createSettingSync({
  storageKey: "webui:generation-model-effort",
  serverPath: `/api/settings/${GENERATION_MODEL_EFFORT_SETTING_KEY}`,
  eventName: "webui:generation-model-effort",
});

export function readGenerationModelEffort(): string | null {
  return effortSync.read();
}

export function writeGenerationModelEffort(value: string | null): void {
  effortSync.write(value);
}

export async function readGenerationModelEffortFromServer(): Promise<string | null> {
  return effortSync.readFromServer();
}

export async function writeGenerationModelEffortToServer(value: string | null): Promise<void> {
  await effortSync.writeToServer(value);
}

export function readGenerationModel(): string | null {
  return sync.read();
}

export function writeGenerationModel(value: string | null): void {
  sync.write(value);
}

export async function readGenerationModelFromServer(): Promise<string | null> {
  return sync.readFromServer();
}

export async function writeGenerationModelToServer(value: string | null): Promise<void> {
  await sync.writeToServer(value);
}
