import { EventEmitter } from "node:events";
import { PROVIDER_AUTH_EVENT_LIMIT, PROVIDER_AUTH_STREAM_LIMIT, publicProviderLoginEvent } from "@shared/provider-auth-contract.mjs";
import { measureBoundedEvent, validateBoundedEvent } from "../../event-stream/bounded-writer";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LoginOptions } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError } from "@earendil-works/pi-coding-agent";
import { forwardOAuthCallback, getOAuthCallbackTarget, type OAuthCallbackTarget } from "./oauth-callback";

import type { AuthTypeDto } from "@shared/ui-owner-dtos";
export type { AuthTypeDto } from "@shared/ui-owner-dtos";

import type { LoginPromptDto } from "@shared/ui-owner-dtos";
export type { LoginPromptDto } from "@shared/ui-owner-dtos";

import type { LoginNotifyDto } from "@shared/ui-owner-dtos";
export type { LoginNotifyDto } from "@shared/ui-owner-dtos";

import type { LoginSessionEvent } from "@shared/ui-owner-dtos";
export type { LoginSessionEvent } from "@shared/ui-owner-dtos";

type PendingPrompt = {
  id: string;
  prompt: LoginPromptDto;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export class ProviderLoginSession {
  readonly id = randomUUID();
  readonly events = new EventEmitter();
  private readonly abort = new AbortController();
  private pending: PendingPrompt | null = null;
  private finished = false;
  private callbackTarget: OAuthCallbackTarget | null = null;
  private callbackExpiresAt = 0;
  private callbackBusy = false;
  private callbackSubmitted = false;
  private readonly history = new Map<string, { event: LoginSessionEvent; bytes: number }>();

  readDiagnostics() {
    return { historyEntries: this.history.size, historyBytes: [...this.history.values()].reduce((sum, row) => sum + row.bytes, 0), listeners: this.events.listenerCount("event"), pending: this.pending !== null, finished: this.finished };
  }

  constructor(
    readonly providerId: string,
    readonly authType: AuthTypeDto,
    /** 対象アカウント（null = 既定の ~/.pi/agent/auth.json）。 */
    readonly accountId: string | null = null,
  ) {
    this.events.setMaxListeners(PROVIDER_AUTH_STREAM_LIMIT);
  }

  private emit(event: LoginSessionEvent) {
    // Retain public recovery state, not an ever-growing SDK event log. Progress/info
    // coalescing never evicts the pending prompt or current OAuth/device URL.
    let safe = publicProviderLoginEvent(event) as LoginSessionEvent | null;
    let bytes: number;
    try { if (!safe) throw new Error("Invalid event"); bytes = measureBoundedEvent(safe, PROVIDER_AUTH_EVENT_LIMIT - 32); }
    catch { safe = { type: "notify", event: { type: "info", message: "認証イベントが配信上限を超えました" } }; bytes = Buffer.byteLength(JSON.stringify(safe)); }
    const key = safe.type === "notify" ? `notify:${safe.event.type}` : safe.type;
    this.history.delete(key);
    this.history.set(key, { event: safe, bytes });
    this.events.emit("event", safe);
  }

  subscribe(listener: (event: LoginSessionEvent) => void): () => void {
    if (this.events.listenerCount("event") >= PROVIDER_AUTH_STREAM_LIMIT) throw Object.assign(new Error("Login subscription capacity"), { status: 503 });
    for (const { event } of this.history.values()) {
      // Mobile browsers reconnect after the external login page. Do not revive
      // answered/aborted prompts or a callback that has already been submitted.
      if (event.type === "prompt" && event.id !== this.pending?.id) continue;
      if (event.type === "notify" && event.event.type === "auth_url") {
        listener({ ...event, event: {
          ...event.event,
          callbackUrl: !this.finished && !this.abort.signal.aborted &&
            !this.callbackSubmitted && Date.now() < this.callbackExpiresAt &&
            event.event.callbackUrl === this.callbackTarget?.url
            ? event.event.callbackUrl : undefined,
        } });
      } else {
        listener(event);
      }
    }
    if (!this.finished) this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async run(runtime: ModelRuntime, options?: LoginOptions): Promise<void> {
    assertConfigurationOwner();
    this.emit({
      type: "started",
      providerId: this.providerId,
      authType: this.authType,
      accountId: this.accountId,
    });
    try {
      await runtime.login(this.providerId, this.authType, {
        signal: this.abort.signal,
        prompt: (prompt) => this.handlePrompt(prompt),
        notify: (event) => {
          if (event.type === "auth_url") {
            this.callbackTarget = this.authType === "oauth" && typeof event.url === "string" && event.url.length <= 32768 ? getOAuthCallbackTarget(event.url) : null;
            this.callbackExpiresAt = Date.now() + 10 * 60_000;
            this.callbackSubmitted = false;
            this.emit({ type: "notify", event: {
              ...event,
              callbackUrl: this.callbackTarget?.url,
            } });
          } else {
            this.emit({ type: "notify", event: event as LoginNotifyDto });
          }
        },
      }, options);
      this.finishOk();
    } catch (error) {
      if (error instanceof CredentialSynchronizationError) {
        this.finishOk(
          `認証は保存されましたが、モデル一覧の同期に失敗しました: ${error.message}`,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.clearPending(error instanceof Error ? error : new Error(message));
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
    if (prompt.signal?.aborted) {
      return Promise.reject(new Error("Login cancelled"));
    }
    // Validate before retaining a pending prompt or mapping an unbounded SDK options array.
    const id = randomUUID();
    const candidate = publicProviderLoginEvent({ type: "prompt", id, prompt });
    if (!candidate) return Promise.reject(new Error("Invalid login prompt"));
    try { validateBoundedEvent(candidate, PROVIDER_AUTH_EVENT_LIMIT - 32); }
    catch { return Promise.reject(new Error("Login prompt exceeds limit")); }
    const dto = (candidate as Extract<LoginSessionEvent, { type: "prompt" }>).prompt;
    return new Promise<string>((resolve, reject) => {
      if (this.pending) {
        this.pending.cleanup();
        this.pending.reject(new Error("Replaced by a newer prompt"));
      }
      const onAbort = () => {
        if (this.pending?.id === id) {
          this.pending = null;
          this.history.delete("prompt");
          cleanup();
          reject(new Error("Login cancelled"));
        }
      };
      const onPromptAbort = () => {
        if (this.pending?.id === id) {
          this.pending = null;
          this.history.delete("prompt");
          cleanup();
          reject(new Error("Login cancelled"));
        }
      };
      const cleanup = () => {
        this.abort.signal.removeEventListener("abort", onAbort);
        prompt.signal?.removeEventListener("abort", onPromptAbort);
      };
      this.pending = { id, prompt: dto, resolve, reject, cleanup };
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      prompt.signal?.addEventListener("abort", onPromptAbort, { once: true });
      this.emit({ type: "prompt", id, prompt: dto });
    });
  }

  answer(promptId: string, value: string) {
    if (!this.pending || this.pending.id !== promptId) {
      throw Object.assign(new Error("該当する入力待ちがありません"), {
        status: 409,
      });
    }
    const pending = this.pending;
    this.pending = null;
    this.history.delete("prompt");
    pending.cleanup();
    if (pending.prompt.type === "manual_code") this.callbackSubmitted = true;
    pending.resolve(value);
  }

  async completeCallback(input: string): Promise<void> {
    if (
      this.finished || this.abort.signal.aborted || !this.callbackTarget ||
      this.callbackBusy || this.callbackSubmitted || Date.now() >= this.callbackExpiresAt
    ) {
      throw Object.assign(new Error("有効なOAuthの戻り先待機がありません"), { status: 409 });
    }
    this.callbackBusy = true;
    try {
      await forwardOAuthCallback(this.callbackTarget, input, this.abort.signal);
      this.callbackSubmitted = true;
    } finally {
      this.callbackBusy = false;
    }
  }

  cancel() {
    this.clearPending(new Error("Login cancelled"));
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private clearPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.history.delete("prompt");
    pending.cleanup();
    pending.reject(error);
  }

  private finishOk(warning?: string) {
    if (this.finished) return;
    this.finished = true;
    this.clearPending(new Error("Login completed"));
    this.callbackTarget = null;
    this.emit({ type: "done", ok: true, warning });
  }

  private finishError(error: string) {
    if (this.finished) return;
    this.finished = true;
    this.callbackTarget = null;
    this.emit({ type: "done", ok: false, error });
  }
}

/** Providers that expose Claude / ChatGPT / Cursor / Meta Muse subscription OAuth. */
export const SUBSCRIPTION_PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "cursor",
  "meta",
]);

/** Cloud API providers surfaced near subscription logins in settings. */
export const HIGHLIGHTED_API_PROVIDER_IDS = new Set([
  "ollama-cloud",
  "openrouter",
  "commandcode",
  "opencode",
  "opencode-go",
  "typesafe",
  "orcarouter",
  "experientiallabs",
]);

export function isHighlightedProvider(providerId: string): boolean {
  return (
    SUBSCRIPTION_PROVIDER_IDS.has(providerId) ||
    HIGHLIGHTED_API_PROVIDER_IDS.has(providerId)
  );
}

export function providerAuthMethods(provider: {
  auth: { apiKey?: unknown; oauth?: unknown };
}): AuthTypeDto[] {
  const methods: AuthTypeDto[] = [];
  if (provider.auth.apiKey) methods.push("api_key");
  if (provider.auth.oauth) methods.push("oauth");
  return methods;
}
