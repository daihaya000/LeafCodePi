import { createSettingSync } from "@/lib/setting-sync";
import {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
  GENERATION_MODEL_EFFORT_SETTING_KEY,
  GENERATION_MODEL_SETTING_KEY,
} from "@/lib/generation-model-key";

export {
  GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY,
  GENERATION_FALLBACK_MODEL_SETTING_KEY,
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

const fallbackSync = createSettingSync({
  storageKey: "webui:generation-fallback-model",
  serverPath: `/api/settings/${GENERATION_FALLBACK_MODEL_SETTING_KEY}`,
  eventName: "webui:generation-fallback-model",
});

const fallbackEffortSync = createSettingSync({
  storageKey: "webui:generation-fallback-model-effort",
  serverPath: `/api/settings/${GENERATION_FALLBACK_MODEL_EFFORT_SETTING_KEY}`,
  eventName: "webui:generation-fallback-model-effort",
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

export function readGenerationFallbackModelEffort(): string | null {
  return fallbackEffortSync.read();
}

export function writeGenerationFallbackModelEffort(value: string | null): void {
  fallbackEffortSync.write(value);
}

export async function readGenerationFallbackModelEffortFromServer(): Promise<string | null> {
  return fallbackEffortSync.readFromServer();
}

export async function writeGenerationFallbackModelEffortToServer(
  value: string | null,
): Promise<void> {
  await fallbackEffortSync.writeToServer(value);
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

export function readGenerationFallbackModel(): string | null {
  return fallbackSync.read();
}

export function writeGenerationFallbackModel(value: string | null): void {
  fallbackSync.write(value);
}

export async function readGenerationFallbackModelFromServer(): Promise<string | null> {
  return fallbackSync.readFromServer();
}

export async function writeGenerationFallbackModelToServer(
  value: string | null,
): Promise<void> {
  await fallbackSync.writeToServer(value);
}
