export function createProviderAuthCommands(options: { ledgerPath: () => string }): { run(input: { operationId?: string; handler: () => Promise<Response> }): Promise<Response> };
