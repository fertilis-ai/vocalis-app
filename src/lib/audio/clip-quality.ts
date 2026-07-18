import type { ClipQuality } from "@/lib/engines/local";

// Clone-reference quality gate (M5 item 1): Rust measures peak/rms and the
// VAD-split speech/noise levels; the pass/fail thresholds live here where
// they're unit-testable and rendered per take. A failing take is rejected
// with a re-record prompt — ZipVoice similarity degrades sharply on clipped,
// quiet, or noisy references.

/** Digital clipping: absolute peak at (or within rounding of) full scale. */
export const CLIP_PEAK = 0.99;
/** Speech below this RMS is too quiet to clone from — re-record closer/louder. */
export const MIN_SPEECH_RMS = 0.015;
/** Noise floor (RMS during VAD silence) above this drowns the reference. */
export const MAX_NOISE_RMS = 0.02;
/** Guided range is ~10–60 s; hard bounds are looser so a 9.5 s take passes
 * the spirit of the guide but a 5 s one doesn't. */
export const MIN_DURATION_SECS = 8;
export const MAX_DURATION_SECS = 75;
/** The VAD must find at least this much actual speech in the take. */
export const MIN_SPEECH_SECS = 5;

export type QualityCheckCode =
  | "clipping"
  | "level"
  | "noise"
  | "duration";

export interface QualityCheck {
  code: QualityCheckCode;
  label: string;
  pass: boolean;
  /** Human-readable measurement, shown pass or fail. */
  detail: string;
}

/** Evaluate one recorded take. Every check is returned (pass and fail) so the
 * UI can show the full report per take; the take is usable only when all pass. */
export function evaluateCloneRef(q: ClipQuality): QualityCheck[] {
  const speechOk =
    q.durationSecs >= MIN_DURATION_SECS &&
    q.durationSecs <= MAX_DURATION_SECS &&
    q.speechSecs >= MIN_SPEECH_SECS;
  return [
    {
      code: "clipping",
      label: "No clipping",
      pass: q.peak < CLIP_PEAK,
      detail: `peak ${q.peak.toFixed(2)}`,
    },
    {
      code: "level",
      label: "Speech level",
      pass: q.speechRms >= MIN_SPEECH_RMS,
      detail: `rms ${q.speechRms.toFixed(3)}`,
    },
    {
      code: "noise",
      label: "Background noise",
      // No VAD silence found means we can't measure a floor — don't fail on it.
      pass: q.noiseRms <= MAX_NOISE_RMS,
      detail: `floor ${q.noiseRms.toFixed(3)}`,
    },
    {
      code: "duration",
      label: "Length",
      pass: speechOk,
      detail: `${q.durationSecs.toFixed(1)} s, ${q.speechSecs.toFixed(1)} s speech`,
    },
  ];
}

export function cloneRefPasses(q: ClipQuality): boolean {
  return evaluateCloneRef(q).every((c) => c.pass);
}

/** Re-record guidance for the first failed check, e.g. under a rejected take. */
export function cloneRefAdvice(checks: QualityCheck[]): string | null {
  const failed = checks.find((c) => !c.pass);
  if (!failed) return null;
  switch (failed.code) {
    case "clipping":
      return "The recording clipped — lower the input gain or move back from the mic, then re-record.";
    case "level":
      return "Too quiet — move closer to the mic or raise the input gain, then re-record.";
    case "noise":
      return "Too much background noise — find a quieter spot, then re-record.";
    case "duration":
      return `Aim for roughly 10–60 seconds of continuous speech (at least ${MIN_SPEECH_SECS} s of actual talking).`;
  }
}
