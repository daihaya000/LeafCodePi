import { applyBotConfigPatch, createBotConfig } from "./bot-crud.mjs";

/**
 * Ordered side effects for creating, updating and deleting a Bot. Every effect is
 * injected — files through the bot store, task records through the app store — so
 * this module owns only the sequence and the return-value contract:
 *
 *  create: workspace → SOUL → MEMORY → config → 1:1 task
 *  patch:  config → SOUL (only when the patch carries one) → 1:1 task fields
 *  delete: task cleanup → directory removal
 */
export function createBotWithEffects(input, deps) {
  const id = deps.uuid();
  const config = createBotConfig({
    id,
    name: input.name,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    permissionMode: input.permissionMode,
    now: deps.now(),
    defaultToolNames: deps.defaultToolNames,
  });
  const workspace = deps.store.workspacePath(id);
  // The workspace exists before any file is written, so an interrupted create
  // never leaves a half-built bot directory.
  deps.ensureWorkspace(workspace);
  deps.store.writeSoul(id, deps.soulTemplate);
  deps.store.ensureMemoryFile(id);
  deps.store.writeConfig(config);
  deps.tasks.insertBotTask({
    id: `bot:${id}`, botId: id, name: config.name, directory: workspace,
    model: config.model, thinkingLevel: config.thinkingLevel, permissionMode: config.permissionMode,
  });
  return deps.toDto(config);
}

/** Returns undefined when the bot does not exist (the config could not be read). */
export function patchBotWithEffects(id, patch, deps) {
  const current = deps.store.readConfig(id);
  if (!current) return undefined;
  const next = applyBotConfigPatch(current, patch, { now: deps.now() });
  deps.store.writeConfig(next);
  if (patch.soul !== undefined) deps.store.writeSoul(id, patch.soul);
  // Model routing is applied by the bot PATCH route through setTaskModel; the
  // logical model key is never written into the task's modelID here.
  deps.tasks.patchTask(`bot:${id}`, {
    title: next.name,
    thinkingLevel: next.thinkingLevel ?? undefined,
    permissionMode: next.permissionMode ?? undefined,
  });
  return deps.toDto(next);
}

/** Returns false when the bot does not exist. */
export function deleteBotWithEffects(id, deps) {
  if (!deps.store.readConfig(id)) return false;
  // Removes the 1:1 task, Room sessions, and any Bot-owned Code tasks left after API teardown.
  for (const task of deps.tasks.listTasks(true, "all")) {
    if (task.botId === id) deps.tasks.deleteTask(task.id);
    else if (task.supervisorBotId === id) deps.tasks.patchTask(task.id, { supervisorBotId: null });
  }
  deps.store.removeBot(id);
  return true;
}
