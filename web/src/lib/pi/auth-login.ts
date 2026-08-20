import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";

export type AuthTypeDto = "api_key" | "oauth";

export type LoginPromptDto =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string };

export type LoginNotifyDto =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type LoginSessionEvent =
  | { type: "started"; providerId: string; authType: AuthTypeDto }
  | { type: "notify"; event: LoginNotifyDto }
  | { type: "prompt"; id: string; prompt: LoginPromptDto }
  | { type: "done"; ok: true; warning?: string }
  | { type: "done"; ok: false; error: string };

type PendingPrompt = {
  id: string;
  prompt: LoginPromptDto;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

export class ProviderLoginSession {
  readonly id = randomUUID();
  readonly events = new EventEmitter();
  private readonly abort = new AbortController();
  private pending: PendingPrompt | null = null;
  private finished = false;
  private readonly history: LoginSessionEvent[] = [];

  constructor(
    readonly providerId: string,
    readonly authType: AuthTypeDto,
  ) {
    this.events.setMaxListeners(20);
  }

  private emit(event: LoginSessionEvent) {
    this.history.push(event);
    this.events.emit("event", event);
  }

  subscribe(listener: (event: LoginSessionEvent) => void): () => void {
    for (const event of this.history) listener(event);
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async run(runtime: ModelRuntime): Promise<void> {
    this.emit({ type: "started", providerId: this.providerId, authType: this.authType });
    try {
      await runtime.login(this.providerId, this.authType, {
        signal: this.abort.signal,
        prompt: (prompt) => this.handlePrompt(prompt),
        notify: (event) => {
          this.emit({ type: "notify", event: event as LoginNotifyDto });
        },
      });
      this.finishOk();
    } catch (error) {
      if (error instanceof CredentialSynchronizationError) {
        this.finishOk(
          `認証は保存されましたが、モデル一覧の同期に失敗しました: ${error.message}`,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.abort.signal.aborted || /cancel/i.test(message)) {
        this.finishError("ログインをキャンセルしました");
        return;
      }
      this.finishError(message);
    }
  }

  private handlePrompt(prompt: {
    type: string;
    message: string;
    placeholder?: string;
    options?: readonly { id: string; label: string; description?: string }[];
    signal?: AbortSignal;
  }): Promise<string> {
    if (this.abort.signal.aborted) {
      return Promise.reject(new Error("Login cancelled"));
    }
    const dto = serializePrompt(prompt);
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      if (this.pending) {
        this.pending.reject(new Error("Replaced by a newer prompt"));
      }
      this.pending = { id, prompt: dto, resolve, reject };
      this.emit({ type: "prompt", id, prompt: dto });
      const onAbort = () => {
        if (this.pending?.id === id) {
          this.pending = null;
          reject(new Error("Login cancelled"));
        }
      };
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      prompt.signal?.addEventListener(
        "abort",
        () => {
          if (this.pending?.id === id) {
            this.pending = null;
            reject(new Error("Login cancelled"));
          }
        },
        { once: true },
      );
    });
  }

  answer(promptId: string, value: string) {
    if (!this.pending || this.pending.id !== promptId) {
      throw Object.assign(new Error("該当する入力待ちがありません"), { status: 409 });
    }
    const pending = this.pending;
    this.pending = null;
    pending.resolve(value);
  }

  cancel() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error("Login cancelled"));
    }
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private finishOk(warning?: string) {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: "done", ok: true, warning });
  }

  private finishError(error: string) {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: "done", ok: false, error });
  }
}

function serializePrompt(prompt: {
  type: string;
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}): LoginPromptDto {
  if (prompt.type === "select") {
    return {
      type: "select",
      message: prompt.message,
      options: (prompt.options ?? []).map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
    };
  }
  if (prompt.type === "secret") {
    return { type: "secret", message: prompt.message, placeholder: prompt.placeholder };
  }
  if (prompt.type === "manual_code") {
    return { type: "manual_code", message: prompt.message, placeholder: prompt.placeholder };
  }
  return { type: "text", message: prompt.message, placeholder: prompt.placeholder };
}

/** Providers that expose Claude / ChatGPT / Cursor subscription OAuth. */
export const SUBSCRIPTION_PROVIDER_IDS = new Set(["anthropic", "openai-codex", "cursor"]);

export function providerAuthMethods(provider: {
  auth: { apiKey?: unknown; oauth?: unknown };
}): AuthTypeDto[] {
  const methods: AuthTypeDto[] = [];
  if (provider.auth.apiKey) methods.push("api_key");
  if (provider.auth.oauth) methods.push("oauth");
  return methods;
}
