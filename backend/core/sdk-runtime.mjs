/** No Next.js, application store, credentials or network work on import. */
export class SdkRuntimeFactory {
  constructor({ loadSdk = () => import("@earendil-works/pi-coding-agent") } = {}) {
    this.loadSdk = loadSdk;
    this.sdkPromise = null;
  }

  load() {
    if (!this.sdkPromise) {
      // Defer synchronous throws and coalesce concurrent imports as well.
      const pending = Promise.resolve().then(() => this.loadSdk());
      this.sdkPromise = pending;
      void pending.catch(() => {
        if (this.sdkPromise === pending) this.sdkPromise = null;
      });
    }
    return this.sdkPromise;
  }

  /** Options and provider registration are owned by the caller, never inferred here. */
  async createModelRuntime(options, registerProviders = async () => {}) {
    const sdk = await this.load();
    const runtime = await sdk.ModelRuntime.create(options);
    await registerProviders(runtime);
    return runtime;
  }

  /** The caller owns session subscriptions, abort/dispose and extension shutdown. */
  async createAgentSession(options) {
    const sdk = await this.load();
    return sdk.createAgentSession(options);
  }
}
