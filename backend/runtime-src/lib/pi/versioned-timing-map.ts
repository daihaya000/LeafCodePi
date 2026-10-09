/** A timing map whose revision changes even when an existing call ID is overwritten. */
export class VersionedTimingMap extends Map<string, number> {
  private revisionValue = 0;

  constructor(entries?: Iterable<readonly [string, number]>) {
    super();
    if (entries) for (const [callID, time] of entries) super.set(callID, time);
  }

  get revision(): number {
    return this.revisionValue;
  }

  override set(callID: string, time: number): this {
    super.set(callID, time);
    this.revisionValue++;
    return this;
  }

  override delete(callID: string): boolean {
    if (!super.delete(callID)) return false;
    this.revisionValue++;
    return true;
  }

  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    this.revisionValue++;
  }
}
