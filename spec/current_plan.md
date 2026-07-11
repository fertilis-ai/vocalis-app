# Current plan

> **Keep this file current-only.** It holds the status snapshot, the active work item, and open gates — nothing else. When a work item completes, move its detailed record into the matching milestone file (`M0.md` … `M5.md`) and trim this document. The product/technical spec is `spec.md` (same folder).

_Last updated: 2026-07-10._

## Status

| Milestone | Plan | State |
|---|---|---|
| M0 — Walking skeleton | [M0.md](M0.md) | ✅ complete |
| M1 — Dictation | [M1.md](M1.md) | ✅ complete (live walkthrough passed 2026-07-10) |
| M2 — Playground complete | [M2.md](M2.md) | 🔶 in progress — items 1–10 code-complete (item 9 batch adapters only); Deepgram streaming + live verification remain |
| M3 — Sessions | [M3.md](M3.md) | 🔶 code-complete — all 5 items done (schemas/collection kit; live session pipeline; People enrollment; file import; session UI + exports). Human live exit test pending |
| M4 — LLM voice chat | [M4.md](M4.md) | 🔶 in progress — items 1–2 code-complete (pi-ai LLM layer, chat persistence/text-chat/read-aloud); items 3–4 (Rust voice capture, barge-in) not started |
| M5 — Voice cloning | [M5.md](M5.md) | ⬜ not started |

## Now

**M2 close-out** — all ten items are code-complete; item 10 is live-verified (2026-07-10). What remains before closing M2:
1. The `bun run desktop:dev` live pass over items 1–8's playground pages (KWS/separation/langid/etc. have never been exercised in the running app; item 10's Models flows now have).
2. Item 9's keyed API live pass (real keys through the ASR/TTS/diarization benches).
3. Item 9's deferred Deepgram streaming (WebSocket) — or an explicit decision to punt it to M3.

Item 10 build record + deferrals (URL custom-source, clone-tts custom-add) are in [M2.md](M2.md) § item 10.

## Open gates and follow-ups

- **API adapters need a keyed live pass (item 9):** the OpenAI/Groq/ElevenLabs/Deepgram batch adapters are unit-tested with mocked fetch only. Before closing M2, add real keys and exercise each through the ASR file bench (local-vs-API compare), TTS voice picker (cloud voices + A/B), and Deepgram diarization — confirming `@tauri-apps/plugin-http` handles multipart `FormData` + raw-byte bodies, that errors surface cleanly, and that mp3 TTS output decodes in the Waveform. Deepgram streaming (WebSocket) is deferred.
- **Live verification of M2 items 1–8:** none of the new playground pages, settings sections, or bench components have been exercised in the running app (`bun run desktop:dev`). Item 7's engine layer *is* verified against real models via `cargo test` fixture tests, but the KWS/separation/langid pages themselves are unexercised. For item 8, also **download-test `piper-fr-siwis`** and exercise the TTS voice picker, A/B compare, save-to-library, and cache eviction (Kokoro synth is verified via the `--ignored` test; the VITS/Piper path is not installed locally). Required before closing M2.
- **KWS custom keywords (item 7 follow-up):** the tool only accepts pre-tokenized BPE keywords (seeded from the model's bundled list). Plain-text→token conversion needs a sentencepiece dependency or an in-app `text2token` port — deferred; see the item 7 caveat in [M2.md](M2.md).
- **M3.4 import live pass:** the file-import pipeline (decoders + local run + API orchestration) is code-complete but unexercised in the running app. Needs a `desktop:dev` pass importing a real mp3/m4a/flac with local ASR/diarization/speaker/punctuation models installed (confirm `symphonia` decode + `audio.wav` + a settled transcript in the session store); the API path additionally needs real keys (folds into the M2 item 9 keyed pass). Rendering the result is item 5.
- **M3 live exit test (closes M3):** `desktop:dev` pass with real models — record a live multi-speaker session (partials → provisional turns → stop-time refine → names), scrub + per-bubble play, edit a segment, rename/merge/assign speakers, export markdown/SRT/JSON, toggle retention + discard. Also folds in the M3.4 import live pass and the item 1–3 smoke passes (tree round-trip; enroll a person). See M3.md item 5 caveats.
- **M4 items 1–2 live verification:** the pi-ai LLM layer, chat persistence/text-chat UI (composer, streamed rendering, stop button, per-conversation model picker), and read-aloud (play button per assistant message, engine-router-resolved TTS, single-active playback, auto-read toggle) are code-complete and pass `check-types`/`lint`/`test:run`/`cargo check`, but have never been exercised in `bun run desktop:dev` — needs a live pass with a real LLM key/local model and a downloaded TTS voice before M4 items 1–2 can be called done. Items 3–4 (Rust `chat_capture` pipeline, sentence chunker, playback queue, barge-in/echo mitigation, voice-mode per-conversation pickers) are deliberately deferred to a later session.
- **ZipVoice spike listen (M5 gate):** listen to `~/.vocalis/recordings/zipvoice-spike/` and record the quality verdict.
- **Embedding model check (before M3 item 3):** the shipped `campplus-en-voxceleb` may discriminate French speakers poorly — see the caveat in [M2.md](M2.md) item 6; swap the default model before building People enrollment if so.

## Working rules

- Follow the milestone order; do not start a later milestone's runtime integration before its storage/schema/routing foundations exist.
- Maintain the IPC boundary: realtime raw audio stays in Rust; only serialized events cross to the webview. Dictation/chat capture remains ephemeral unless the feature explicitly retains session audio.
- Every change: `cargo check`, `cargo test`, `bun run check-types`, `bun run test:run`, `bun run lint`. Run the relevant `--ignored` real-model integration test whenever a model wrapper changes.
- Before closing each milestone, run the stated human exit test and record concrete results + remaining defects in the milestone file; update the status table here.
- No commits without Martin's approval; the repository is still untracked.
