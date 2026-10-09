/** Short, fail-open-on-expiry lease: a failed Host must not strand prompt admission. */
let until = 0;
export function autoUpdateMaintenanceActive(): boolean { return Date.now() < until; }
export function setAutoUpdateMaintenance(active: boolean): void { until = active ? Date.now() + 5 * 60_000 : 0; }
export function assertAutoUpdateAvailable(): void {
  if (autoUpdateMaintenanceActive()) {
    throw Object.assign(new Error("LCPの自動更新を準備中です。しばらく待って再送してください"), { status: 503 });
  }
}
