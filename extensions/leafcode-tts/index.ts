/**
 * LeafCode TTS for Pi
 *
 * Bot / エージェントのメッセージを読み上げる。
 * `text_delta` を「、。！？」で短く区切り、合成と再生を並行させる Producer/Consumer 方式。
 *
 * 既定バックエンドは Windows 標準の SAPI（System.Speech）。追加依存はない。
 * 設定に `url` を書くと Qwen3-TTS などの HTTP サーバーで合成し、返った wav を再生する。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const CONFIG_FILE = "tts.json";
/** 短すぎる読点区切りを避ける下限、句点が来ないまま伸び続けたときの上限。 */
const MIN_CHUNK = 12;
const MAX_CHUNK = 90;
/** 「。」「！」「？」と改行は常に区切る。ASCII の "." は index.ts や 3.14 を割るので除外。 */
const HARD_BOUNDARY = "。．！？!?\n";
const SOFT_BOUNDARY = "、，,；;：:";

export interface TtsConfig {
  enabled: boolean;
  /** SAPI の音声名（例: "Microsoft Haruka Desktop"）。未指定なら既定音声。 */
  voice?: string;
  /** SAPI の速度 -10..10。 */
  rate: number;
  /** Qwen3-TTS などの HTTP 合成エンドポイント。未指定なら SAPI。 */
  url?: string;
}

const DEFAULT_CONFIG: TtsConfig = { enabled: false, rate: 0 };

// ---------------------------------------------------------------------------
// テキスト整形とストリーミング分割
// ---------------------------------------------------------------------------

/** 読み上げに向かない Markdown 記法を落とす。空文字なら読み飛ばす。 */
export function speakable(text: string): string {
  const cleaned = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\s]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 罫線や区切り線だけの行は読ませない。
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "";
}

/** 句読点で区切れるところまで切り出し、残りを返す。 */
export function cut(text: string): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const length = i - start + 1;
    const ch = text[i]!;
    if (HARD_BOUNDARY.includes(ch) || (SOFT_BOUNDARY.includes(ch) && length >= MIN_CHUNK) || length >= MAX_CHUNK) {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  return { chunks, rest: text.slice(start) };
}

/**
 * streaming の delta を読み上げ単位へ分割する。フェンス付きコードブロックは読まない。
 */
export class SpeechChunker {
  private buffer = "";
  private inCode = false;

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const fence = this.buffer.indexOf("```");
      if (this.inCode) {
        if (fence < 0) {
          // 末尾の "``" が次の delta でフェンスになる可能性があるので残す。
          this.buffer = this.buffer.slice(-2);
          return out;
        }
        this.buffer = this.buffer.slice(fence + 3);
        this.inCode = false;
        continue;
      }
      const segment = fence < 0 ? this.buffer : this.buffer.slice(0, fence);
      const { chunks, rest } = cut(segment);
      for (const chunk of chunks) out.push(chunk);
      if (fence < 0) {
        this.buffer = rest;
        return out;
      }
      out.push(rest);
      this.buffer = this.buffer.slice(fence + 3);
      this.inCode = true;
    }
  }

  flush(): string[] {
    const rest = this.inCode ? "" : this.buffer;
    this.reset();
    return rest ? [rest] : [];
  }

  reset(): void {
    this.buffer = "";
    this.inCode = false;
  }
}

// ---------------------------------------------------------------------------
// 再生（Consumer）
// ---------------------------------------------------------------------------

/**
 * stdin から 1 行ずつ受け取り、同期再生して "ok" を返す常駐 PowerShell。
 * 行は `<種別>:<UTF-8 の base64>` で、日本語を stdin のコードページから切り離す。
 * "ok" は再生要求（S / P）にだけ返し、設定要求（V / R）とは 1 対 1 を崩さない。
 */
const PS_WORKER = [
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "$synth.SetOutputToDefaultAudioDevice()",
  "$player = New-Object System.Media.SoundPlayer",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line.Length -lt 2) { continue }",
  "  $kind = $line.Substring(0, 1)",
  "  $body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2)))",
  "  try {",
  "    switch ($kind) {",
  "      'V' { $synth.SelectVoice($body) }",
  "      'R' { $synth.Rate = [int]$body }",
  "      'S' { $synth.Speak($body) }",
  "      'P' { $player.SoundLocation = $body; $player.PlaySync(); Remove-Item -LiteralPath $body -Force -ErrorAction SilentlyContinue }",
  "    }",
  "  } catch { [Console]::Error.WriteLine($_.Exception.Message) }",
  "  if ('S','P' -contains $kind) { [Console]::Out.WriteLine('ok') }",
  "}",
].join("\n");

type Job = { kind: "S" | "P"; body: Promise<string | null> };

export class Speaker {
  private worker: ChildProcess | null = null;
  private queue: Job[] = [];
  private busy = false;
  private seq = 0;
  private config: TtsConfig;

  // parameter property は Node の strip-only TypeScript で動かないため使わない。
  constructor(config: TtsConfig) {
    this.config = config;
  }

  setConfig(config: TtsConfig): void {
    this.config = config;
    this.dispose();
  }

  say(text: string): void {
    const clean = speakable(text);
    if (!clean) return;
    // ponytail: 合成要求は投入時に並列で走らせる。chunk は LLM の生成速度でしか増えないので上限は置かない。
    const job: Job = this.config.url
      ? { kind: "P", body: this.synthesize(clean, this.config.url) }
      : { kind: "S", body: Promise.resolve(clean) };
    this.queue.push(job);
    void this.pump();
  }

  /** 未再生分を捨て、発話中なら worker ごと殺して即断する。Speak() は同期なのでキャンセルコマンドを差し込めない。 */
  stop(): void {
    for (const job of this.queue) {
      // 先行合成した wav は再生されないので、到着次第消す。
      if (job.kind === "P") void job.body.then((file) => file && rmSync(file, { force: true })).catch(() => {});
    }
    this.queue = [];
    if (!this.busy || !this.worker) return;
    const worker = this.worker;
    this.worker = null;
    this.busy = false;
    worker.kill(); // SAPI / wav 再生のどちらも OS 側で止まる。次の say で worker を起こし直す。
  }

  dispose(): void {
    this.stop();
    this.busy = false;
    this.worker?.stdin?.end();
    this.worker = null;
  }

  private async synthesize(text: string, url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voice: this.config.voice }),
      });
      if (!response.ok) return null;
      const file = join(tmpdir(), `leafcode-tts-${process.pid}-${this.seq++}.wav`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      return file;
    } catch {
      return null; // HTTP バックエンドが落ちていても読み上げごと止めない。
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    const body = await job.body;
    if (body === null) {
      this.busy = false;
      void this.pump();
      return;
    }
    const worker = this.ensureWorker();
    if (!worker?.stdin) {
      this.busy = false;
      this.queue = [];
      return;
    }
    this.send(worker, job.kind, body);
  }

  private ensureWorker(): ChildProcess | null {
    if (this.worker) return this.worker;
    if (process.platform !== "win32") return null;
    const worker = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS_WORKER, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    worker.on("error", () => this.dispose());
    worker.on("exit", () => {
      if (this.worker === worker) this.dispose();
    });
    worker.stdout?.setEncoding("utf8");
    worker.stdout?.on("data", (data: string) => {
      if (!data.includes("\n")) return; // 再生完了は "ok\n" の改行だけで判定する。
      this.busy = false;
      void this.pump();
    });
    this.worker = worker;
    if (this.config.voice) this.send(worker, "V", this.config.voice);
    if (this.config.rate) this.send(worker, "R", String(this.config.rate));
    return worker;
  }

  private send(worker: ChildProcess, kind: string, body: string): void {
    worker.stdin?.write(`${kind}:${Buffer.from(body, "utf8").toString("base64")}\n`);
  }
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function leafcodeDataDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

export function readTtsConfig(file = join(leafcodeDataDir(), CONFIG_FILE)): TtsConfig {
  try {
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TtsConfig>;
    return {
      enabled: raw.enabled === true,
      voice: typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : undefined,
      rate: typeof raw.rate === "number" && Number.isFinite(raw.rate) ? Math.max(-10, Math.min(10, raw.rate)) : 0,
      url: typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : undefined,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** `/tts` の ON/OFF などを tts.json に書く。ディレクトリが無ければ作る。 */
export function writeTtsConfig(config: TtsConfig, file = join(leafcodeDataDir(), CONFIG_FILE)): void {
  mkdirSync(dirname(file), { recursive: true });
  const body: Record<string, unknown> = {
    enabled: config.enabled === true,
    rate: typeof config.rate === "number" && Number.isFinite(config.rate) ? Math.max(-10, Math.min(10, config.rate)) : 0,
  };
  if (config.voice?.trim()) body.voice = config.voice.trim();
  if (config.url?.trim()) body.url = config.url.trim();
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 拡張本体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  if (process.env[SUBAGENT_CHILD_ENV] === "1") return; // 並列サブエージェントが同時に喋らない。

  let config = readTtsConfig();
  let enabled = config.enabled;
  const chunker = new SpeechChunker();
  const speaker = new Speaker(config);

  const stop = (): void => {
    chunker.reset();
    speaker.stop();
  };

  pi.on("session_start", () => {
    config = readTtsConfig();
    enabled = config.enabled;
    speaker.setConfig(config);
  });

  pi.on("agent_start", () => stop());
  pi.on("input", () => stop());

  pi.on("message_update", (event) => {
    if (!enabled) return;
    const update = event.assistantMessageEvent;
    if (update.type !== "text_delta") return;
    for (const chunk of chunker.push(update.delta)) speaker.say(chunk);
  });

  pi.on("message_end", (event) => {
    if (!enabled || event.message.role !== "assistant") return;
    for (const chunk of chunker.flush()) speaker.say(chunk);
  });

  pi.on("session_shutdown", () => speaker.dispose());

  pi.registerCommand("tts", {
    description: "アシスタントの発言の読み上げ（on / off / test）",
    async handler(args: string, ctx: ExtensionContext) {
      const arg = args.trim().toLowerCase();
      if (arg === "test") {
        speaker.say("読み上げのテストです。");
        ctx.ui.notify("TTS: テスト再生", "info");
        return;
      }
      enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
      config = { ...config, enabled };
      try {
        writeTtsConfig(config);
      } catch (error) {
        ctx.ui.notify(`TTS: 設定の保存に失敗 (${error instanceof Error ? error.message : String(error)})`, "error");
        return;
      }
      if (!enabled) stop();
      const backend = config.url ? `HTTP ${config.url}` : "Windows SAPI";
      ctx.ui.notify(`TTS: ${enabled ? `ON (${backend})` : "OFF"}`, "info");
    },
  });
}
