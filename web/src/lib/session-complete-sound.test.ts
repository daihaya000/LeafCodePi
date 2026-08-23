// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeNotificationSoundType,
  writeNotificationSoundVolume,
} from "./notification-sound-settings";

type MockOscillator = {
  type: OscillatorType;
  frequency: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};

type MockGain = {
  gain: {
    setValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
};

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  currentTime = 0;
  destination = {};
  oscillators: MockOscillator[] = [];
  gains: MockGain[] = [];
  close = vi.fn(async () => undefined);

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createOscillator(): MockOscillator {
    const oscillator: MockOscillator = {
      type: "sine",
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): MockGain {
    const gain: MockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    this.gains.push(gain);
    return gain;
  }
}

import {
  playAttentionRequiredSound,
  playSessionCompleteSound,
} from "./session-complete-sound";

describe("session-complete-sound", () => {
  let originalAudioContext: unknown;

  beforeEach(() => {
    localStorage.clear();
    MockAudioContext.instances = [];
    originalAudioContext = (window as unknown as { AudioContext?: unknown })
      .AudioContext;
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      writable: true,
      value: MockAudioContext,
    });
  });

  afterEach(() => {
    localStorage.clear();
    if (originalAudioContext === undefined) {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    } else {
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        writable: true,
        value: originalAudioContext,
      });
    }
  });

  it("uses the louder standard completion chime at full volume", () => {
    playSessionCompleteSound();

    const context = MockAudioContext.instances[0]!;
    expect(context.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(
      880,
      0,
    );
    expect(
      context.gains[0]?.gain.exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(0.54, 0.02);
  });

  it("scales both notification sounds by the configured volume", () => {
    writeNotificationSoundVolume(50);
    playSessionCompleteSound();
    expect(
      MockAudioContext.instances[0]?.gains[0]?.gain
        .exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(0.27, 0.02);

    writeNotificationSoundType("clear");
    playAttentionRequiredSound();
    const attention = MockAudioContext.instances[1]!;
    expect(attention.oscillators).toHaveLength(3);
    expect(attention.oscillators[0]?.type).toBe("triangle");
    expect(attention.oscillators[0]?.frequency.setValueAtTime).toHaveBeenCalledWith(
      740,
      0,
    );
    expect(
      attention.gains[0]?.gain.exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(0.32, 0.02);
  });

  it("caps the amplified gain to avoid clipping at 200% volume", () => {
    writeNotificationSoundVolume(200);
    writeNotificationSoundType("clear");
    playAttentionRequiredSound();

    expect(
      MockAudioContext.instances[0]?.gains[0]?.gain
        .exponentialRampToValueAtTime,
    ).toHaveBeenCalledWith(0.95, 0.02);
  });

  it("does not create an AudioContext when muted", () => {
    writeNotificationSoundVolume(0);

    playSessionCompleteSound();
    playAttentionRequiredSound();

    expect(MockAudioContext.instances).toHaveLength(0);
  });
});
