# Vocalis — Product & Technical Spec

> A realtime, multi-use speech app: STT, TTS, and voice cloning as a daily driver, built on sherpa-onnx with hybrid local/API inference, in a VSCode-style desktop shell modeled on Sapio. Derived from `inspiration.md` (Sapio knowledge-graph analysis, repo root), a source-level exploration of `~/dev/fertilis/sapio-app`, and a 23-decision design interview (2026-07-09). All decisions user-confirmed; the full decision record is in Appendix A. `spike-zipvoice.md` (repo root) records the ZipVoice spike verdict.

---

## 1. What It Is

**Vocalis** is a local-first personal voice tool shipped as a native macOS app (Tauri v2 + Rust + React 19). It is three things at once:

1. **A daily driver** — system-wide push-to-talk dictation into any app, live meeting transcription with speaker names, and hands-free voice conversations with an LLM that answers in a voice you chose — including a clone of your own.
2. **A speech lab** — a Playground exposing all ten sherpa-onnx capabilities (speech recognition, speech synthesis, voice activity detection, speaker identification, speaker verification, speaker diarization, punctuation, keyword spotting, source separation, spoken language identification) with full parameter surfaces and engine comparison.
3. **A hybrid inference host** — every speech task can run fully on-device (sherpa-onnx, in-process) or via cloud APIs (OpenAI, ElevenLabs, Groq, Deepgram), chosen per task with defaults and inline overrides, with a global privacy mode that hard-disables all network inference.

### Design principles

- **Local-first, privacy by default** — everything is files under `~/.vocalis/`, API keys live in the macOS keychain, mic audio is ephemeral unless you opt to keep it, and one switch makes the app provably offline.
- **Hybrid by choice, never by magic** — the app never silently routes audio to a cloud API; the active engine is always visible and overridable in place.
- **One inference stack** — sherpa-onnx serves all ten local capabilities including voice cloning (ZipVoice); no Python sidecars, no second runtime.
- **VAD-gated batch, not streaming partials, is the norm** — chat, live sessions, and dictation buffer each VAD-bounded utterance and run one batch decode on the falling edge, emitting a single `Final` (measured whisper-small-int8 RTF ~0.12 at 2 threads — a typical utterance decodes in well under a second); turn-taking stays VAD-driven, not decode-driven. Streaming ASR (live partial transcripts) survives as a Playground capability demo, not the production path.
- **Consumer-grade UX in a power-user shell** — Sapio's proven VSCode-style layout: icon bar, per-section sidebar, main view.

---

## 2. Feature Spec

### 2.1 UI Shell

```
┌──────┬─────────────┬──────────────────────────────┐
│ Icon │ Section     │  Main view (route outlet)    │
│ Bar  │ Sidebar     │                              │
│      │ (resizable, │  chat / playground / voices  │
│ 5+2  │ width saved │  / models / settings         │
│ items│ per section)│  (+ debug pane toggle)       │
└──────┴─────────────┴──────────────────────────────┘
```

- Icon bar sections: **Chat, Playground, Voices, Models, Settings**, plus **Debug** as a bottom-pinned pane toggle. Menubar (tray) icon exists independently of the main window for dictation.
- Layout, resizable panes, per-section sidebar widths, and theming (next-themes dark/light + OKLCH hue presets) are copied from Sapio (§7 reuse map).
- A persistent **engine indicator** appears wherever speech runs: a small chip showing the active engine (e.g. `⚡ local · zipformer-en` or `☁ deepgram`), clickable to override for that context. Privacy mode replaces all chips with a lock badge and disables API options.

### 2.2 Chat — two conversation modes

One section, one sidebar tree (folders, pinning, rename — Sapio's shared sidebar kit), two conversation types distinguished at creation and by icon:

**A. LLM voice chat**
- Full loop: mic → VAD → buffer the utterance while VAD says "speaking" → on the falling edge, one batch local STT decode over the whole utterance ("Transcribing…" shown for the decode window) → LLM streams via `@earendil-works/pi-ai` (Anthropic, OpenAI, Google, OpenRouter, Ollama/LM Studio) → reply is TTS-synthesized sentence-by-sentence and played as it streams.
- **Turn-taking: hands-free, mic paused during playback.** Conversation mode listens continuously; VAD silence threshold (configurable, default ~800 ms) ends your turn. The mic is paused for the whole span of the assistant's TTS reply and resumes right after — no barge-in; you can only start a new turn once the reply finishes. Push-to-talk (hold hotkey) available as an alternative input mode per conversation, with the same pause. Echo mitigation v1: pause capture during playback + "use headphones for conversation mode" onboarding hint; AEC is a v2 item if needed.
- Text input always works; every assistant message has a play button (reads in the conversation's voice). Voice picker per conversation (from the TTS voice library, including clones); model picker per conversation (pi-ai model discovery, Sapio's picker UI).
- Optional transcript-only mode (mute TTS) and auto-title from first exchange.

**B. Transcription sessions**
- **Live mode**: VAD → batch ASR per utterance → punctuation → online diarization. Rendered as chat-style bubbles per speaker with timestamps. Speakers whose embeddings match enrolled People (§2.4) get real names and colors; unknown speakers get `Speaker 1..N` and can be assigned/enrolled afterwards from the session view.
- **File import**: drop an audio file (wav/mp3/m4a/flac) into a session; same pipeline runs offline with engine choice — local Whisper for quality, Groq for speed, Deepgram for API diarization. Import runs show progress and are cancelable.
- Session view: transcript with inline audio scrubber (waveform, click-to-seek, per-bubble playback), speaker rename/merge, edit text.
- **Export**: markdown (speaker-labeled), SRT, JSON (full timing + speaker + confidence).
- Session audio is retained (FLAC) by default; a per-session toggle discards it on close.

### 2.3 Playground — twelve tool pages on one audio bench

Sidebar lists the twelve capabilities; each page is thin, assembled from the shared **audio bench** kit:

- **Input source panel**: mic (with live waveform + level meter), file drop, or pick from the recording library (saved session/playground audio).
- **Engine picker**: local models installed for this task + applicable API engines; disabled entries show why (not downloaded / privacy mode / no key).
- **Parameter panel**: per-engine parameter surface (schema-driven from the engine descriptor).
- **Run/results panel**: task-appropriate output rendering + export; recent runs per tool persisted (params + result + audio ref).

Per-capability pages:

| Page | Input | Output / UX |
|---|---|---|
| Speech recognition | file | batch transcript, word timestamps, RTF + latency stats, side-by-side engine compare (run same audio through 2 engines) |
| Streaming Recognition | mic (streaming) | live partial/final transcript, word timestamps — the production chat/live/dictation pipelines no longer use this decode mode; it's kept here as a capability demo |
| Speech synthesis | text | voice picker (full library incl. clones), speed/pitch params, waveform of result, save-to-library, A/B two voices |
| Voice cloning | text + reference clip (a Person's saved clone ref, or ad-hoc mic/file/library clip with its transcript) | zero-shot ZipVoice synthesis, speed / sampling-steps params, engine load + synth timing, warm/unload engine controls, save-to-library (M5; en/zh only, §7.1) |
| Voice activity detection | mic or file | live speech/silence timeline strip, threshold/min-duration params, segment list with per-segment playback |
| Speaker identification | mic or file | ranked matches against enrolled People with cosine scores |
| Speaker verification | pick a Person + mic/file | accept/reject vs threshold, score dial, threshold slider with live re-evaluation |
| Speaker diarization | file | colored speaker timeline + labeled transcript (chains ASR optionally), num-speakers / clustering-threshold params |
| Punctuation | text or ASR output | before/after diff view |
| Keyword spotting | keyword list + mic/file | live detection log with timestamps + score, custom keyword lists (saved), boosting score param |
| Source separation | file | stems (vocals/accompaniment) with per-stem playback, solo/mute, export per stem |
| Spoken language ID | mic or file | detected language + confidence table, top-5 |

### 2.4 Voices — People and TTS voice library

Two tabs in one section.

**People** (speaker profiles):
- Profile = name, color, avatar initial + **speaker embedding** + optional **clone reference audio**.
- **Enrollment flow** (for recognition): guided ~30 s recording (read prompts + free speech) → embedding extracted locally (averaged over segments) → used by speaker ID, verification, and diarization naming everywhere in the app.
- **Clone flow** (optional per person): guided clean recording (~10–60 s, level/noise check with re-record prompts) → creates clone voices: **local (ZipVoice)** — reference audio + transcript stored, synthesis fully on-device — and/or **ElevenLabs instant clone** (uploads reference audio — explicit consent dialog states this leaves the device; blocked in privacy mode).
- **Consent rule**: cloning a voice other than your own requires ticking an "I have this person's consent" confirmation; profiles record which flows they've completed.

**TTS voice library** (everything speakable; feeds every voice picker in the app):
- Stock local voices: Kokoro (EN + FR voices), Piper VITS (en_US, fr_FR) — installed via Models section.
- Provider voices: OpenAI voices, ElevenLabs premade voices (listed live when key present).
- Clone voices: derived from People (badge shows local/API and the source person).
- Per-voice: preview button (fixed sample sentence per UI language), favorite star, default-speed param, language tags. Favorites float to the top of pickers.

### 2.5 Models — curated catalog + downloads

- Ships with a **versioned JSON catalog** (`catalog.json`, updatable independently of app releases) of tested sherpa-onnx models: `{id, task, name, languages, sizeBytes, quantization, license, url, sha256, recommended, params}`.
- Catalog view grouped by task; each entry shows installed/available state, size, languages, license. **Download manager**: progress, resume, sha256 verification, unpack (tar.bz2), cancel; queue with one concurrent download.
- **Per-task active-model slots** — "which model serves streaming ASR / batch ASR / VAD / …" — these are the local halves of the engine defaults (§3.4). Recommended models are pre-selected; first use of a feature with a missing model deep-links here.
- **Add custom model**: point at a local folder or URL + choose task type + model family; validated by attempting a load; kept outside the catalog with a "custom" badge.
- Disk usage meter per task and total; delete with confirmation (blocked while a pipeline uses the model).

### 2.6 System-wide dictation (menubar + global hotkey)

- **Global push-to-talk**: hold the hotkey (default `⌥Space`, configurable; toggle mode also available) → compact floating HUD appears (waveform, transcript-so-far, engine chip, polish toggle) → release → finalize → text is injected into the frontmost app via clipboard-swap + synthesized ⌘V (previous clipboard restored). Works with the main window closed; the app runs as a menubar item (tray) with quick toggles (privacy mode, polish, open window).
- **Pipeline**: mic → VAD → batch local ASR per utterance (one decode per VAD-bounded utterance, on the falling edge; local, always — dictation never uses APIs for audio) → CT-transformer punctuation → optional **LLM polish** pass: filler removal, self-correction application ("3pm no wait 4pm" → "4pm"), light formatting, via a fast model (default: cheapest configured provider model or local Ollama). Polish toggle lives in the HUD, remembers its state, is forced off in privacy mode unless the polish model is local; latency budget ≤1 s per utterance decode.
- Raw-vs-polished: HUD shows raw text accumulating per finished utterance (each VAD falling edge appends its decode, with a brief "transcribing…" status while a decode is in flight); polish (when on) replaces at finalize. `Esc` cancels without pasting.
- **Permissions**: microphone (Info.plist) + accessibility (for ⌘V injection) requested with a first-run explainer; dictation degrades to "copied to clipboard" + notification if accessibility is denied.
- Dictation audio is never persisted; transcript history (last 50 dictations, text only) viewable in Settings → Dictation, opt-out.

### 2.7 Settings

Sectioned view (Sapio pattern): **Appearance** (theme, hue presets), **API Keys** (→ keychain; per-provider status), **Engines & Routing** (the per-task default matrix, §3.4, incl. privacy mode), **Models** (link to Models section + storage meter + cache cap), **Dictation** (hotkey, mode, polish model, history), **Voice Chat** (VAD thresholds, barge-in [disabled — superseded by playback-pause], default voice/model), **LLM Models** (pi-ai provider model picker), **Audio** (input/output device selection, sample-rate display), **Advanced/Debug** (logging toggles).

### 2.8 Debug pane

- **Log viewer** over `~/.vocalis/logs/` (Rust-appended, daily files; component filters, tail follow) — Sapio's debug view pattern.
- **Pipeline inspector** (new, audio-specific): live view of active pipelines and their stages, loaded models + memory, current audio device + buffer size, rolling latency stats (capture→partial, endpoint→final, TTS time-to-first-audio), VAD state timeline, recent event stream. Reads the same `PipelineEvent` channel the UI uses (§3.2) plus a `pipeline_stats` command.

---

## 3. Architecture

### 3.1 Repo layout (single app, no monorepo)

```
vocalis/
  src/                      # React 19 + TS strict
    components/
      layout/               # AppLayout, IconBar, ResizablePane   (from Sapio)
      shared/               # SidebarTreeNode, ItemContextMenu    (from Sapio)
      bench/                # audio bench kit: InputSource, Waveform,
                            #   EnginePicker, ParamPanel, ResultsPanel
      chat/  playground/  voices/  models/  settings/  debug/
      dictation/            # HUD window components
    routes/                 # TanStack Router file-based: chat, playground,
                            #   voices, models, settings (+ __root bootstrap)
    stores/                 # Zustand: layout, settings, chat, session,
                            #   playground, voices, models, debug
                            #   + collection-store.ts (generic tree factory)
    lib/
      engines/              # EnginePort TS interface + API adapters:
                            #   openai.ts elevenlabs.ts groq.ts deepgram.ts
                            #   local.ts (invoke/channel bridge to Rust)
      routing/              # engine-router.ts (task → engine resolution)
      llm/                  # pi-ai wrapper: streaming, model discovery,
                            #   message conversion (from Sapio, trimmed)
      audio/                # webview playback queue, waveform rendering
      schemas/              # Zod: config, catalog, profiles, sessions, runs
      storage.ts keychain.ts config-sync.ts logger.ts tree-utils.ts
  src-tauri/
    src/
      commands/             # grouped modules (fs, config, keychain, models,
                            #   pipeline, dictation, logging) — no god file
      audio/                # cpal capture, resample→16k mono f32, ring buffer,
                            #   device watcher
      engines/              # one module per task wrapping sherpa-onnx (§3.3)
      pipeline/             # session actors: dictation, live_session,
                            #   chat_capture, playground_run
      registry/             # catalog load, download/resume/sha256, model store
      state.rs              # managed state: EngineManager, active pipelines
  catalog/catalog.json      # curated model catalog (versioned)
  fixtures/                 # tiny models + WAVs for Rust integration tests
```

Bun + Vite 6 + Tailwind v4 + shadcn/ui + Biome (lint only) + Vitest. Rust: `sherpa-onnx` official crate (k2-fsa) preferred; fall back to `sherpa-rs` or the C API per engine if a feature (e.g. ZipVoice) isn't exposed yet. Inherit Sapio's `nodeStubsPlugin` Vite plugin (webview Node-builtin stubs — inspiration.md §8).

### 3.2 One realtime turn (the layer cake)

```
mic ──cpal (48k)──▶ resample 16k mono ──▶ ring buffer
  └▶ PipelineActor (tokio task per active pipeline)
       ├─ VAD (silero) — gate + endpointing        ~30ms frames
       ├─ buffer raw audio while VAD says "speaking"
       ├─ on the falling edge: one batch ASR decode (Whisper, offline)
       │    over the whole buffered utterance → punctuation → final segment
       ├─ (live session) embedding + online clustering → speaker label
       └─ emits PipelineEvent over a Tauri Channel:
            Processing{message} | Final{segment} | VadState{...} |
            SpeakerTurn{...} | Metrics{...} | Error{...}
webview: stores subscribe to the channel → UI shows "Transcribing…" during
  the decode, then the full utterance text appears at once on Final
  └─ (voice chat) final turn → pi-ai LLM stream → sentence chunker
       → tts_synthesize per sentence (local or API) → playback queue
       → playback active/inactive reported to Rust → mic capture paused
         for the span of playback, resumes on drain (no barge-in)
```

`Partial{text}` events (incremental streaming-ASR partials) are emitted only
by the Streaming Recognition Playground page (§2.3); chat, live sessions, and
dictation never see them — each VAD-bounded utterance produces exactly one
`Final`.

Rules: raw audio never crosses the IPC boundary during realtime capture (it stays in Rust; the webview receives events only). File-based runs pass paths, not bytes. TTS audio returns as file path (cache) and is played by the webview audio queue; the playback state is reported to Rust (command) so capture can pause against echo.

### 3.3 Rust engine layer

- `trait` per task family, e.g. `StreamingAsr { start_session() -> AsrSession; }`, `OfflineAsr`, `Tts { synth(text, voice, params) -> WavPath }`, `Vad`, `SpeakerEmbedder`, `Diarizer`, `Punctuator`, `KeywordSpotter`, `SourceSeparator`, `LangId` — all implemented by sherpa-onnx wrappers; the trait exists so a future non-sherpa local engine (e.g. F5-TTS ONNX fallback) slots in.
- **EngineManager** (managed state): loads/unloads models on demand with an LRU keep-warm set (dictation ASR + VAD stay resident; heavyweight models like ZipVoice load lazily with a "warming up" event). One model instance shared across pipelines where the API is thread-safe; otherwise per-pipeline instances.
- **PipelineActors** own their audio tap + engine handles; commands: `pipeline_start(kind, config) -> channel`, `pipeline_stop(id)`, `pipeline_stats()`.
- Model registry: resolves `modelId → loaded config` from `~/.vocalis/models/`, validates layout per model family at download time.

### 3.4 Hybrid engine routing

- **Engine descriptor** (pure data, TS + mirrored in Rust for local ones): `{id, task, kind: 'local'|'api', provider?, modelRef?, label, langs, capabilities, paramSchema}`.
- **Task defaults** in `config.yaml` (`routing:` map), editable as a matrix in Settings:

| Task | v1 default | Alternatives |
|---|---|---|
| Streaming ASR (Playground demo only) | local zipformer-en (FR: Deepgram until local FR streaming lands) | Deepgram |
| Batch ASR (dictation/live/chat, imports) | local whisper-small-int8 (measured RTF ~0.12 at 2 threads — sub-second per-utterance decode) | Groq whisper-large-v3, OpenAI, ElevenLabs Scribe |
| TTS (chat/read-aloud) | local kokoro | ElevenLabs, OpenAI |
| Cloned-voice TTS | local zipvoice | ElevenLabs clone |
| Diarization | local (pyannote seg + embeddings) | Deepgram (on API imports) |
| VAD / speaker ID & verify / punctuation / KWS / separation / lang-ID | local only in v1 | — |

- `engine-router.ts` resolves `(task, context override?, privacyMode)` → engine; every runtime surface renders the chip + override menu from the same resolver. **Privacy mode** (settings + tray toggle) filters `kind: 'api'` out of resolution entirely — API failure can never silently fall back the other way, and local→API never happens without the chip changing.
- API adapters implement the same TS `EnginePort` shape per task (`transcribe`, `transcribeStream` (Deepgram WS), `synthesize`, `diarize`), so bench pages and pipelines don't branch on kind.

### 3.5 Voice/People data model

```ts
Person {
  id, name, color,
  enrollment: { samples: AudioRef[], embedding: Float32Array(ref), enrolledAt },
  cloneRef?: { samples: AudioRef[], transcript: string, consentConfirmed: true },
  clones: { zipvoice?: { refAudio, refText }, elevenlabs?: { voiceId } }
}
TtsVoice {
  id, label, engineId, kind: 'stock'|'provider'|'clone',
  personId?, langs: string[], params: { speed?: number, ... }, favorite: boolean
}
```
Speaker verification = cosine(embedding, probe) ≥ threshold (default 0.55, per-person tunable). Diarization naming = nearest enrolled embedding above match threshold, else anonymous label.

### 3.6 State (webview)

Zustand stores, each colocated-tested: `layout` (Sapio), `settings` (config-sync + keychain write-through, Sapio pattern), `chat` (conversations of both modes — streaming logic lives in `lib/llm/`, NOT in the store; keep it under ~400 lines), `session` (live session runtime state), `playground` (per-tool recent runs + params), `voices`, `models` (catalog + downloads + slots), `debug`. Sidebar-organized collections (chat tree, playground presets, voices) share **one generic `collection-store.ts` factory** (tree + CRUD + pinning + disk sync) — fixing Sapio's storage triplication (inspiration.md §7.3).

---

## 4. Storage

```
~/.vocalis/
  config.yaml               # settings incl. routing matrix (debounced write +
                            #   2s poll two-way sync; Sapio config-sync pattern)
  catalog.json              # cached/updated model catalog
  models/<task>/<modelId>/  # downloaded model files (+ manifest.json)
  people/<id>/profile.json  #   + enrollment/*.flac  clone-ref/*.flac  embedding.bin
  voices/tts-voices.json    # library metadata (stock refs, favorites, params)
  chats/<id>.json           # both conversation modes; tree in chats/tree.json
  sessions/<id>/session.json + audio.flac + transcript.json
  playground/<tool>/runs/<id>.json (+ result audio where applicable)
  recordings/               # user-saved library audio
  cache/tts/                # synthesized audio, LRU ≤ 2 GB (configurable)
  logs/vocalis-YYYY-MM-DD.log
  exports/
```

Conventions: **JSON for all machine state** (one schema per file type, all Zod-validated at load with actionable errors); YAML only for `config.yaml` (human-edited); audio as **16 kHz mono FLAC** (originals of imports kept as-is). No mixed read/write formats (inspiration.md §7.4). API keys: macOS keychain only, service `Vocalis` (`keyring` crate). Retention: sessions/people/recordings persist; dictation & chat mic audio ephemeral (in-memory) by default; TTS cache LRU; storage meter reads real disk usage per subdir.

---

## 5. Model Catalog v1 (initial entries)

| Task | Model (catalog id) | Notes |
|---|---|---|
| Streaming ASR (EN) | `zipformer-streaming-en` (sherpa-onnx streaming Zipformer transducer, int8) | Streaming Recognition Playground demo only |
| Batch ASR (multi, EN/FR) | `whisper-small-int8`; optional `whisper-medium-int8` | dictation/live/chat/imports default; keep-warm; FR local batch quality |
| Batch ASR (fast, multi) | `parakeet-tdt-0.6b-v3-int8` (NeMo transducer, 25 languages incl. EN/FR) or `moonshine-base` | fast imports |
| VAD | `silero-vad-v5` | resident; all pipelines |
| Speaker embedding | 3D-Speaker `eres2netv2` (or WeSpeaker CAM++ VoxCeleb) | ID/verify/diarization; EN/FR robust (trained multilingual/VoxCeleb) |
| Diarization segmentation | `pyannote-segmentation-3.0` (ONNX) | offline diarization pipeline |
| Punctuation | `ct-transformer-punct-zh-en` | **EN only — no local FR punctuation model exists**; FR relies on Whisper's inline punctuation (batch) or LLM polish (dictation). Documented gap. |
| KWS | `kws-zipformer-gigaspeech` (EN) | playground |
| Source separation | `spleeter-2stems` / UVR model (sherpa-onnx supported) | vocals/accompaniment |
| Spoken language ID | `whisper-tiny-langid` (multilingual Whisper used for LID) | auto-routing hook |
| TTS EN | `kokoro-en` (multi-voice), `piper-en_US-lessac` | fast local voices |
| TTS FR | `kokoro-v1-fr` voice, `piper-fr_FR-siwis` | French stock voices |
| Zero-shot clone TTS | `zipvoice` + `zipvoice-distill` | batch synthesis; sentence-chunked for chat |

Exact URLs/sha256 pinned when the catalog file is authored (k2-fsa GitHub releases / HF mirrors); each entry download-tested on Apple Silicon during M0.

---

## 6. Sapio Reuse Map

From the source exploration of `~/dev/fertilis/sapio-app` (`apps/web/` unless noted). **Copy wholesale (adapt imports/naming):**

| What | Files | Notes |
|---|---|---|
| Shell layout | `src/components/layout/app-layout.tsx`, `sidebar.tsx` (IconBar), `resizable-pane.tsx` | add a section = extend `navItems` + `SectionId` union + a route file |
| Layout persistence | `src/stores/layout-store.ts` | persist `paneWidths` only (partialize) |
| Sidebar tree kit | `src/components/shared/sidebar-tree-node.tsx`, `item-context-menu.tsx`; `src/lib/sidebar-utils.ts`, `tree-utils.ts`; hooks `use-inline-editing.ts`, `use-polling-loader.ts` | **template: `src/components/scheduler/scheduler-sidebar.tsx`** (~175 lines) — copy + swap store/icons |
| Config sync | `src/lib/config-sync.ts` | debounced 500 ms write, 2 s poll, `isPatchingFromFile` loop guard, keychain migration pattern |
| Keychain | `src/lib/keychain.ts` + keychain commands in `src-tauri/src/commands.rs` | change service name to `Vocalis` |
| Theming | `src/lib/hue-presets.ts` (OKLCH hue rotation), `components/theme-provider.tsx`, `HueApplicator` in `routes/__root.tsx`, base tokens in `src/index.css` | |
| Bootstrap | `src/routes/__root.tsx` | startup init gates render until storage ready |
| Settings shell | `src/components/settings/settings-view.tsx`, `settings-sidebar.tsx` | split into modules — Sapio's 733-line view is a flagged god file |
| LLM layer | `src/lib/provider-models.ts`, `models.ts`, `message-conversion.ts`; `src/components/settings/model-picker.tsx`; pi-ai usage in `chat-store.ts` (extract, don't copy the store) | `@earendil-works/pi-ai` ^0.79.6 |
| Store patterns | `src/stores/settings-store.ts` (keychain write-through, `partialize` excluding apiKeys under Tauri) | |
| Tauri plumbing | `src-tauri/src/lib.rs` (builder/plugins/`init_app_data_dir`), fs/config/logging/clipboard/notification commands in `commands.rs` | split into `commands/` modules |
| Build gotchas | Vite `nodeStubsPlugin`, Vitest mock patterns | inspiration.md §8 list applies verbatim |
| Hook shapes | `src/lib/hooks/use-voice-transcription.ts`, `use-speech-playback.ts` | keep the **signatures** (`{status, toggle}`, `onText`, single-active-playback, `stripMarkdownForSpeech`) |

**Rebuild, don't copy:** the audio transport (Sapio's STT/TTS is one-shot OpenRouter HTTP with 15 s MediaRecorder segmenting — the segmenting exists only because of that; realtime capture moves to Rust/cpal entirely) and the sidecar model (`run_pi_sidecar` spawns-collects-exits; irrelevant since sherpa-onnx runs in-process). Guardrails, agentic loop, toolbox, scheduler, tasks, files sections: **out of scope** (no tool-using agent in v1).

---

## 7. Known Risks & Gotchas

1. **ZipVoice quality/latency** — verified supported in sherpa-onnx core (zero-shot cloning from short reference audio) but **batch-only, not streaming**: cloned-voice chat depends on sentence-chunked synthesis being fast enough (target: time-to-first-audio < 1.5 s on M-series). **Mitigation: M0-parallel spike** (CLI-level test before any UI). Fallback: F5-TTS ONNX behind the same `Tts` trait; worst case, cloned voices are ElevenLabs-only while local matures.
2. **Rust binding coverage** — the official `sherpa-onnx` crate is newest; verify each of the ten APIs (esp. ZipVoice, source separation, online punctuation) is exposed; drop to the C API via FFI for gaps rather than switching stacks.
3. **Online diarization** is genuinely hard (incremental clustering instability). Mitigation: live labels are provisional (UI marks them subtly); a refinement pass on session stop re-clusters and cleans labels. Fallback if live quality disappoints: live shows VAD-segmented turns with speaker-ID-only naming (enrolled people), full diarization as the stop-time pass.
4. **Echo without AEC** — speaker output re-triggering VAD. V1: pause capture during playback + headphone guidance (no barge-in — capture just resumes once playback drains); if insufficient, add an AEC stage (e.g. speex/webrtc-audio-processing crate) in the capture path.
5. **macOS text injection** — accessibility permission friction + ⌘V quirks in some apps (terminals, secure fields). Degrade to clipboard+notification; keep the previous clipboard restore robust (restore on a short delay after paste event).
6. **French local coverage** — no FR local punctuation (batch ASR itself, now the default for live/dictation/chat, is multilingual `whisper-small-int8` and covers FR directly). Honest v1: FR punctuation relies on Whisper's inline punctuation or LLM polish (dictation); no FR streaming Zipformer either, but that only affects the Streaming Recognition Playground demo, not production.
7. **Concurrent model memory** — live session runs VAD+ASR+embedder simultaneously; with ZipVoice warm this can exceed comfortable RAM on 8 GB machines. EngineManager LRU + pipeline inspector memory view exist for this; catalog favors int8 quantizations.
8. **Sapio-inherited build gotchas** (inspiration.md §8) — Node-builtin webview stubs, thenable-Proxy Vitest hangs, timer cleanup in dispose, MediaRecorder `onstop` awaiting (still relevant for enrollment recording in the webview), ElevenLabs/OpenAI API quirks (omit empty params; raw-bytes TTS responses).

---

## 8. Milestones

> Each milestone has a detailed implementation plan in this folder (`M0.md` … `M5.md`) with concrete file paths, module shapes, and verification steps. `current_plan.md` (same folder) tracks only the current state and next actions — completed detail lives in the milestone files.

**M0 — Walking skeleton** *(ZipVoice spike runs in parallel)* — plan: [M0.md](M0.md)
Shell (icon bar, 5 sections, theming, config.yaml sync, keychain), Models section with working catalog download of `silero-vad`, `zipformer-streaming-en`, `kokoro-en`; Rust EngineManager + one PipelineActor; playground ASR page streams live mic partials; TTS page speaks. *Exit: live transcript of your own speech + a spoken sentence, all local; spike verdict on ZipVoice documented.*

**M1 — Dictation (first daily value)** — plan: [M1.md](M1.md)
Tray + global hotkey + HUD window; VAD→ASR→punctuation pipeline; clipboard-swap injection + accessibility flow; optional LLM polish (pi-ai minimal integration); dictation settings. *Exit: you stop using your current dictation tool.*

**M2 — Playground complete** — plan: [M2.md](M2.md)
Audio bench kit finalized; all ten tool pages functional with local engines; API engine adapters (OpenAI/Groq/ElevenLabs batch STT; Deepgram streaming) + routing matrix + privacy mode + engine chips; recent runs persistence. *Exit: every sherpa-onnx capability demonstrable; local-vs-API comparable on ASR/TTS pages.*

**M3 — Sessions** — plan: [M3.md](M3.md)
Chat section shell + session conversation type; live pipeline with provisional diarization + stop-time refinement; People enrollment + speaker naming; file import with engine choice; exports (md/SRT/JSON); session audio retention controls. *Exit: a real meeting transcribed live with correct names, exported.*

**M4 — LLM voice chat** — plan: [M4.md](M4.md)
Full pi-ai layer (providers, model picker, streaming); voice conversation mode with VAD turn-taking and the mic paused during TTS playback (no barge-in); sentence-chunked TTS queue; read-aloud on all messages; conversation voice picker. *Exit: a hands-free multi-turn conversation that feels natural, with no echo of the assistant's own voice.*

**M5 — Voice cloning** — plan: [M5.md](M5.md)
People clone flow (guided recording, consent); ZipVoice local synthesis wired as a TTS engine; ElevenLabs clone creation + listing; clone voices in every picker; latency tuning (chunking, warm-up). *Exit: your cloned voice answers you in chat, fully locally.*

**v1.5 hooks (speced, not built):** wake-word chat activation (KWS), "clean speech" separation preprocessing on session import, system-audio capture, AEC, Windows/Linux.

---

## 9. Non-Goals for v1

Windows/Linux · browser build · system-audio capture · wake-word product integration · pipeline canvas / node graph · agentic tool use, guardrails engine, toolbox/scheduler/tasks/files sections (Sapio features not carried over) · mobile · multi-user/sync · streaming cloned-voice TTS (batch-chunked only).

---

## Appendix A — Decision Record (interview, 2026-07-09)

1. **Purpose**: personal daily-driver voice tool; playground covers all ten capabilities.
2. **Runtime**: Tauri v2 + React 19; sherpa-onnx in-process in Rust; cpal capture; Tauri events/channels; no sidecar; no browser build.
3. **Chat = two modes**: LLM voice chat + transcription sessions, shared transcript UI/storage.
4. **Speech APIs**: OpenAI, ElevenLabs, Groq, Deepgram — all four in v1.
5. **Routing**: per-task defaults + inline override everywhere + global privacy/local-only mode.
6. **Cloning**: local in v1 (ZipVoice via sherpa-onnx) + ElevenLabs, one VoiceProfile abstraction; early spike.
7. **System-wide dictation**: yes — global push-to-talk, menubar, paste injection.
8. **Turn-taking**: hands-free VAD + barge-in; PTT alternative; VAD gating for echo.
9. **LLM**: reuse Sapio's pi-ai layer, all providers.
10. **Playground**: tool pages on a shared audio bench.
11. **Sessions**: live VAD+ASR+punct+diarization, file import, md/SRT/JSON export.
12. **Voices**: People profiles (enrollment + clone refs) + TTS voice library.
13. **Models**: curated catalog + download manager + custom escape hatch.
14. **Languages**: English + French first-class.
15. **Platform**: macOS only, Apple Silicon.
16. **Architecture**: single app, pragmatic hexagon, one collection store, Zod schemas, no god files.
17. **Name**: Vocalis — `~/.vocalis/`, keychain `Vocalis`, `com.fertilis.vocalis`.
18. **Retention**: keep sessions & voices; ephemeral dictation/chat audio; TTS LRU cache ~2 GB.
19. **Dictation polish**: local punctuation always; optional LLM cleanup toggle.
20. **KWS & separation**: playground-only in v1; product hooks in v1.5.
21. **Quality bar**: Vitest+Biome+colocated tests+one shared harness; fixture-based Rust integration tests; no coverage gates yet.
22. **Build order**: M0 skeleton → M1 dictation → M2 playground → M3 sessions → M4 voice chat → M5 cloning; ZipVoice spike parallel to M0/M1.
23. **Debug**: log viewer + live pipeline inspector.
