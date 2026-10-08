export function createTaskCollectionCommands(options: { ledgerPath: () => string }): {
  run(input: { operationId?: string; handler: () => Promise<Response> }): Promise<Response>;
};
