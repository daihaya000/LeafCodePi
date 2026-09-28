import type { ThroughputTiming } from "@/lib/token-throughput";

/** Live timings are replaced through set; revision and clock-dependent rows stay cheap to check. */
export class VersionedThroughputMap extends Map<number, ThroughputTiming> {
  private revisionValue = 0;
  private awaitingFirstToken = new Set<number>();

  constructor(entries?: Iterable<readonly [number, ThroughputTiming]>) {
    super();
    if (entries) for (const [startedAt, timing] of entries) this.set(startedAt, timing);
    this.revisionValue = 0;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get awaitingFirstTokenCount(): number {
    return this.awaitingFirstToken.size;
  }

  /** Iterates pending start times without exposing the mutable index. */
  pendingStartedAts(): Iterable<number> {
    return this.awaitingFirstToken.values();
  }

  override set(startedAt: number, timing: ThroughputTiming): this {
    super.set(startedAt, timing);
    if (timing.lastTokenAtMs === null) this.awaitingFirstToken.add(startedAt);
    else this.awaitingFirstToken.delete(startedAt);
    this.revisionValue++;
    return this;
  }

  override delete(startedAt: number): boolean {
    if (!super.delete(startedAt)) return false;
    this.awaitingFirstToken.delete(startedAt);
    this.revisionValue++;
    return true;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    this.awaitingFirstToken.clear();
    this.revisionValue++;
  }
}
