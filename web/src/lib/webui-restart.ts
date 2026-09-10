/**
 * 再起動オーバーレイの判定。単発の health 失敗（サーバ側の一時的な遅延、
 * ブラウザの接続上限待ち、タブのスロットリング、スリープ復帰）を「再起動」と
 * 誤検知して勝手にリロードしないための状態機械。
 */

/** 連続でこの回数失敗するまではダウンとみなさない。 */
export const OFFLINE_STREAK = 3;

export type RestartProbeState = {
  /** health に一度でも成功したか。初回接続前の失敗は無視する。 */
  connected: boolean;
  /** 連続失敗数。 */
  failures: number;
  /** ダウンを検知済みか。 */
  offline: boolean;
  /** UI から明示的に再起動を要求したか。 */
  requested: boolean;
  /** 直近に観測したサーバプロセスの起動時刻（未提供なら null）。 */
  startedAt: number | null;
};

export const INITIAL_RESTART_PROBE: RestartProbeState = {
  connected: false,
  failures: 0,
  offline: false,
  requested: false,
  startedAt: null,
};

export function isRestartOverlayVisible(state: RestartProbeState): boolean {
  return state.requested || state.offline;
}

/**
 * 1 回分の health 結果を畳み込む。`sample` が null なら到達不能。
 * `reload` は「サーバが実際に別プロセスへ入れ替わった」ときだけ true。
 */
export function nextRestartProbe(
  prev: RestartProbeState,
  sample: { startedAt: number | null } | null,
): { state: RestartProbeState; reload: boolean } {
  if (!sample) {
    const failures = prev.failures + 1;
    // 明示要求後はダウンを待つ状態なので 1 回の失敗で確定させる。
    const offline =
      prev.offline || prev.requested || (prev.connected && failures >= OFFLINE_STREAK);
    return { state: { ...prev, failures, offline }, reload: false };
  }
  // startedAt を返さないサーバ（旧版）は判別できないので従来どおりリロードする。
  const restarted =
    prev.startedAt === null || sample.startedAt === null || sample.startedAt !== prev.startedAt;
  if (prev.offline && restarted) {
    return {
      state: { ...prev, connected: true, failures: 0, startedAt: sample.startedAt },
      reload: true,
    };
  }
  return {
    state: {
      connected: true,
      failures: 0,
      offline: false,
      // ダウン検知後に同一プロセスへ戻った = 誤検知。オーバーレイを畳む。
      requested: prev.offline ? false : prev.requested,
      startedAt: sample.startedAt,
    },
    reload: false,
  };
}
