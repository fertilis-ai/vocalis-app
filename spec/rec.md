# M3 Implementation Review — Findings & Recommendations

_Review date: 2026-07-10 (supersedes the M2.7+ review of the same date; its findings are dispositioned in §2). Scope: all five M3 items (schemas/collection kit, live session pipeline, People enrollment, file import, session UI + exports) verified line-by-line against `spec.md` and the `M3.md` build records, plus cross-cutting IPC/privacy/storage audits and a full deferred-item inventory. Method: five parallel line-level review passes (Rust live pipeline; Rust import + enrollment; webview foundations; session/voices UI + exports; prior-findings & cross-cutting audit), high-severity findings independently re-verified._

**Suite status at review time:** `tsc` clean · 291 vitest pass (27 files) · `cargo check` clean · all Rust tests pass incl. 11 real-model fixture tests · lint exit 0 (8 pre-existing warnings).

---

## 1. Verdict

**The M3.md build records are honest.** Every claimed slice exists and matches its description; all recorded deferrals (WAV-not-FLAC, diarize-first tradeoff, API-imports-don't-match-People, re-record-wipes-without-confirm, Voices-is-People-only, "not exercised in the running app") are accurate. The cross-cutting spec properties hold on all new code:

- **IPC rule (§3.2):** no raw audio crosses the boundary in any M3 path; imports pass paths; enrollment passes `embedding.bin` refs, not arrays; events carry text/labels/derived stats only.
- **Privacy mode (§3.4):** the import dialog resolves through the router (API hard-filtered); the API import's diarization leg independently re-resolves; no path fires an API call under privacy mode.
- **No silent local↔API fallback (§3.4):** import paths branch strictly on the resolved engine's kind; failures set `status:"error"`, never reroute.
- **Storage (§4):** all new files land in the spec'd layout under `~/.vocalis/` (WAV divergence recorded); marker scan clean; all 69 commands registered.

But "code-complete" is doing heavy lifting: **two of item 5's headline claims don't survive line-level reading** — the session scrubber cannot work (fed a `~` path the asset protocol never expands, H1) and the retention toggle doesn't control retention (H2). Both would have been caught by the deferred `desktop:dev` pass the records themselves flag. Alongside them: a privacy-relevant delete-during-recording resurrection (H3), a data-destroying corrupt-tree overwrite (H4), and a cluster of medium bugs in cancel/panic/race handling. Details in §3.

**Prior-review follow-up: 11 of 14 findings fixed** (including both HIGH/MEDIUM deletion-guard bugs and both drifts); B10/B11/B12 remain open, B13 partially (§2).

---

## 2. Prior review (M2.7+) — disposition of B1–B13, D1–D2

| Finding | Status | Evidence |
|---|---|---|
| B1 registry leak (HIGH) | **FIXED** | `PipelineRegistry::finish()` (`pipeline/mod.rs:180`); every pipeline thread self-deregisters (asr `mod.rs:242`, kws `:349`, import `import.rs:70`, live `live_session.rs:71`). Stale doc comment on `stop()` (`mod.rs:134-136`) still claims the old behavior. |
| B2 dictation invisible to guard | **FIXED** | `DictationEntry` stores paths (`dictation.rs:22-25`); `model_in_use` includes them (`state.rs:108`). |
| B3 TTS chip truthfulness | **FIXED** | Chip + persisted engineId derive from the picked voice (`tts-tool.tsx:63-66,124,170-175`). Residual cosmetic: all local voices map to the single `local.kokoro-en` descriptor, so Piper shows as "Kokoro (local)". |
| B4 TTS cache collisions | **FIXED** | Hash keys `provider:voice:model:speed:text` + per-provider ext (`port.ts:185-203`). |
| B5 KWS restore | **FIXED** | `restoreRun` restores the keyword editor (`kws-tool.tsx:391-393`). |
| B6 stereo separation | **FIXED** | `separate_file` decodes via symphonia (`speech.rs:1100-1103`). |
| B7 eviction vs referenced wav | **FIXED** | mtime bump on cache hit (`speech.rs:372-377`); Waveform tolerates missing files. |
| B8 ElevenLabs 0 s duration | **FIXED** | Derived from last word end (`elevenlabs.ts:56-64`). |
| B9 speed param hygiene | **FIXED** | Legacy-model gate + `targetSupportsSpeed` slider gating. |
| B10 unbounded base64 reads | **OPEN — worse** | `storage.ts:32-39` / `fs.rs:40-45` unchanged, and the M3 API import now pushes the whole normalized session wav through it (`run-import.ts:129`) — long imports are exactly the large-file case. Fix with M3 close. |
| B11 download cleanup deletes install | **OPEN** | `download.rs:296-298` unconditional `remove_dir_all`; `model_delete` still ignores `DownloadRegistry`. Backlog. |
| B12 alphabetical .onnx pick | **OPEN** | `registry/mod.rs:36-49` unchanged; new comment at `:46` describes an int8 preference the code doesn't implement — misleading. Backlog. |
| B13 cosmetics | **PARTIAL** | React key fixed; still open: `kws_default_keywords` silent empty (`speech.rs:998`), stale `bpe.vocab` comment (`kws.rs:31-34`). |
| D1 bench wav-only | **FIXED** | `read_wav_16k` → `decode_to_16k_mono` (`speech.rs:555-556`); picker filter widened. |
| D2 API TTS cache gap | **FIXED** | `tts_cache_evict` command + pre-call cache-hit check (`port.ts:167-179`). |

---

## 3. Bugs to fix (ranked)

### HIGH — all four block or invalidate the M3 exit test

**H1 — Session scrubber and per-bubble playback are dead: Waveform gets a literal `~` path.** `session-view.tsx:204` passes `sessionAudioPath()` = `~/.vocalis/sessions/<id>/audio.wav` (`session-store.ts:27`) into `Waveform`, which calls `fetch(convertFileSrc(path))` / `new Audio(convertFileSrc(path))` (`waveform.tsx:34,88`). Rust fs commands tilde-expand; the asset protocol does not, and the literal `~` path never matches the `$HOME/.vocalis/**` scope. `pathExists` (Rust, expanded) returns true, so the UI confidently renders a broken waveform. Click-to-seek and `playRange` never work for any session. Bench tools only work because Rust hands them absolute paths. **Fix:** resolve via `getAppDataDir()` (the pattern `speaker-id-tool.tsx:76` already uses) or return the absolute path from Rust.

**H2 — The retention toggle doesn't control retention (spec §2.2B).** `use-session-recorder.ts:118` starts the pipeline without `audioRetained`, so `local.ts:148` defaults it to `true` — Rust always writes `audio.wav` regardless of the toggle. Imports write it unconditionally. And nothing discards audio on close when `audioRetained === false`; the flag only hides the scrubber and gates the manual "Discard now" action. A privacy toggle that silently keeps the audio is a real conformance failure. **Fix:** pass `session.audioRetained` into `startSessionPipeline`, and delete `audio.wav` at completion when retention is off.

**H3 — Deleting a session while it records resurrects the deleted directory with audio in it.** Sidebar delete → `removeSession` deletes `sessions/<id>/` → view unmounts → the recorder cleanup stops the pipeline *and* calls `updateSession(status:"complete")` (`use-session-recorder.ts:138-148`), which can re-write `session.json` from cache (fs `write_file` creates parent dirs). Independently, the Rust stop path always runs `create_dir_all` + writes `audio.wav` into the deleted dir (`live_session.rs:255-267`). Net: the user deleted a session; its audio persists on disk, invisible to the UI — against §4's retention guarantees. Imports have the same exposure. **Fix:** block or confirm deletion while status is recording/processing (stop and await the pipeline first), and make the unmount handler skip `updateSession` for removed sessions.

**H4 — A corrupt `chats/tree.json` is silently discarded, then permanently overwritten.** `collection-store.ts:84-94` sets `loaded: true`, catches any read/parse error, and leaves `tree: []`; the next mutation `commit()`s the empty tree to disk (`:66-69`) — destroying the folder structure and the only record of which sessions exist (their dirs become orphans). **Fix:** distinguish missing-file from parse/read error; on error, back up to `tree.json.bak` and refuse mutations (or surface a repair prompt). Same pattern for `transcript.json` (M10).

### MEDIUM

**M1 — Pipeline threads are not panic-safe; one panic wedges sessions until app restart.** `active.store(false)` and `registry.finish(id)` run only on normal return (`live_session.rs:66-73`, `import.rs:67-71`); a panic in sherpa FFI or a slice op unwinds past both — `session_active` stays true (every future start rejected) and the registry pins six model dirs. **Fix:** an RAII drop guard owning the flag + registry id.

**M2 — `PipelineRegistry::stop()` removes the entry exactly when the session's long tail begins.** Stop → ASR flush → audio write → minutes-long diarization refinement, all with the entry already gone (`mod.rs:137-145`), so `model_delete` can rip the diarization/speaker model out mid-refinement and the pass silently degrades. **Fix:** `stop()` only flips the flag; the entry is removed in `finish()`.

**M3 — Device loss mid-session is silent, and the disconnect path discards the meeting.** cpal's error callback only logs (`capture.rs:93`); the data callback keeps the `Sender` alive, so the pipeline's `Disconnected` branch never fires on device loss — the session just stops receiving audio with no `Error` event. And if `Disconnected` ever does fire, that path returns before audio write/refinement/`Stopped` (`live_session.rs:169-174`) — the whole meeting's retained audio and settled transcript are dropped. **Fix:** surface stream errors via a shared flag; route capture failure through the normal stop path (write audio, refine, emit Error + Stopped).

**M4 — Diarizer-failure fallback strips enrolled-Person names the live pass already assigned.** `online_labels` hardcodes `person_id: None` (`live_session.rs:323-334`, note the unused `_labeler`), so the `Refined` event downgrades real names to letters — the opposite of §7.3's stated fallback ("speaker-ID-only naming"). **Fix:** run `cluster_means_to_people` over the online clusters (already imported at `:345`).

**M5 — Refinement "overlap voting" is argmax over single diar spans, not overlap summed per speaker.** Transcript segments are continuous (up to ~30 s) and routinely straddle several diar spans; a segment with 0.8 s of speaker 1 across two spans and 0.5 s of speaker 2 in one span gets labeled speaker 2 (`live_session.rs:418-447`; tests only cover single-span cases). **Fix:** accumulate overlap into a per-speaker map, then argmax.

**M6 — Import cancel is broken in all three layers.** (a) Rust emits plain `Stopped` on cancel (`import.rs:144-147`), (b) `run-import.ts:175-178,217` treats `stopped` as success and persists the truncated session as `status:"complete"`, and (c) no UI can trigger cancel anyway — the dialog disables its close button while running (`import-dialog.tsx:96`) and never calls `ImportHandle.cancel`, so §2.2B's "import runs … are cancelable" is unmet and a hung import wedges a modal over the app. Also the stop flag is only checked between spans, so cancelling during whole-clip diarization or a long span's whisper chunks has minutes of latency (`import.rs:125,144,215`). **Fix:** distinguish cancelled from completed (flag or event payload), add a Cancel button, check `stop` between ASR chunks.

**M7 — API import with no word timestamps persists an empty transcript as "complete".** Turns are built solely from `result.words` (`run-import.ts:139`); every adapter defaults `words: []`, and `result.text` is ignored — a paid transcription is discarded. **Fix:** fall back to a single turn from `text` over 0..durationMs.

**M8 — Unserialized read-modify-write on all M3 JSON state.** `updateSession` (`session-store.ts:108-119`), `saveTranscript`/`persistTranscript` (fire-and-forget at `use-session-recorder.ts:70`, `run-import.ts:169`), and every collection-store mutation (`collection-store.ts`, all `get().tree` → await write → set, with fire-and-forget UI callers) can interleave: the refined-transcript write can race the final status write (session persistently stuck at "processing" — `refined` and `stopped` arrive back-to-back), overlapping tree ops silently drop each other's changes. **Fix:** serialize writes per file (promise chain per store/session id); await the refined persist before the status update.

**M9 — Path traversal: `personId`/`sessionId` joined into paths unvalidated.** `people.rs:22-24`, `speech.rs:195,251,297` — `..` or an absolute path escapes `~/.vocalis`. Defense-in-depth today (ids are webview-generated uuids), but the repo already has the exact guard: `validate_path_component` (`registry/download.rs:211`). **Fix:** one line per command.

**M10 — Corrupt `transcript.json` returns `[]` and is overwritten by the next edit** (`session-store.ts:74-86`) — silent transcript loss. Same quarantine treatment as H4.

**M11 — Import dialog "Try again" creates a duplicate error session per attempt** (`import-dialog.tsx:125` resets the form; `start()` re-runs `createLeaf`+`createSession`). Reuse the first attempt's session id.

**M12 — Double-start race in the recorder.** The guard checks `pipelineId.current` but it's only set after the await (`use-session-recorder.ts:104,118`); two same-tick starts → the loser's `finish("error")` clobbers the winner's id and marks the session "error" while it records on, unstoppable from the UI. Set a synchronous starting flag.

**M13 — `onDeleteLeaf` failures are swallowed** (`collection-store.ts:150`, `.catch(() => {})`): a failed session-dir delete leaves orphaned audio with the tree entry already gone, silently. Await and surface.

### LOW

- **L1** Embed failure mints a new speaker per turn — live speaker inflation A,B,C… for one voice; refinement corrects it (`live_session.rs:224-227`).
- **L2** Whole session buffered in RAM as f32 (~230 MB/hour) even with retention off; refinement is one synchronous pass with a single `Processing` event and no progress (`live_session.rs:131,200`).
- **L3** `has_sentence_punctuation` counts `.`/`,` inside numbers ("3.5", "1,000") and skips the punctuator on unpunctuated text (`import.rs:270`).
- **L4** `decode.rs` locks the sample spec from the first frame and treats `ResetRequired` as EOF — mid-stream spec changes truncate silently (`decode.rs:68,78-82`).
- **L5** Streamed vs settled speaker letters can swap when an early span transcribes empty (`import.rs:233` resettles over non-empty spans only).
- **L6** Wrong-dimension `embedding.bin` (after switching the embedding model) scores 0.0 against everything — enrollment silently stops matching (`speaker.rs:64` + `people.rs` accepts any dim). Record dim in profile.json or warn on mismatch.
- **L7** `stop()` rejection is unhandled — recorder stuck at "Refining…" with no retry (`use-session-recorder.ts:126-132`).
- **L8** Unknown engineId falls into the local import branch instead of throwing (`run-import.ts:210`).
- **L9** Rename pre-fill commits the *resolved* name on unchanged blur, permanently overriding the Person link's display (`transcript-list.tsx:131`); seed with `ref?.name ?? ""` or skip no-op commits.
- **L10** Session-audio write failure emits `Error` then continues to `Stopped` → recorder overwrites the "error" status with "complete" while `session.error` stays populated (`live_session.rs:257-264` + recorder `stopped` handler).
- **L11** During API/import streaming all bubbles share one color (`session.speakers` empty until refined; `speakerColor(Math.max(0,-1))`).
- **L12** SRT cues corrupted by edited text containing a blank line (`format.ts:78`; textarea allows it) — collapse blank lines in cues.
- **L13** Corrupt/missing `session.json` renders a permanent "Loading session…" (`session-view.tsx:109-115`); no actionable error (§4).
- **L14** People keyed by `profile.id` but read by dirname; a mismatch duplicates on update and strands the original on remove (`people-store.ts:65-79`).
- **L15** Person delete is one-click destructive, no confirm (`person-detail.tsx:81`); dangling `SpeakerRef.personId`s degrade gracefully.
- **L16** Tree leaf with missing `kind` skips cleanup on delete and renders as a stuck SessionView (`collection-store.ts:150`, `chat-content.tsx:24-33`).
- **L17** Folder-name dedupe checks leaf names only; `getSiblingFolderNames` exists unused (`chat-sidebar.tsx:90-93`).
- **L18** Stale doc comments: `PipelineRegistry::stop` (pre-`finish()` claim), `session.ts:7` says `audio.flac`, `registry/mod.rs:46` int8-preference comment, `kws.rs:31-34` `bpe.vocab`.

---

## 4. Undocumented spec gaps — record in M3.md or amend spec.md

1. **§7.7 / M3 plan "load via SpeechState, don't spawn private instances" — violated silently.** Live + import pipelines construct private `Punctuator`, `SpeakerEmbedder`, `Diarizer` (`live_session.rs:98-113,284`; `import.rs:100-120`) — a session can hold two copies of the embedding model (its own + the diarizer's + possibly the warm slot). Per-pipeline VAD/streaming-ASR sessions are defensible (stateful). [Either route the shareable engines through `SpeechState` or record the deviation + memory cost.]
2. **§3.5 "per-person tunable" match threshold** — global constant `SESSION_MATCH_THRESHOLD = 0.55` (`speech.rs:156`); no per-person field in the schema (the "no-migration" claim has this one hole). [Record as deferred or amend spec.]
3. **§2.2B cancelable imports** — see M6; not flagged in the build record (which mentions Rust cancel but not that no UI reaches it).
4. **§2.2B retention "discards it on close"** — see H2; the records only flag WAV-vs-FLAC.
5. **M3 item 3 plan "enroll from these segments"** (enroll a new Person from session audio) — not implemented, not recorded as deferred; only assign-to-existing-Person exists.
6. **§2.1 engine indicator** — session view shows `session.engineId` as plain header text; live sessions have `engineId: null`, so live capture has no chip/override surface at all.
7. **§3.6 "each colocated-tested"** — `people-store` and `chats-collection` have no test files; the aggregate "291 pass" hides this.
8. **§4 "actionable errors"** — every corrupt-state path is a `console.warn`; nothing reaches the user (H4/M10/L13 are the sharp edges).
9. **§3.2 "VAD — gate + endpointing"** — session VAD only emits `VadState`; ASR consumes all audio and self-endpoints. Same reading as M0/dictation, so likely an accepted project-wide interpretation — say so once in spec.md.
10. **§2.2B JSON export "confidence"** — plumbed end-to-end but no engine ever populates it; always absent in practice.

---

## 5. Deferred items — disposition

Effort: S < ½ day, M = 1–3 days, L > 3 days.

| # | Item | Current state | Recommendation | Effort | When |
|---|---|---|---|---|---|
| 1 | **FLAC audio** (spec §4; recorded WAV fallback in M3 items 2/3/4) | WAV everywhere; no FLAC encoder in tree | WAV is fine for v1 (16 kHz mono ≈ 115 MB/h; FLAC ≈ halves it). **Amend spec §4 to "WAV (FLAC planned)"** or add `flacenc` encode-on-stop when disk pressure appears. Don't block M3. | M | backlog |
| 2 | **Deepgram streaming WS** (from M2) | Still `implemented:false`; punt recorded in current_plan | Unchanged: post-M3. Note it gates the FR-streaming routing default before M4's chat surface claims FR support. | M | pre/with M4 |
| 3 | **KWS plain-text keywords** (M2) | Unchanged; `bpe.model` ships so a sentencepiece port is feasible | Backlog, with the B13 stale-comment fix now | M | backlog |
| 4 | **B10 base64 size guard** | Open, and the M3 API import made it bite harder (§2) | Size cap (~25 MB, OpenAI's limit) + chunked conversion; consider a Rust-side multipart upload later | S | **M3 close** |
| 5 | **B11 / B12 / B13 leftovers** | Open (§2) | Backlog as previously ranked | S each | backlog |
| 6 | **campplus French discrimination** (open gate, trigger point passed) | Enrollment built on the unvalidated model | As previously recommended: fold into the M3 exit test — enroll two French speakers; if weak, add `eres2netv2` catalog entry and re-run fixtures | S–M | **M3 exit test** |
| 7 | **M2 live passes** (items 1–8 pages; item 9 keyed APIs; piper-fr download-test) | Still pending | Run together with the M3 exit test after §6 step 1 lands — one `desktop:dev` campaign, not two | — | M2/M3 close |
| 8 | **M3 live exit test** | Pending (the record's own gate) | Blocked on H1/H2/H3 at minimum — the test would fail on the scrubber alone. Run after §6 step 1. | — | M3 close |
| 9 | **Whisper word timestamps** (M2) | Data problem unchanged; import word-timing would benefit | Unchanged: source a timestamped export if word-timing matters for exports; else backlog | M | backlog |
| 10 | **ZipVoice spike listen** (M5 gate) | Still pending | Do it before any M5 planning; 15 minutes | S | before M5 |
| 11 | **Dead M0-era commands** | `read_config`/`save_config`/`get_home_dir` + `dictation_force_stop` wrapper registered but unreachable | Delete or add a keep-comment | S | any cleanup pass |
| 12 | **Enrollment clips WAV** (item 3 deferral) | Accurate; folds into #1 | Same disposition as #1 | — | — |

---

## 6. Recommended path to closing M3

1. **Fix before the live exit test** (the test is otherwise guaranteed to fail or lie):
   - **H1 scrubber path + H2 retention** — both small, both in item 5's headline claims.
   - **H3 delete-during-recording + H4 tree quarantine + M10 transcript quarantine** — the data-safety cluster.
   - **M1 panic guard + M2 stop/finish split** — one pass over `pipeline/mod.rs` + the two thread spawns.
   - **M3 capture-error surfacing** — a meeting recorder that can silently record nothing fails its one job.
   - **M4 fallback names + M5 overlap voting** — small, pure-core, already unit-test-shaped.
   - **M6 cancel semantics + M7 words fallback + M11 retry duplicate** — the import correctness cluster.
   - **M8 write serialization + M12 start race** — one shared "serialize per-id writes" helper covers both stores.
   - **M9 + B10** — the two one-liner-ish hardening items (`validate_path_component`, size cap).
2. **Documentation sweep** — record §4's gaps in M3.md (SpeechState deviation, per-person threshold, enroll-from-segments, engine chip on sessions, missing store tests) or amend spec.md where the cut is permanent (VAD-as-indicator reading, confidence field, WAV convention per §5 item 1). Fix the four stale comments (L18).
3. **Run the combined live campaign**: M2 items 1–8 pages, item 9 keyed APIs (+ piper-fr download-test), M3.4 import pass (real mp3/m4a/flac), M3 exit test (live multi-speaker session incl. two French speakers for gate #6, scrub, edit, rename/merge/assign, three exports, retention toggle + discard). Record results in M2.md/M3.md, close both milestones.
4. **Backlog** (post-M3): FLAC, Deepgram streaming (pre-M4), KWS tokenization, B11/B12/B13 leftovers, whisper timestamps, LOW items L1–L17 not swept up above, dead-command cleanup.

---

## Appendix — per-item conformance summary

| M3 item | Spec conformance | Build-record accuracy | Blocking issues |
|---|---|---|---|
| 1 — schemas / collection kit / chat shell | Met; §3.6 test rule missed for 2 stores | Truthful | **H4**, M8, M13 |
| 2 — live session pipeline | Met with recorded deferrals; §7.7 SpeechState deviation unrecorded | Truthful (incl. the enrolled-wiring handoff to item 3) | M1–M5 |
| 3 — People enrollment | Met; per-person threshold + enroll-from-segments unrecorded | Truthful | M9, L6, L14 |
| 4 — file import | Met except cancelability (§2.2B) | Truthful | M6, M7, B10 |
| 5 — session UI + exports | **Two headline claims don't hold** (scrubber H1, retention H2); rest met | Honest-but-unverified — the "not exercised" caveat carried the risk | **H1, H2, H3**, M8, M11, M12 |
