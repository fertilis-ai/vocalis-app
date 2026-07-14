# Vocalis — Improvement Review

_Reviewed 2026-07-11 (three parallel deep passes: Rust backend, React webview, tooling/tests/hygiene). Every finding below was verified by reading the code — file:line cited where it matters._

**Overall verdict:** this is a disciplined codebase. The IPC boundary ("raw audio never crosses to the webview") is genuinely honored everywhere — every `PipelineEvent`/`RecorderEvent`/`DownloadEvent` variant was checked and none carry samples, only paths and derived scalars. The engine router's privacy-mode gate is airtight (API engines excluded before any other eligibility check). Disk-loaded JSON is Zod-validated with quarantine-and-backup. Audio hooks guard stale-async races with generation counters. Pure algorithmic logic (chunk stitching, speaker clustering, catalog sanity) is well unit-tested. The real gaps cluster in four places: **panic/failure recovery in the pipeline machinery, the `speech.rs` god file, duplicated state machines (both sides of the boundary), and missing CI/build hardening.**

---

## P0 — Reliability bugs worth fixing before the M2/M3/M4 exit tests

### 1. A panic in a dictation or recorder thread permanently wedges the feature until restart
`pipeline/mod.rs`, `chat_capture.rs`, and `live_session.rs` wrap their thread bodies in `DropGuard` so `registry.finish(id)` runs even on unwind — but `pipeline/dictation.rs:132-136` and `pipeline/recorder.rs:103-106` call `run(...)` then `finish(id)` as two plain statements. If the body panics, `finish` never runs, and because `DictationRegistry::register` (dictation.rs:41-44) rejects a second dictation while any entry exists, **one panic blocks all future dictation for the rest of the app session with no recovery path**. Fix: apply the same `DropGuard` pattern already used by the other three pipelines.

### 2. Mutex poisoning can brick individual engines after any panic
31 sites of `.lock().unwrap()` on the engine slots (`state.rs:86-105`, `commands/speech.rs:392, 609, 678, 742, 921, 1062, 1112`, …). These locks guard sherpa-onnx FFI engine construction — a plausible panic site — and poisoning then makes *every subsequent command* on that slot panic too. The slots are read-and-replace caches, so poisoning protects no invariant. Fix: `parking_lot::Mutex` (no poisoning) or `.unwrap_or_else(|p| p.into_inner())`.

### 3. Thread-spawn failure kills the whole app instead of surfacing as an event
Every pipeline start path does `thread::Builder::spawn(...).expect(...)`: `pipeline/mod.rs:281, 388`, `live_session.rs:86`, `dictation.rs:136`, `import.rs:73`, `chat_capture.rs:160`, `recorder.rs:107`. Spawn failure under resource pressure takes down the Tauri process. Inconsistent, too: these functions already return `Result<u32, String>` for other failure modes — route spawn failure into that same `Result`.

### 4. `people-store` skips the write-queue every other store uses
`chat-store`, `session-store`, and `collection-store` wrap read-modify-write mutations in `serialize()` (`src/lib/write-queue.ts`) to prevent concurrent writes clobbering each other. `people-store.ts:102-109` (`update`) and `:123-125` (`saveEnrollment`) do a bare read → `writeFile` → `set`. A rename racing an enrollment save can silently lose one of the writes. Same one-line fix pattern as the other stores: `serialize(\`person:${id}\`, …)`.

### 5. Malformed `config.yaml` triggers a silent infinite retry loop
In `src/lib/config-sync.ts:75-118`, both parse-failure paths return without updating `lastKnownContent`, so the 2 s poll (`:120-132`) re-reads, re-parses, and re-warns the same broken file forever. Fix: set `lastKnownContent = content` on parse failure so a given bad content is attempted once, and surface one visible notice (toast/log) instead of console spam every 2 s.

---

## P1 — Structure: pay down the two god files and the copy-pasted machinery

### 6. Split `commands/speech.rs` (1170 lines — violates the project's own no-god-files rule)
It's five domains bolted together, and the file already marks its own seams with section banners. Concrete split, matching how dictation/chat_capture/people commands were already carved out:
- `commands/speech/mod.rs` — shared helpers (`resolve_model_dir`, `resolve_vad_path`, `vad_params`, `read_wav_16k`) + re-exports
- `commands/speech/session.rs` — pipeline start/stop, import_audio, session_import* (lines 81–334)
- `commands/speech/tts.rs` — tts_synthesize, cache eviction, save_to_library, sanitize_slug (336–519)
- `commands/speech/recorder.rs` — record_start/stop/cancel (521–559)
- `commands/speech/bench.rs` — the one-shot file-analysis tools: VAD/punctuate/ASR/speaker/diarize/KWS/langid/separate/audio_file_info (561–1170)

`pub use speech::*` from `commands/mod.rs` keeps `generate_handler!` untouched.

### 7. Extract the VAD-utterance state machine copy-pasted across three pipelines
`dictation.rs:182-248`, `chat_capture.rs:206-271`, and `live_session.rs:173-236` each reimplement the same shape: `in_utterance` tracking, rising-edge accumulation, falling-edge decode-and-clear, and (verbatim in all three) the fresh-`AtomicBool` force-flush-on-stop idiom. The decode itself is already factored into `vad_batch.rs`; the outer state machine is not. This is active bug risk, not just repetition — the chat_capture copy already diverges subtly, and finding #1 above is exactly the kind of fix that gets applied to some copies and missed in others. Extract a shared utterance-accumulator parameterized by the per-turn callback.

### 8. Unify the four near-identical registries
`PipelineRegistry`, `DictationRegistry`, `ChatCaptureRegistry`, `RecorderRegistry` each reimplement `AtomicU32` counter + `Mutex<HashMap<u32, Entry>>` + register/stop/finish/paths_in_use (~150 duplicated lines). A generic `IdRegistry<T>` fixes the DropGuard class of bug once instead of per-copy.

### 9. Extract shared playground hooks (webview mirror of #7)
- **Bench-run pattern:** `kws-tool`, `vad-tool`, `langid-tool` (`langid-tool.tsx:53-99`), `speaker-verify-tool.tsx:24-89`, and siblings each repeat ~30–40 lines of `busy/error/selectedRunId` state + try/catch/finally + `performance.now()` timing + `addRun` + `restoreRun`. Extract `useBenchRun<TResult>({ tool, engineId, run })` → cuts ~150–200 duplicate lines and centralizes the run-persistence contract.
- **Live pipeline lifecycle:** `kws-tool.tsx:227-291` and `vad-tool.tsx:98-174` each hand-roll pipelineId ref + ready/level/error/stopped event switch + start/stop + unmount cleanup. Extract `useLivePipeline(startFn, { onEvent })`.

### 10. Move `live_session.rs`'s pure algorithmic core into `speakers.rs`
`OnlineLabeler` (live_session.rs:492-567) and `refine_speakers` (:575-606) — ~180 lines under the file's own "Pure algorithmic core" banner — belong with the closely related clustering logic already in `speakers.rs`, per the convention `vad_batch.rs`/`speakers.rs` established. Leaves `live_session.rs` at ~500 lines of pure pipeline mechanics.

### 11. Split `lib/engines/local.ts` (812 lines) — low urgency, same convention
All thin `invoke()` wrappers, so not unmaintainable, but it mixes five concerns. Split into `engines/local/{pipelines,file-analysis,recording,tts}.ts` re-exported from `index.ts` so the import path stays stable.

---

## P2 — Hardening: CI, build, security posture

### 12. Add CI (there is none — `.github/` doesn't exist)
The complete local gate already exists; CI is just running it. Minimal `ci.yml`: **web job** on ubuntu (`setup-bun` → `bun install --frozen-lockfile` → `lint` → `check-types` → `test:run`) + **rust job** on macos (cpal/keychain are mac-only; `Swatinem/rust-cache` → `cargo check` + `cargo test` in `src-tauri/`). Keep the `--ignored` real-model tests out of CI.

### 13. Add a `[profile.release]` to `src-tauri/Cargo.toml`
Currently absent — no LTO, no strip, default codegen-units, with sherpa-onnx statically linked. Stock Tauri v2 profile: `panic = "abort"`, `codegen-units = 1`, `lto = true`, `opt-level = "s"`, `strip = true`.

### 14. Tighten CSP: `connect-src` includes bare `https:`
`src-tauri/tauri.conf.json:42` lets the webview `fetch()` **any** https origin, making the carefully scoped `http:default` capability allowlist (four API hosts in `capabilities/default.json`) cosmetic for plain fetch — and undercutting the "provably offline" privacy-mode story. Tighten `connect-src` to the four API domains; consider narrowing `img-src https:` too.

### 15. Download robustness (`registry/download.rs`)
The atomicity story is good (verified sha256 → atomic rename → full `dest_dir` rollback). Gaps:
- **No resume** (`fetch_to_file`, :354-402): plain `reqwest::get`, no `Range` header — a network blip on a multi-GB model restarts from byte 0, and a late failure on the second `extra_file` (:333-349) discards the already-verified primary archive.
- **Stale `.part` files** are only cleaned on the next attempt for the *same* model (:295), never at startup — a crash mid-download leaves them indefinitely.
- **`ExtraFile.sha256` is `Option` with no test** enforcing catalog entries pin it (`model.sha256` is enforced by `bundled_catalog_parses_and_is_sane`, :495-499; extra files aren't).

### 16. Hot-path allocations in the cpal callback
`LinearResampler::process` (`audio/resample.rs:29-68`) and `downmix_to_mono` (:72-81) allocate a fresh `Vec` per callback, and both run inside the realtime cpal callback (`audio/capture.rs:94-100`) for the lifetime of every live pipeline (44.1/48 kHz mics hit the resample path on essentially every buffer). Reuse scratch buffers owned by `AudioCapture`.

### 17. Unbounded session audio buffer
The recorder caps clips at 600 s (`recorder.rs:47`), but `live_session.rs`'s whole-session `buffer: Vec<f32>` (:148) has no ceiling, and the stop-time diarization re-processes the entire buffer on every stop (acknowledged at :399-401). Add a soft cap + warning event, or document the expected max session length.

### 18. TOCTOU in model deletion (minor)
`commands/models.rs:128-133` checks `model_in_use` then deletes — a pipeline could start loading that dir in the gap. Narrow window, single local user; a comment or coarse lock during delete suffices.

---

## P3 — Test gaps (highest-value first)

| Gap | Where | Why it matters |
|---|---|---|
| API engine adapters untested | `src/lib/engines/{openai,groq,deepgram,elevenlabs,http}.ts` | Request shaping/error mapping is unit-testable with mocked fetch; the router is tested but the adapters it routes to aren't |
| `storage.ts` + `write-queue.ts` untested | `src/lib/` | Every store depends on them; write-queue is the concurrency guarantee |
| `DictationRegistry` single-slot invariant untested | `dictation.rs:41-44` | `ChatCaptureRegistry` has exactly this test (`chat_capture.rs:320-337`); dictation's identical rule has none |
| Partial `extra_files` rollback untested | `download.rs:296-298` | The all-or-nothing guarantee is only exercised by the happy-path real-network test |
| Pure-logic Rust files with zero tests | `audio/decode.rs`, `registry/mod.rs` | Not model-bound — testable with `tempfile` (already a dev-dep) |
| Panic-recovery paths unverified | findings #1–3 | No test that a panicking pipeline still clears its registry entry — the invariant most likely to silently regress |
| No coverage tooling | — | Add `@vitest/coverage-v8` + `"test:coverage"`; `coverage/` is already gitignored |

Current shape: TS 32 test files / 150 source; Rust 20 of 40 files have `#[test]`s (~70 tests). Coverage is good where testing is easy (pure logic, stores) and absent around failure paths and I/O seams.

---

## P4 — Config, tooling, and hygiene nits

- **Aggregate check script:** add `"check": "biome check . && tsc --noEmit && vitest run"` (+ optional `rust:check`/`rust:test` with `--manifest-path`) so the full gate is one command for humans and CI alike.
- **`serde_yaml 0.9` is unmaintained** (archived; RUSTSEC-2024-0320). Low risk (only parses human-edited config.yaml) but swap to `serde_yaml_ng`/`serde_norway` before a `cargo audit` gate lands. Cheap bumps while there: `dirs 5→6`, `bzip2 0.4→0.6`.
- **`shadcn` CLI is in `dependencies`** — it's a codegen tool; move to devDependencies or use `bunx shadcn@latest`.
- **`vitest.config.ts` hand-duplicates vite config** (react plugin + `@` alias) — use `mergeConfig(viteConfig, …)` or fold the `test` block into `vite.config.ts`.
- **tsconfig:** `noUnusedParameters` and `noFallthroughCasesInSwitch` are near-free to enable; `noUncheckedIndexedAccess` is worthwhile but noisier.
- **biome disables all of a11y** — for an end-user desktop app, re-enable recommended and opt out of specific noisy rules instead. Related concrete instance: sidebar icon buttons (`components/layout/sidebar.tsx:79-93`) have `title` but no `aria-label`. Also: the formatter is disabled with nothing replacing it — nothing enforces formatting at all.
- **Config schema versioning:** no `schemaVersion` anywhere (config.yaml or the JSON stores); `.default().catch()` makes renames silently lossy. Even just documenting "only additive changes are safe" in CLAUDE.md would make it a decision instead of an accident.
- **config-sync subscribes to the whole settings store** (`config-sync.ts:161`, no selector) — harmless today, latent footgun when a UI-only field is added.
- **Sequential-await loops** in `people-store.loadAll` (:69-78) and `playground-store.loadRuns` (:54-62) — `Promise.all` when it ever shows up in profiling.
- **`.gitignore`:** add `.tanstack/` and `.claude/*.lock`.
- **`LICENSE` file missing** while Cargo.toml declares `license = "MIT"` — add one or drop the field.
- **Doc drift:** `spec/current_plan.md`'s working rules still say "the repository is still untracked" — it's tracked (314 files, 3 commits, clean tree). Also: 3 commits covering the whole codebase means zero bisectability so far; granular commits from here on.
- **tauri.conf.json cosmetics:** `"targets": "all"` → `["app", "dmg"]` for a mac-only app; add `category`/`copyright` bundle metadata.

---

## Clean bills of health (checked, no action needed)

- **IPC boundary:** every event variant audited; no raw audio crosses — level meters send derived `{rms, peak}` scalars only.
- **Privacy mode:** `engine-router.ts:73-76` excludes API engines unconditionally before any other eligibility check; no silent local→API fallback found anywhere.
- **Persistence:** all disk JSON is Zod-parsed with quarantine-and-backup on corruption; API adapters share a consistent `assertOk` error surface with no swallowed failures.
- **Async hygiene:** `use-voice-chat.ts`, `use-message-playback.ts`, `playback-queue.ts` all use generation/token counters against stale-resolution races and clean up on unmount.
- **Repo hygiene:** no junk tracked, largest tracked file 1 MB, repo 4.7 MB total; `fixtures/fetch.sh` correctly keeps model binaries out of git; capabilities file is well-scoped (it just needs #14 to be load-bearing).

## Suggested sequencing

1. **Now (small, high-payoff):** #1 DropGuard, #2 poisoning, #4 people-store serialize, #5 config-sync loop, #13 release profile, #14 CSP — all are hours, not days.
2. **Before closing M2/M3:** #12 CI, #6 speech.rs split (mechanical, and cheaper before more commands land), #3 spawn Results.
3. **When next touching the pipelines:** #7 utterance state machine + #8 registries together (they compound).
4. **Opportunistic:** everything in P3/P4 as the relevant files are touched.
