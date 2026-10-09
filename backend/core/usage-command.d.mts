export function createUsageCommands(options: { ledgerPath: () => string }): {
  run(input: { operationId?: string; handler: () => Promise<Response> }): Promise<Response>;
};
