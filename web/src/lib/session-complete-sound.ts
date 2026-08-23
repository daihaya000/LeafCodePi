import {
  readNotificationSoundType,
  readNotificationSoundVolume,
  type NotificationSoundType,
} from "@/lib/notification-sound-settings";

/** Raise the audible baseline while keeping the user volume multiplier intact. */
const BASE_GAIN_MULTIPLIER = 4;
const MAX_TONE_GAIN = 0.95;
const STANDARD_COMPLETION_GAIN = 0.135 * BASE_GAIN_MULTIPLIER;
const STANDARD_ATTENTION_GAIN = 0.15 * BASE_GAIN_MULTIPLIER;

type ToneConfig = {
  duration: number;
  startFreq: number;
  endFreq: number;
  gain: number;
  waveform: OscillatorType;
};

type AttentionConfig = ToneConfig & {
  count: number;
  gap: number;
};

type SoundProfile = {
  completion: ToneConfig;
  attention: AttentionConfig;
};

const SOUND_PROFILES: Record<NotificationSoundType, SoundProfile> = {
  standard: {
    completion: {
      duration: 0.18,
      startFreq: 880,
      endFreq: 1320,
      gain: STANDARD_COMPLETION_GAIN,
      waveform: "sine",
    },
    attention: {
      count: 3,
      gap: 0.1,
      duration: 0.11,
      startFreq: 660,
      endFreq: 660,
      gain: STANDARD_ATTENTION_GAIN,
      waveform: "sine",
    },
  },
  soft: {
    completion: {
      duration: 0.24,
      startFreq: 660,
      endFreq: 990,
      gain: 0.105 * BASE_GAIN_MULTIPLIER,
      waveform: "sine",
    },
    attention: {
      count: 2,
      gap: 0.12,
      duration: 0.14,
      startFreq: 520,
      endFreq: 520,
      gain: 0.11 * BASE_GAIN_MULTIPLIER,
      waveform: "sine",
    },
  },
  clear: {
    completion: {
      duration: 0.16,
      startFreq: 1046,
      endFreq: 1568,
      gain: 0.15 * BASE_GAIN_MULTIPLIER,
      waveform: "triangle",
    },
    attention: {
      count: 3,
      gap: 0.08,
      duration: 0.09,
      startFreq: 740,
      endFreq: 740,
      gain: 0.16 * BASE_GAIN_MULTIPLIER,
      waveform: "triangle",
    },
  },
};

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext
  );
}

/**
 * Create an AudioContext, schedule the given tones, and close the context
 * once the last scheduled oscillator has ended.
 */
function withAudioContext(
  schedule: (ctx: AudioContext, start: number) => OscillatorNode[],
) {
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) return;

  try {
    const ctx = new AudioContextCtor();
    const oscillators = schedule(ctx, ctx.currentTime);
    const last = oscillators[oscillators.length - 1];
    last?.addEventListener("ended", () => {
      void ctx.close().catch(() => undefined);
    });
  } catch {
    // Autoplay/user-activation restrictions or unavailable audio devices.
  }
}

function createTone(
  ctx: AudioContext,
  start: number,
  tone: ToneConfig,
  volumeMultiplier: number,
): OscillatorNode {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const end = start + tone.duration;
  const rampEnd = start + Math.min(0.08, tone.duration / 2);
  const targetGain = Math.min(
    MAX_TONE_GAIN,
    tone.gain * volumeMultiplier,
  );

  oscillator.type = tone.waveform;
  oscillator.frequency.setValueAtTime(tone.startFreq, start);
  oscillator.frequency.exponentialRampToValueAtTime(tone.endFreq, rampEnd);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(targetGain, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(end);
  return oscillator;
}

/**
 * Play a short, non-blocking completion chime for a session busy/retry → idle
 * transition. Browsers may reject audio before a user gesture; this is best
 * effort and intentionally never surfaces errors to the UI.
 */
export function playSessionCompleteSound() {
  const volumeMultiplier = readNotificationSoundVolume() / 100;
  if (volumeMultiplier <= 0) return;
  const tone = SOUND_PROFILES[readNotificationSoundType()].completion;
  withAudioContext((ctx, start) => [
    createTone(ctx, start, tone, volumeMultiplier),
  ]);
}

/**
 * Play a short, non-blocking alert when a user approval (permission) or
 * question UI appears. Best effort, like the completion chime.
 */
export function playAttentionRequiredSound() {
  const volumeMultiplier = readNotificationSoundVolume() / 100;
  if (volumeMultiplier <= 0) return;
  const attention = SOUND_PROFILES[readNotificationSoundType()].attention;
  withAudioContext((ctx, start) => {
    const oscillators: OscillatorNode[] = [];
    for (let i = 0; i < attention.count; i++) {
      const at = start + i * (attention.duration + attention.gap);
      oscillators.push(
        createTone(ctx, at, attention, volumeMultiplier),
      );
    }
    return oscillators;
  });
}
