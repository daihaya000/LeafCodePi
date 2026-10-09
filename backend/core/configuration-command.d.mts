import type { ConfigurationMutation } from "../../shared/configuration-contract.mjs";
export function assertConfigurationOwner(): void;
export function watchConfigurationPath(path: string): void;
export function markConfigurationExternalWrite(stage: "started" | "saved"): void;
export function markConfigurationRecovery(recovery: "restored" | "required"): void;
export function createConfigurationCommands(options: { ledgerPath: () => string; apply?: (input: {route: string; method: string; body: Record<string, unknown>}) => Promise<unknown> }): {
  read(operationId?: string): ConfigurationMutation | {revision: string | null} | null;
  run(options: {operationId?: string; route: string; method: string; handler: () => Response | Promise<Response>; apply?: (input: {route: string; method: string; body: Record<string, unknown>}) => Promise<unknown>}): Promise<Response>;
};
