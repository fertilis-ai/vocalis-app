# M4 Implementation Review — Findings & Recommendations

_Review date: 2026-07-10 (supersedes the M3 review of the same date; that review's content is not restated here — see git history if needed). Scope: M4 items 1–2 (pi-ai LLM layer; chat persistence, text chat, read-aloud), verified against `spec.md` and `M4.md`'s own build records, plus an explicit inventory of the deferred items (M4 items 3–4) and the settings-section gap they imply. Method: read every file the build record names, traced the privacy-mode and disabled-reason claims against the actual code, confirmed by file search that nothing from items 3–4 exists yet._

**Suite status at review time:** `tsc` clean · 319 vitest pass (30 files) · `cargo check` clean · `lint` exit 0 new warnings (2 pre-existing `index.css` warnings, unrelated — see §5).

---

## 1. Verdict

Items 1–2 are a correct, conformant implementation of the **text-chat-with-read-aloud** subset of §2.2A, with two real conformance bugs found during this review and **fixed as part of it** (both small, both directly contradicted M4.md item 1's own written acceptance text — see §2). Everything else traced in §3 held up: no raw audio crosses the boundary (not yet implicated at this stage), no silent engine fallback, write-race safety, streaming/abort semantics, and the read-aloud hook shapes all match spec intent.

Items 3–4 are **entirely unbuilt** — confirmed by file search (`chat_capture.rs`, `sentence-chunker.ts`, `playback-queue.ts` all absent), not just by the M4.md status line. M4's own exit criterion ("a hands-free, multi-turn voice conversation with natural interruptions works end-to-end") is not met. This is a deliberate, previously-scoped deferral, not an oversight — §4 restates it with a concrete build order and sequencing advice rather than just re-flagging it as missing.

A related gap not previously called out on its own: **spec §2.7 names a distinct "Voice Chat" settings section (VAD thresholds, barge-in on/off, default voice/model) and a distinct "LLM Models" section — neither exists.** See §4.3.

---

## 2. Bugs found and fixed during this review

Both were in-scope to fix directly (narrow, low-risk, verified clean against `check-types`/`lint`/`test:run` — 319/319 pass) because they contradict M4.md item 1's own explicit acceptance text, not because they're new work:

**Fixed — privacy mode blocked local LLMs too** (`src/lib/llm/stream-chat.ts`). M4.md item 1 states: *"in privacy mode only local providers (Ollama/LM Studio) are eligible."* The code instead threw unconditionally whenever `privacyMode` was on, regardless of provider — so enabling privacy mode disabled chat entirely, including against a local Ollama/LM Studio server, which is exactly the case privacy mode is supposed to still allow. Fixed to gate only on `!isLocalProvider(ref.provider)`. The code comment claiming this "mirrors dictation-polish.ts" was also corrected — `dictation-polish.ts` is API-only with no local path, so unconditional blocking is correct *there*; it was never actually analogous to chat's local-capable case, and the comment was misleading about why the two differ.

**Fixed — model picker had no disabled-reason UI** (`src/components/chat/model-picker.tsx`). M4.md item 1 explicitly asks to "reflect [privacy mode] in the model picker's disabled reasons." Previously every cloud entry rendered as a plain clickable item regardless of whether a key was set or privacy mode was on — picking one you couldn't use only surfaced an error after hitting send. Fixed by reusing the existing `EngineChip` convention (`disabled={!eligible}` + a muted trailing reason label, `src/components/shared/engine-chip.tsx`): cloud entries now show "no API key" or "privacy mode" and are disabled accordingly; the local entry is unaffected.

---

## 3. Confirmed correct (no action needed)

- **No silent API fallback (§3.4):** `synthesizeMessageSpeech` resolves TTS through `resolveEngine("tts", ctx)` and throws rather than substituting a different engine kind; the router independently hard-filters `kind: "api"` under privacy mode, so read-aloud was never affected by the chat bug above.
- **Store size discipline (§3.6):** `chat-store.ts` is 145 lines against a ~400-line budget; streaming state deliberately lives in `use-chat-stream.ts`, not the store.
- **Write-race safety:** per-conversation `serialize()` via `write-queue.ts` matches the established M3 collection-store pattern.
- **Streaming/abort semantics:** token deltas stay local until turn completion; abort vs. provider-error is correctly distinguished via `AbortController.signal.aborted` — a stopped turn persists silently, a genuine error sets `message.error`.
- **Read-aloud hook shapes (§6):** `stripMarkdownForSpeech`/`MAX_SPEECH_INPUT_CHARS` were ported under the exact names spec's reuse-map table calls for. Single-active-playback is preserved (adapted from Sapio's per-message-instance pattern into a conversation-scoped hook, `use-message-playback.ts` — a reasonable fit for Vocalis's message-list UI, not a deviation from intent). Traced the token-guard and old/new-`<audio>`-element handoff in `play()`/`stop()` for races: none found — stale async resolutions and superseded playback are correctly no-op'd via the `tokenRef` counter.
- **Auto-title on first turn:** keeps the persisted title and sidebar tree label in sync via both `chatStore.updateConversation` and `useChatsCollection.rename()`.
- **IPC boundary (§3.2):** not yet implicated — items 1–2 are pure webview/text; correctly out of scope until item 3 introduces raw audio capture.

---

## 4. Deferred items — status and recommendations

### 4.1 M4 item 3 — Voice turn pipeline (Rust capture, sentence chunker, playback queue)

Confirmed absent via search: no `src-tauri/src/pipeline/chat_capture.rs`, no `src/lib/audio/sentence-chunker.ts`, no `src/lib/audio/playback-queue.ts`.

Recommended build order (matches M4.md's own item-3 ordering, restated with the dependency reasoning):
1. **`chat_capture.rs` first.** Same thread-owning shape as the existing dictation capture pipeline — copy a known-good pattern rather than design a new one. Nothing downstream (chunking, playback, barge-in) can be exercised without real `Partial`/`Final`/`VadState` events to drive it.
2. **`sentence-chunker.ts` next, as a pure TS unit with no engine dependency.** Spec calls out specific edge cases to unit-test (abbreviations, numbers, code blocks — skip code blocks for speech); all of this can be built and fully tested against synthetic streamed text before it's wired to a live LLM stream or TTS.
3. **`playback-queue.ts` + per-sentence look-ahead synthesis last**, once chunked text exists to feed it.

Keep the `playback_state(active: bool)` → VAD-threshold-raise coupling (echo gating, §3.2/§7.4) as its own step after the queue works standalone — that lets the echo-gating logic be verified independently of barge-in's cancellation logic (item 4), instead of debugging both interacting bugs at once.

### 4.2 M4 item 4 — Turn-taking, barge-in, and modes

Confirmed absent: no barge-in cancellation logic, no push-to-talk mode, no Voice Chat settings section, no EngineChip on the chat surface for STT.

- **Barge-in + echo mitigation v1** are the highest-risk, hardest-to-verify pieces in all of M4 — they require on-device testing with real speakers/headphones per the spec's own exit test, not just unit coverage. Budget real iteration time against the ~150 ms interrupt-latency target and the "no echo loops with speakers" bar; don't treat this like items 1–2, where code-complete-then-verify was a reasonable two-phase split.
- **Push-to-talk** is comparatively cheap (same capture pipeline, gated by key state instead of VAD endpointing) and could be sequenced *before* barge-in if hands-free interruption logic turns out to be the long pole — it exercises and de-risks the capture pipeline in isolation, without needing barge-in's cancellation race to also work.
- **Do not build AEC now** — spec explicitly defers it to v2. The in-scope v1 mitigation is playback-aware VAD gating + a "use headphones" onboarding hint, nothing more.

### 4.3 Voice Chat / LLM Models settings sections (§2.7) — missing, not previously called out on its own

`spec.md` §2.7 names eight settings sections: Appearance, API Keys, Engines & Routing, Models, Dictation, **Voice Chat** (VAD thresholds, barge-in on/off, default voice/model), **LLM Models** (pi-ai provider model picker), Audio, Advanced. The actual sidebar (`src/components/settings/sections.ts`) also has eight sections, but they don't map one-to-one: there is no "Voice Chat" section, and no separate "LLM Models" section — what exists under the single "Chat" section (`chat-settings.tsx`) is only local-LLM-server config (provider toggle, base URL, model name). Cloud model selection lives exclusively in the inline per-conversation `ModelPicker`; nothing about it appears in Settings.

This is consistent with items 3–4 being unbuilt (there's nothing to configure VAD thresholds or barge-in for yet), but worth surfacing explicitly rather than leaving implicit: **the Voice Chat settings section should land alongside item 4**, not get treated as a UI afterthought once the pipeline already exists. Separately, M4.md item 1's own original-plan text ("`components/settings/model-picker.tsx` → the LLM Models settings section") implies a dedicated section was intended but never built — only the per-conversation dropdown was. Recommend deciding now whether "LLM Models" becomes its own section or stays folded into "Chat," since that's a cheap decision today and a more disruptive one once more settings code accretes around the current "Chat" section.

### 4.4 Per-conversation voice picker

Already flagged as a caveat in `M4.md` item 2 — restated here because it's a real §2.2A requirement ("Voice picker per conversation... model picker per conversation") where only the model half exists. `conversation.voiceId` and the read-aloud resolver both already support it; only the picker UI is missing. Low effort relative to items 3–4, and useful for read-aloud today independent of voice-mode — recommend building it as a small standalone follow-up to item 2 rather than bundling it into the much larger item 3/4 work.

### 4.5 EngineChip on the chat surface for STT

Spec-required once streaming ASR is wired into chat (item 3), not before — no action needed until then. Note for later: the routing matrix's FR default (Deepgram) depends on the M2 Deepgram streaming adapter, which `current_plan.md` already tracks as not yet landed. Item 3 inherits that open dependency rather than creating a new one.

---

## 5. Adjacent findings (out of scope for M4, noted for awareness only)

- `dictation-polish.ts` has the same "privacy mode + provider capability" shape as the bug fixed in §2, but its unconditional block is correct as-is — it has no local-model path at all (OpenAI/Groq only). The two functions now diverge for a real reason (one has a local option, one doesn't), not by accident; no fix needed there.
- `src/index.css` has dead `[data-streamdown="code-block-body"]` / `.shiki` rules (flagged by `bun run lint` as pre-existing warnings, unrelated to any change in this review) with no corresponding `streamdown`/`shiki` dependency in `package.json` — looks like leftover CSS from the Sapio-derived skeleton. Harmless today; if a markdown renderer is ever added to chat (still explicitly out of scope per M4.md item 2), check whether these rules were meant for it before writing new ones.

---

## 6. Priority order for next session

1. **Live `desktop:dev` pass over M4 items 1–2** (already tracked in `current_plan.md`) — do this before building more on top of unverified UI, especially now that model-picker behavior and privacy-mode gating changed in this review.
2. **Per-conversation voice picker** (§4.4) — small, high value, unblocks read-aloud voice selection today.
3. **Voice Chat / LLM Models settings IA decision** (§4.3) — naming/structure only; cheap to decide now, expensive to unwind later.
4. **M4 item 3**, in order: `chat_capture.rs` → `sentence-chunker.ts` → `playback-queue.ts` (§4.1).
5. **M4 item 4**: barge-in, echo mitigation v1, push-to-talk, Voice Chat settings UI (§4.2) — budget for on-device iteration, not a single code-complete-then-verify pass like items 1–2.
