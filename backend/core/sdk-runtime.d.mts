type PiModule = typeof import("@earendil-works/pi-coding-agent");
type ModelRuntime = Awaited<ReturnType<PiModule["ModelRuntime"]["create"]>>;

export class SdkRuntimeFactory {
  constructor(options?: { loadSdk?: () => Promise<PiModule> });
  load(): Promise<PiModule>;
  createModelRuntime(
    options: Parameters<PiModule["ModelRuntime"]["create"]>[0],
    registerProviders?: (runtime: ModelRuntime) => Promise<void>,
  ): Promise<ModelRuntime>;
  createAgentSession(
    options: Parameters<PiModule["createAgentSession"]>[0],
  ): ReturnType<PiModule["createAgentSession"]>;
}
