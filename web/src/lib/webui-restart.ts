/**
 * 再起動オーバーレイの判定。単発の health 失敗（サーバ側の一時的な遅延、
 * ブラウザの接続上限待ち、タブのスロットリング、スリープ復帰）を「再起動」と
 * 誤検知して勝手にリロードしないための状態機械。
 */

/** 連続でこの回数失敗するまではダウンとみなさない。 */
export const OFFLINE_STREAK = 3;

/**
 * 明示再起動後、プロセスが一度も落ちず startedAt も変わらないままこの時間を超えたら
 * オーバーレイを畳む（202 受理後に Host 側が黙って中断したケースの取り残し防止）。
 */
export const RESTART_REQUEST_GIVE_UP_MS = 90_000;

/** Fallback for older hosts or machines with no completed restart history. Not a wait limit. */
export const HOST_RESTART_ESTIMATE_MS = 5 * 60_000;

export function hostRestartEstimateMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 5_000 && value <= 15 * 60_000
    ? value
    : HOST_RESTART_ESTIMATE_MS;
}

export function restartEstimateRemainingMs(
  requestedAt: number,
  now = Date.now(),
  estimateMs = HOST_RESTART_ESTIMATE_MS,
): number {
  const elapsedMs = Math.max(0, now - requestedAt);
  return Math.max(0, hostRestartEstimateMs(estimateMs) - elapsedMs);
}

export function formatRestartCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export type RestartProbeState = {
  /** health に一度でも成功したか。初回接続前の失敗は無視する。 */
  connected: boolean;
  /** 連続失敗数。 */
  failures: number;
  /** ダウンを検知済みか。 */
  offline: boolean;
  /** UI から明示的に再起動を要求したか。 */
  requested: boolean;
  /** 明示再起動を要求した時刻（ms）。未要求なら null。 */
  requestedAt: number | null;
  /** 直近に観測したサーバプロセスの起動時刻（未提供なら null）。 */
  startedAt: number | null;
};

export const INITIAL_RESTART_PROBE: RestartProbeState = {
  connected: false,
  failures: 0,
  offline: false,
  requested: false,
  requestedAt: null,
  startedAt: null,
};

export type RestartOverlayTarget = "webui" | "host";

/** Settings / Sidebar がオーバーレイへ渡す CustomEvent 名。 */
export const WEBUI_RESTART_EVENT = "leafcode:webui-restart";
/** Fired when the reconnect overlay gives up because the process never went down. */
export const WEBUI_RESTART_ABORTED_EVENT = "leafcode:webui-restart-aborted";

export function restartOverlayMessage(target: RestartOverlayTarget | null | undefined): string {
  return target === "host"
    ? "トレイホストを再起動しています…"
    : "WebUIを再起動しています…";
}

/**
 * 接続断だけでは再起動と断定できない。明示的な再起動要求だけを覆い、
 * 想定外の再起動は startedAt が変わったと確認できた時点で再読み込みする。
 */
export function isRestartOverlayVisible(state: RestartProbeState): boolean {
  return state.requested;
}

/**
 * 1 回分の health 結果を畳み込む。`sample` が null なら到達不能。
 * `reload` は「サーバが実際に別プロセスへ入れ替わった」ときだけ true。
 */
export function nextRestartProbe(
  prev: RestartProbeState,
  sample: { startedAt: number | null } | null,
  now = Date.now(),
): { state: RestartProbeState; reload: boolean; gaveUp?: boolean } {
  if (!sample) {
    const failures = prev.failures + 1;
    // 明示要求後はダウンを待つ状態なので 1 回の失敗で確定させる。
    const offline =
      prev.offline || prev.requested || (prev.connected && failures >= OFFLINE_STREAK);
    return { state: { ...prev, failures, offline }, reload: false, gaveUp: false };
  }
  // startedAt を返さないサーバ（旧版）は判別できないので従来どおりリロードする。
  const changedProcess =
    prev.startedAt !== null && sample.startedAt !== null && sample.startedAt !== prev.startedAt;
  const restarted = prev.startedAt === null || sample.startedAt === null || changedProcess;
  // 短い再起動はプローブ間に完了し、オフラインを検知できないことがある。
  if (changedProcess || (prev.offline && restarted)) {
    return {
      state: {
        ...prev,
        connected: true,
        failures: 0,
        offline: false,
        requested: false,
        requestedAt: null,
        startedAt: sample.startedAt,
      },
      reload: true,
      gaveUp: false,
    };
  }
  // 202 を受けたあと Host が黙って中断し、同じプロセスが生き続けている場合は畳む。
  const giveUp =
    prev.requested &&
    !prev.offline &&
    prev.requestedAt != null &&
    now - prev.requestedAt >= RESTART_REQUEST_GIVE_UP_MS;
  // ダウン検知後に同一プロセスへ戻った = 誤検知。オーバーレイを畳む。
  const clearRequest = giveUp || prev.offline;
  return {
    state: {
      connected: true,
      failures: 0,
      offline: false,
      requested: clearRequest ? false : prev.requested,
      requestedAt: clearRequest ? null : prev.requestedAt,
      startedAt: sample.startedAt,
    },
    reload: false,
    gaveUp: Boolean(giveUp),
  };
}

/** Probe cadence while a restart is requested or the server stopped answering. */
export const RESTART_PROBE_FAST_MS = 1_500;
/** Idle cadence: only detects restarts started elsewhere (another tab, tray), so seconds are fine. */
export const RESTART_PROBE_IDLE_MS = 10_000;
/** Hidden tabs barely probe; becoming visible probes immediately. */
export const RESTART_PROBE_HIDDEN_MS = 60_000;

/**
 * Next health-probe delay. The overlay used to probe every 1.5s forever, which made `/api/health`
 * the most frequent request of an idle tab (about 40/min, also in background tabs) for remote clients.
 */
export function nextRestartProbeDelayMs(state: RestartProbeState, hidden: boolean): number {
  if (state.requested || state.offline || state.failures > 0) return RESTART_PROBE_FAST_MS;
  return hidden ? RESTART_PROBE_HIDDEN_MS : RESTART_PROBE_IDLE_MS;
}
