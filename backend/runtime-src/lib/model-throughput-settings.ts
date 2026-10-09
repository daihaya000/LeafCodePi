/** モデル選択欄の速度実績に使う、モデル×プロバイダーごとの直近応答数。 */
export const MODEL_THROUGHPUT_WINDOW_SETTING_KEY = "model-throughput-window";
export const DEFAULT_MODEL_THROUGHPUT_WINDOW = 50;
export const MAX_MODEL_THROUGHPUT_WINDOW = 1000;
export const MODEL_THROUGHPUT_WINDOW_OPTIONS = [10, 20, 50, 100, 200, 500, 1000] as const;

export function isModelThroughputWindow(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MODEL_THROUGHPUT_WINDOW;
}

export function parseModelThroughputWindow(value: string | null): number {
  const count = value === null ? NaN : Number(value);
  return isModelThroughputWindow(count) ? count : DEFAULT_MODEL_THROUGHPUT_WINDOW;
}
