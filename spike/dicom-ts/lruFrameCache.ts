/**
 * Byte-bounded LRU cache for decoded cine frames (Spec §4, §6).
 *
 * Prevents unbounded multi-frame cine allocation from crashing browser tabs.
 */

import type { DecodedMeasurementFrame } from './ports';

export interface FrameCacheStats {
  readonly maxBytes: number;
  readonly currentBytes: number;
  readonly highWaterMarkBytes: number;
  readonly entryCount: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export class LruFrameCache {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, DecodedMeasurementFrame>();
  private currentBytes = 0;
  private highWaterMarkBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxBytes: number = 96 * 1024 * 1024) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be positive');
    }
    this.maxBytes = Math.floor(maxBytes);
  }

  private static makeKey(sopInstanceUid: string, frameIndex: number): string {
    return `${sopInstanceUid}#${frameIndex}`;
  }

  public get(sopInstanceUid: string, frameIndex: number): DecodedMeasurementFrame | undefined {
    const key = LruFrameCache.makeKey(sopInstanceUid, frameIndex);
    const found = this.entries.get(key);
    if (!found) {
      this.misses += 1;
      return undefined;
    }
    // Refresh recency
    this.entries.delete(key);
    this.entries.set(key, found);
    this.hits += 1;
    return found;
  }

  public put(frame: DecodedMeasurementFrame): void {
    const frameBytes = frame.pixels.byteLength;
    if (frameBytes > this.maxBytes) {
      // Single frame larger than entire cache budget: do not evict everything in vain
      return;
    }
    const key = LruFrameCache.makeKey(frame.sopInstanceUid, frame.frameIndex);
    const existing = this.entries.get(key);
    if (existing) {
      this.currentBytes -= existing.pixels.byteLength;
      this.entries.delete(key);
    }

    while (this.currentBytes + frameBytes > this.maxBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.currentBytes -= oldest.pixels.byteLength;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }

    this.entries.set(key, frame);
    this.currentBytes += frameBytes;
    if (this.currentBytes > this.highWaterMarkBytes) {
      this.highWaterMarkBytes = this.currentBytes;
    }
  }

  public evictInstance(sopInstanceUid: string): void {
    const prefix = `${sopInstanceUid}#`;
    for (const [key, frame] of this.entries) {
      if (key.startsWith(prefix)) {
        this.currentBytes -= frame.pixels.byteLength;
        this.entries.delete(key);
      }
    }
  }

  public clear(): void {
    this.entries.clear();
    this.currentBytes = 0;
  }

  public stats(): FrameCacheStats {
    return {
      maxBytes: this.maxBytes,
      currentBytes: this.currentBytes,
      highWaterMarkBytes: this.highWaterMarkBytes,
      entryCount: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
