/**
 * システム使用率モニター（sysmon）の型・純関数群。
 *
 * 表示・パース・計算をサーバー(API)とクライアント(ウィジェット)で共有する。
 * 変更/破壊を防ぐため、OS呼び出しや子プロセスには触れず純粋なロジックだけを持つ。
 */

export type Tone = "ok" | "warn" | "danger";

export interface CpuMetric {
  /** CPU使用率 (%)。取得できない場合は null */
  usedPercent: number | null;
  /** コア数（論理CPU数） */
  cores: number;
  /** CPUモデル名 */
  model: string;
}

export interface MemoryMetric {
  usedPercent: number;
  usedBytes: number;
  totalBytes: number;
}

export interface GpuMetric {
  /** NVidia等で取得できたか。false なら GPU は非表示にする */
  available: boolean;
  /** GPU 名称 */
  name: string | null;
  /** GPU使用率 (%)。取得不能時 null */
  usedPercent: number | null;
  /** VRAM使用率 (%)。取得不能時 null */
  vramUsedPercent: number | null;
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  /** GPU温度 (℃)。取得不能時 null（D3DKMT / nvidia-smi 経由） */
  tempC: number | null;
  /** GPU温度の最大許容値 (℃)。取得不能時 null */
  tempMaxC: number | null;
  /** 取得不可の理由（available=false のときのみ使う） */
  reason: string | null;
}

export interface SystemUsage {
  available: boolean;
  reason: string | null;
  schema: "sysmon.usage/v1";
  generatedAt: string | null;
  cpu: CpuMetric | null;
  memory: MemoryMetric | null;
  /** 検出できた GPU ごとの項目（NVidia と AMD の両方が見つかれば2件になる）。 */
  gpus: GpuMetric[];
}

/** 未使用・取得不能を表す空スナップショット。 */
export function emptyUsage(reason: string | null = null): SystemUsage {
  return {
    available: false,
    reason,
    schema: "sysmon.usage/v1",
    generatedAt: null,
    cpu: null,
    memory: null,
    gpus: [],
  };
}

/** 0–100 にクランプ（負値や超過値を防御）。 */
export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** null-safe な整数化（表示用）。 */
export function roundPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value);
}

/**
 * 使用率トーン: 70%未満 ok / 90%未満 warn / 以上 danger。
 * CodexBar の percentTone と同じ閾値を踏襲。
 */
export function percentTone(percent: number | null | undefined): Tone {
  const v = clampPercent(percent);
  if (v >= 90) return "danger";
  if (v >= 70) return "warn";
  return "ok";
}

/** バイト数を人の読みやすい表記に。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = "KB";
  for (const u of units) {
    if (value < 1024 || u === "TB") {
      unit = u;
      break;
    }
    value /= 1024;
  }
  return `${value.toFixed(2)} ${unit}`;
}

/**
 * 直前の CPU サンプルと今回のサンプルから使用率(%)を計算する。
 * total/idle の差分比を全コア平均して返す。サンプル間隔が極端に短い/時刻が
 * 逆転している場合は null（前回と値が変わらないときも割り算不能のため null）。
 */
export interface CpuSample {
  idle: number;
  total: number;
}

export function cpuUsedPercent(
  prev: readonly CpuSample[],
  curr: readonly CpuSample[],
): number | null {
  if (prev.length !== curr.length || prev.length === 0) return null;
  let busy = 0;
  let total = 0;
  for (let i = 0; i < curr.length; i++) {
    const dIdle = curr[i].idle - prev[i].idle;
    const dTotal = curr[i].total - prev[i].total;
    if (dTotal <= 0) return null;
    busy += dTotal - dIdle;
    total += dTotal;
  }
  if (total <= 0) return null;
  return clampPercent((busy / total) * 100);
}

/**
 * `os.cpus()` の生配列を `CpuSample[]` へ潰す（idle と busy+idle のみ保持）。
 * windows では `os.cpus()[i].times` のうち sys/irq が含まれることを考慮し、
 * user/nice/sys/irq の合計を busy として扱う。
 */
export function sampleFromOscpus(
  cpus: readonly { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[],
): CpuSample[] {
  return cpus.map((cpu) => {
    const t = cpu.times;
    return {
      idle: t.idle,
      total: t.user + t.nice + t.sys + t.idle + t.irq,
    };
  });
}

/** nvidia-smi の CSV 出力（`name,utilization.gpu,memory.used,memory.total[,temperature.gpu]`）1行を解釈する。 */
export function parseNvidiaSmiCsv(
  line: string,
): {
  name: string;
  usedPercent: number;
  vramUsedBytes: number;
  vramTotalBytes: number;
  tempC: number | null;
} | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(",").map((s) => s.trim());
  if (parts.length < 4) return null;
  const name = parts[0];
  const usedPercent = Number(parts[1]);
  const vramUsed = Number(parts[2]);
  const vramTotal = Number(parts[3]);
  if (!name || Number.isNaN(usedPercent) || Number.isNaN(vramUsed) || Number.isNaN(vramTotal)) {
    return null;
  }
  // temperature.gpu はオプション扱い（古い出力や [N/A] は null）。
  const tempRaw = parts.length >= 5 ? Number(parts[4]) : null;
  const tempC = tempRaw !== null && !Number.isNaN(tempRaw) ? tempRaw : null;
  return {
    name,
    usedPercent: clampPercent(usedPercent),
    vramUsedBytes: vramUsed * 1024 * 1024, // nvidia-smi は MiB 単位
    vramTotalBytes: vramTotal * 1024 * 1024,
    tempC,
  };
}

export interface AmdGpuData {
  name: string;
  usedPercent: number;
  vramUsedBytes: number;
  vramTotalBytes: number | null;
  tempC: number | null;
  tempMaxC: number | null;
}

/** 温度系フィールドを正規化する。欠落・0以下・非数は null（0=未サポート）。 */
function parseTempField(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

/** 単一 AMD JSON オブジェクトを正規化する。不正なら null。 */
function parseAmdGpuObject(raw: Record<string, unknown>): AmdGpuData | null {
  if (raw.available !== true || typeof raw.name !== "string" || !raw.name.trim()) {
    return null;
  }
  const usedPercent = Number(raw.usedPercent);
  const vramUsedBytes = Number(raw.dedicatedUsedBytes);
  const totalRaw = raw.vramTotalBytes;
  const vramTotalBytes = totalRaw === null || totalRaw === undefined ? null : Number(totalRaw);
  if (
    Number.isNaN(usedPercent) ||
    Number.isNaN(vramUsedBytes) ||
    vramUsedBytes < 0 ||
    (vramTotalBytes !== null && (Number.isNaN(vramTotalBytes) || vramTotalBytes < 0))
  ) {
    return null;
  }
  return {
    name: raw.name.trim(),
    usedPercent: clampPercent(usedPercent),
    vramUsedBytes,
    vramTotalBytes,
    tempC: parseTempField(raw.tempC),
    tempMaxC: parseTempField(raw.tempMaxC),
  };
}

/**
 * Windows の GPU パフォーマンスカウンターを AMD 用に正規化した JSON を解釈する。
 * AMD クエリは複数 GPU（dGPU/iGPU）を配列で返す。不正要素は省く。
 */
export function parseAmdGpuJson(text: string): AmdGpuData[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  const out: AmdGpuData[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const parsed = parseAmdGpuObject(item as Record<string, unknown>);
    if (parsed) out.push(parsed);
  }
  return out;
}
