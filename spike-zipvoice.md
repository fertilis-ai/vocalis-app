# Spike: ZipVoice local zero-shot voice cloning via sherpa-onnx

**Date:** 2026-07-09 · **Task:** #7 (M0-parallel spike, spec §7.1)
**Machine:** Apple M4 Pro, 12 cores, 48 GB RAM, macOS 26.5.1

## Verdict: GO (with caveats)

Local zero-shot cloning with ZipVoice-Distill through sherpa-onnx comfortably beats the
time-to-first-audio < 1.5 s target on this machine: **~0.8 s to synthesize a short
sentence** (RTF ≈ 0.23) with 8 threads, model already warm. The official Rust crate
exposes the full API including reference audio/text and a progressive-samples callback.
Caveats: audio quality not yet human-verified (wav paths below), **no French support**
in the available model (zh/en only), and thread-count tuning matters a lot (RTF 1.24
single-threaded → 0.23 at 8 threads).

## Support status

- **sherpa-onnx core:** ZipVoice is a first-class offline TTS engine (docs:
  https://k2-fsa.github.io/sherpa/onnx/tts/zipvoice.html). Batch-only, as expected —
  no streaming synthesis, but the generate API emits samples progressively via callback.
- **CLI:** `sherpa-onnx-offline-tts` (v1.13.4 prebuilt, osx-arm64) supports it via
  `--zipvoice-*` flags plus `--reference-audio` / `--reference-text`. Reference text must
  exactly match the spoken reference audio.
- **Official Rust crate (`sherpa-onnx` 1.13.4 on crates.io, published 2026-07-08):
  ZipVoice IS exposed.**
  - `OfflineTtsZipvoiceModelConfig { encoder, decoder, vocoder, tokens, lexicon, data_dir, feat_scale, t_shift, target_rms, guidance_scale }`
  - `OfflineTts::create(&OfflineTtsConfig)`, `OfflineTts::generate_with_config(text, &GenerationConfig, Option<callback>)`
  - `GenerationConfig { reference_audio, reference_sample_rate, reference_text, num_steps, sid, speed, silence_scale, extra }`
  - The callback receives `(&[f32] samples-so-far, progress)` and can stop generation
    early — useful for starting playback before a sentence finishes rendering.
- `sherpa-rs` (0.6.8, last updated 2025-10) is stale by comparison; not needed.

## Exact artifacts used

| Artifact | URL | Size |
|---|---|---|
| Model (int8 distill) | https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2 | 109 MB |
| Vocoder | https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx | 54 MB |
| CLI | https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-osx-arm64-shared.tar.bz2 | 27 MB |

Other variants on the same release: full-precision `zipvoice` and `zipvoice-distill`
(~635 MB each), `zipvoice-distill-fp32` (478 MB). Only int8 tested.

Reference voice: 6.3 s of macOS `say -v Samantha` output, converted to 24 kHz mono wav
(synthetic reference — a real mic recording should also be validated in M5).

## Latency (distill int8, num-steps=4, warm runs, 3 runs each)

Output: 24 kHz mono 16-bit wav. Short sentence = 12 words → 3.5 s audio;
medium = 28 words → 8.8 s audio.

| Config | Short synth time | Short RTF | Medium synth time | Medium RTF |
|---|---|---|---|---|
| 1 thread (default) | 4.34 s | 1.24 | — | — |
| 4 threads | 1.32–1.33 s | 0.38–0.40 | 2.19–2.20 s | 0.25 |
| 8 threads | 0.81–0.85 s | 0.23–0.24 | 1.35–1.60 s | 0.15–0.18 |
| 8 threads, num-steps=8 | 1.67 s | 0.48 | — | — |

- **Model load:** ~0.5 s (1.34 s total wall − 0.83 s synthesis). Cheap enough to lazy-load;
  keep warm in EngineManager anyway per spec §3.3.
- **Memory:** peak RSS ~634 MB with int8 model + vocoder loaded (per `/usr/bin/time -l`).
  Fine here; consistent with the spec's 8 GB-machine concern (§7.7).
- **Time-to-first-audio for sentence-chunked chat:** first short sentence ≈ 0.8–1.0 s
  after the LLM emits it (warm model, 8 threads) — under the 1.5 s target with margin.
  Subsequent sentences synthesize faster than they play (RTF ≤ 0.25), so the queue never
  starves. The Rust callback API could cut perceived TTFA further by streaming samples
  into playback before a sentence completes.

## Output wavs for listening (quality not machine-verifiable)

All in `/private/tmp/claude-501/-Users-martin-dev-fertilis-clone-app/76737b0c-3084-487f-88c1-b9a666c0cbd5/scratchpad/zipvoice-spike/`:

- `ref-24k.wav` — the Samantha reference (6.3 s)
- `out-short-t8-1.wav` … `-3.wav` — short sentence, 8 threads, steps=4
- `out-medium-t8-1.wav` … `-3.wav` — medium sentence, 8 threads, steps=4
- `out-short-steps8.wav` — same short sentence at steps=8 (quality A/B vs steps=4)
- `out-short-t4-*.wav`, `out-medium-t4-*.wav` — 4-thread runs (identical audio path)

Note: the scratchpad is session-scoped — copy anything worth keeping before it's cleaned.

## Risks / caveats

1. **Quality unheard.** int8 quantization + 4 distill steps may degrade similarity or
   naturalness; steps=8 doubles synth time (still only 1.67 s short). Listen to the wavs;
   if int8 quality disappoints, `zipvoice-distill-fp32` (478 MB) is the next candidate.
2. **No French.** The only published sherpa-onnx ZipVoice models are zh/en (Emilia
   dataset, espeak-ng zh-en lexicon). Spec §Appendix A.14 wants EN+FR first-class:
   FR cloned voices will need ElevenLabs (already the API fallback) or a future model.
   This should be documented in the routing matrix alongside the FR streaming-ASR gap.
3. **Thread budget.** The 0.8 s number uses 8 of 12 cores. In a live pipeline with
   VAD+ASR resident, contention will add latency; benchmark inside the real
   EngineManager during M5 and expose `num_threads` as a tunable.
4. **Synthetic reference.** The `say`-generated reference proves the mechanics, not
   real-mic cloning quality. M5's guided-recording flow is the true test.
5. **Dev-only gotcha:** the prebuilt macOS binaries get SIGKILLed by Gatekeeper until
   `xattr -dr com.apple.quarantine` + ad-hoc `codesign`. Irrelevant for the product
   (we compile via the crate), relevant for anyone re-running this spike.
6. **Batch-only** (confirmed): no streaming input; sentence-chunking is the right design,
   and the numbers above show it holds.

## Recommended integration path

Use the **official `sherpa-onnx` Rust crate (k2-fsa), v1.13.4+** — it exposes everything
the CLI does (same C++ core), fits the spec's "one inference stack, in-process" rule, and
its per-generation `GenerationConfig` maps cleanly onto the `Tts` trait
(`synth(text, voice, params)`): a clone voice = stored `{refAudio, refText}` per spec
§3.5. No need for `sherpa-rs` or raw C FFI for this feature. Catalog entry: pin the
int8 distill tarball + vocos_24khz vocoder URLs above (pending the quality listen).
Default `num_steps=4`, `num_threads` ≈ physical performance cores − ASR budget.
