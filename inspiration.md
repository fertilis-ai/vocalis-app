# Sapio — Reimplementation Spec & Inspiration Document

> Derived from a knowledge-graph analysis of the full repo (2,010 nodes · 3,961 edges · 140 communities, graphify 2026-07-09) plus source-level review. This document captures **what the app is, how it's built, what works, and what to do differently** — enough to reimplement it exactly, or to steal the good parts for another project.

---

## 1. What It Is

**Sapio** is a local-first personal AI assistant shipped as a native desktop app (Tauri v2 + Rust) and a browser app from one React codebase. The core promise:

- **Data stays on-device** — everything is files under `~/.sapio/`, API keys in the OS keychain, no server.
- **Agentic, not just chat** — multi-step tool-using agent loop with real-time progress, tool cards, and undo.
- **Safety is a first-class feature** — a guardrails engine (presets, confirmation matrix, rate limits, path/domain/shell restrictions) sits between the model and every tool call.
- **Self-extending** — the agent can (opt-in) write its own prompts, skills, agents, memories, and workflows into a user-visible "Toolbox".

Design principles (from SPEC): Reliability First · Privacy by Default · Progressive Autonomy · Multi-Agent Native · Consumer-Grade UX.

---

## 2. Architecture Overview

### Monorepo layout
```
apps/web/            React 19 frontend + Tauri desktop runtime
  src/               components / routes / stores / lib
  src-tauri/         Rust backend: 37 commands, plugins, sidecar bundling
packages/config/     shared tsconfig
packages/env/        T3 env-core typed env vars
packages/pi-sidecar/ bundles pi-coding-agent as a spawnable binary
```
Turborepo + Bun; workspace catalog pins shared dep versions (`catalog:` protocol).

### The layer cake (data flow of one agent turn)
```
ChatInput → chat-store.streamMessage()
  ├─ assemble system prompt (memories → skills → agent block → file context
  │    → working directory → memory guidance → self-enhance guidance → image guidance)
  ├─ computeContextBudget() → trimMessagesToBudget() (sliding window, keeps
  │    tool-call/result pairs intact, ≥4 recent messages)
  └─ SapioAgentAdapter (wraps pi-agent-core agentLoop())
       ├─ per tool call: GuardrailsEvaluator.evaluate()
       │    1. enabled? 2. blocklists (paths/domains/shell) 3. rate limits
       │    4. confirmation matrix (category × risk)
       ├─ needs confirm → GuardrailConfirmationBar (UI) → approve/deny
       ├─ executeTool() → ExecutionTracker (history) + UndoManager (reversible ops)
       └─ events translated to AgentLoopEvent → agentic-loop-store → UI
```
Key insight: **the adapter is the seam**. `SapioAgentAdapter` wraps a third-party agent runtime (`pi-agent-core`) and injects approval, guardrails, tracking, and undo *without forking the runtime*. LLM calls go direct from the webview via `@earendil-works/pi-ai` (`streamSimple`/`getModel`) — the bundled pi-sidecar binary is a separate coding-agent capability, not the chat path.

### State: 11 Zustand stores, each with a colocated test file
chat (conversations/streaming/budget) · agentic-loop (loop status/iterations) · agent (definitions/selection) · file (tree/tabs/editing) · task (kanban) · scheduler (cron) · toolbox (prompts/memories/skills/workflows/MCP) · settings (keys/models/guardrails/appearance) · tool-history · layout (panes/widths) · debug (log viewer).

### Persistence: files, not a database
- Root `~/.sapio/` (browser fallback: virtual `/sapio-data` in localStorage — same storage API, two backends behind `isTauri()`).
- Subdirs: `chats/ tasks/ agents/ scheduler/ prompts/ memories/ skills/ workflows/ logs/ backups/ images/ sandbox/`.
- `config.yaml` (settings) with **debounced write + file-change polling** for two-way sync (`config-sync.ts`); API keys migrated out of config into the OS **keychain** (`keyring` crate, service "Sapio").
- Trees use folder metadata files (`_meta.yaml` / `folder.yaml`) for hierarchy + pinning; agents/toolbox items are **markdown + YAML frontmatter** (gray-matter).

---

## 3. Tech Stack (with the "why")

| Layer | Choice | Why it earned its place |
|---|---|---|
| UI | React 19 + TS strict | `noUnusedLocals`, `verbatimModuleSyntax`; near-zero `any` in prod code |
| Routing | TanStack Router (file-based) | routes auto-generate; 9 routes = 9 files |
| State | Zustand ×11 | small stores, selector-derived state (e.g. `currentConversation` is derived, not stored) |
| Styling | Tailwind v4 + shadcn/ui + CVA | `cn()` is the #1 god node (78 edges) — one tiny utility carries the whole design system |
| AI runtime | pi-mono (`@earendil-works/pi-ai`, `pi-agent-core`) | provider-agnostic streaming + agent loop; app wraps rather than forks |
| Desktop | Tauri v2 | 37 Rust commands; small binary; webview reuses the exact web bundle |
| Secrets | OS keychain via `keyring` crate | keys never sit in config files |
| Build | Vite 6 + Turborepo + Bun | custom `nodeStubsPlugin` (see §8 gotchas) |
| Testing | Vitest + Testing Library, jsdom | ~2,000 tests / 80 files; 80/75/70 coverage thresholds |
| Lint | Biome (linter only) | fast, formatter intentionally off |

Providers: Anthropic, OpenAI, Google, OpenRouter (+ local Ollama/LM Studio via openai-completions). Model discovery fetches live model lists per provider; OpenRouter `/endpoints/zdr` is the only reliable "no data collection" signal for privacy filtering.

---

## 4. Feature Spec

### 4.1 AI Chat
Streaming markdown chat, multi-provider, mid-conversation agent switching, folder-organized history sidebar, slash-command prompt expansion (`/<name>` pulls a Toolbox prompt template), context-file attachment, voice input, read-aloud TTS.

### 4.2 Agentic Loop
Multi-step execution with progress panel (status, iterations, elapsed time), tool calls rendered as expandable cards with results/images, context shared across runs (`SharedContextManager`: fetched URLs, recent file ops, shell outputs), error classification with a single context-overflow retry using a tighter trim window (observed as a loop event, not a throw).

### 4.3 Guardrails (the signature feature)
- **Three presets**: Normal (confirm medium+ risk, sandbox on, conservative rates), Advanced (confirm high+ only, sandbox off, relaxed rates), YOLO (`enabled:false`, tiny blocklist of catastrophic commands only).
- **Config** = category×risk confirmation matrix + path/domain/shell allow/blocklists (each with `defaultPolicy`) + rate limits (tool/min, tool/hr, api/min, shell/min, sliding windows) + sandbox config.
- **Tool catalog**: every tool declares `category` (file_system/web/system/integration/memory/custom) and `riskLevel` (low/medium/high/critical); `shell_execute` is the only *critical*. Unknown tools default to risk **high** — fail-safe.
- **Shell hardening**: allowlist checked *per chained segment*; blocks `python -c`, `node -e`, command substitution, `curl|sh`, `sudo`.
- **Undo**: file_write/file_delete/directory_create/clipboard_write are undoable (1-hour expiry), surfaced in tool history.

### 4.4 Toolbox (self-extension hub)
Six item kinds, all plain files the user can open in the built-in editor: Prompts (.yaml), Memories (.md), Agents (.md + frontmatter: model, temperature, `tools:` scoping), Skills (.md with trigger matching), Workflows (.yaml multi-step, `{{previous}}`/`{{input}}` substitution, steps share one background conversation), MCP configs (.json). The agent's own write access to these is gated behind a `allowSelfEnhancement` setting (default **off**); the `remember` memory tool is always on (medium risk).

### 4.5 Memory system
Well-known SOUL/USER memories seeded at startup; `alwaysInclude` frontmatter flag; memories resolve into the system prompt as `## heading\nbody` sections; app-data copies are canonical with a legacy settings-dir fallback.

### 4.6 Scheduler
CRON schedules with visual builder + cronstrue human-readable descriptions; in-memory tick runner (`scheduler-runner`) computes next runs, executes into background conversations, logs per-schedule, marks errors. Workflows schedulable.

### 4.7 Files / Tasks / Settings / Debug
- Files: tree browser, tabbed Shiki-highlighted editor, unsaved-warning modal, file search modal.
- Tasks: kanban with drag-and-drop, folders, confirm modals.
- Settings: sectioned view (Appearance with hue presets over OKLCH CSS variables, API keys → keychain, Model picker with provider grouping + text-modality/ZDR filters, Guardrails matrix editor, Directories, Local LLM, Debug toggles).
- Debug: log-file viewer over `~/.sapio/logs/` (Rust-appended).

### 4.8 Multimodal
- **Voice in**: MediaRecorder → 15s segments → OpenRouter STT (no streaming API — segmentation is the workaround); macOS mic permission via Info.plist.
- **TTS out**: OpenRouter speech API returns raw mp3 bytes; play via object URL; omit empty `voice` param.
- **Image gen**: `generate_image` tool → OpenRouter Image API → saved under `~/.sapio/images/`, result contract is a "Saved to: <path>" string; Tauri `protocol-asset` feature to render local images.

---

## 5. UI Shell Spec

```
┌──────┬─────────────┬──────────────────────────────┐
│ Icon │ Section     │  Main view (route outlet)    │
│ Bar  │ Sidebar     │                              │
│      │ (resizable, │  chat / files / tasks /      │
│ 5+2  │ per-section │  scheduler / toolbox /       │
│ items│ width saved)│  settings / debug            │
└──────┴─────────────┴──────────────────────────────┘
```
- IconBar: chat, files, tasks, scheduler, toolbox + settings/debug as pane toggles.
- Shared sidebar infrastructure extracted once and reused by chat/tasks/scheduler/toolbox: `SidebarTreeNode`, `ItemContextMenu`, `usePollingLoader`, `useInlineEditing`, `splitByPinned`, tree utils (`findNodeInTree`, `getUniqueName`, …). **This extraction is one of the repo's best moves** — four sidebars, one implementation.
- Theming: next-themes dark/light + hue presets applying OKLCH CSS-variable overrides.

---

## 6. Rust/Tauri Backend Surface

37 commands in one `commands.rs` (~960 lines), grouped:
- **FS**: read/write/delete/rename/copy/list, base64 variants, `reveal_in_folder`, backup/restore (to `backups/`)
- **Config**: read/save `config.yaml` (serde_yaml)
- **Shell**: `execute_shell` (sandbox param deliberately removed from both sides)
- **Clipboard / Notifications / HTTP** (`http_request` proxies to avoid webview CORS)
- **Keychain**: store/get/delete/get_all API keys
- **Logging**: append/read/clear, multi-file under `~/.sapio/logs/`
- **Sidecar**: `run_pi_sidecar` spawns the bundled binary via shell plugin

Plugins: http, shell, dialog, log. Hardening done: CSP set (null in dev for HMR), `http://**` capability removed, request-body logging gated behind a debug flag, all fs commands async.

---

## 7. Known Flaws (graph-verified) — fix these in a rebuild

1. **Import cycles** (graph found 2): `guardrails/types.ts → tools/categories.ts → tools/image-tools.ts → stores/settings-store.ts → guardrails/{types,presets}.ts`. Cause: the tool catalog reaches into a store, and guardrails types depend on the catalog. *Fix: make the tool catalog pure data with zero store imports; inject settings at call time.*
2. **God files**: `chat-store.ts` (1,475 lines — streaming + model resolution + budgeting + prompt assembly + tree sync), `storage.ts` (989), `sapio-agent-adapter.ts` (989), `commands.rs` (960), `settings-view.tsx` (733). The graph's lowest-cohesion communities (0.04–0.06) are exactly these areas. *Fix: prompt assembly, model resolution, and streaming belong in separate modules from day one.*
3. **Storage triplication**: chats/tasks/scheduler each re-implement folder-tree CRUD with slightly different metadata files (`_meta.yaml` vs `folder.yaml`). *Fix: one generic `TreeStore<T>` with pluggable serializers.*
4. **Serialization inconsistency**: chats save as JSON but load YAML-or-JSON; folder metas are YAML; toolbox is markdown+frontmatter. Three schemes where one convention would do. *Fix: pick markdown+frontmatter for human-editable items, one structured format (JSON) for machine state — and never mix reader/writer formats.*
5. **`detectPreset()` heuristic** reverse-engineers which preset a config matches by field comparison — brittle under hand-edits. *Fix: store the preset name; treat edits as "Custom".*
6. **Heuristic token counting** (chars/4) drives context trimming; a `reconcileWithUsage()` patch exists but real tokenizer counts would remove a class of overflow retries.
7. **`cn()`/`react` as bridges**: the graph's top betweenness nodes are utilities, meaning cross-feature coupling is low — good — but also that there's **no shared domain layer**; each feature talks to storage directly.
8. **God-store pattern in tests**: `vi.mock` in 59 of 80 test files, mostly re-mocking the same storage/invoke/pi-ai trio. *Fix: one shared test harness module instead of per-file mock blocks.*

---

## 8. Hard-Won Gotchas (keep these — they cost real debugging time)

- **Node builtins in a webview**: `rollupOptions.external` "works" but emits bare `from "stream"` specifiers → blank screen in Tauri. The fix is a Vite plugin that resolves each Node builtin to a Proxy-based no-op stub with `syntheticNamedExports`. (`vite-plugin-node-polyfills` fails on CJS subpaths like `fs/promises`.)
- **Thenable Proxy mocks hang Vitest**: a `vi.mock` Proxy answering `.then` looks like a promise and `await` never resolves. Return `undefined` for `then`/symbols; add `has: () => true`.
- **`setInterval` in constructors** (UndoManager) keeps the test process alive — always store and clear timer IDs in a dispose method.
- **`vi.mock` factory TDZ + spread**: zero-param `vi.fn(() => …)` spread triggers TS2556; mock implementations need rest params.
- **Shiki mocks** must export `bundledLanguages` + `getLoadedLanguages`/`loadLanguage` or unhandled rejections leak from highlight paths.
- **Async `onstop`** in MediaRecorder flows: the stop handler must be awaited or last-segment audio is dropped.
- **OpenRouter quirks**: STT has no streaming (chunk to ~15s segments); TTS returns raw bytes not JSON; empty `voice` must be omitted; `/endpoints/zdr` is the only privacy signal; image results are saved-file paths, not inline data.

---

## 9. If Reimplementing: A Better Blueprint

Keep the product shape (it's coherent and differentiated), change the skeleton:

1. **Hexagonal core.** Define `AgentPort`, `StoragePort`, `SecretsPort`, `ShellPort` interfaces first. Tauri/localStorage/keychain become adapters. This removes the isTauri() branching sprinkled through storage and makes a future mobile/server target trivial.
2. **Guardrails as middleware pipeline.** The evaluate() ordering (enabled → blocklists → rate limits → confirmation) is right; implement it as composable interceptors around a `ToolInvocation`, so sandbox, audit-log, and undo become peers in the same chain rather than adapter-internal logic.
3. **One tree abstraction** for all sidebar-organized collections (chats, tasks, schedules, toolbox): `Collection<T> = { tree, meta, serializer }`. The current shared *UI* proves the concept; extend it to storage.
4. **Event-sourced tool history.** ExecutionTracker + UndoManager + tool-history-store are three views of one event stream. Persist the stream (JSONL per day), derive the rest.
5. **Real tokenizer + budget ledger.** Replace chars/4 with the provider tokenizer where available; keep the sliding-window trim (whole-message granularity preserving tool pairs — that part is correct).
6. **Preset as identity, config as diff.** `{ preset: "normal", overrides: {...} }` instead of detectPreset().
7. **Schema-first everything.** Zod schemas for config.yaml, toolbox frontmatter, workflow files — validated at load with actionable errors (the repo's own good-code-skill preaches this; the app only partially practices it).
8. **Keep**: the adapter-wraps-runtime pattern, keychain-only secrets, confirmation bar UX, undo with expiry, self-enhancement behind an off-by-default flag, per-segment shell allowlisting, config file two-way sync, colocated store tests, Biome+Vitest+CI trio.

---

## 10. Numbers That Describe the Codebase

| Metric | Value |
|---|---|
| Source corpus | 330 files · ~422k words |
| Graph | 2,010 nodes · 3,961 edges · 140 communities |
| Top god nodes | `cn()` 78 · `useSettingsStore` 36 · `SapioAgentAdapter` 32 · `ExecutionTracker` 26 · `GuardrailsEvaluator` 25 |
| Tests | ~1,985 tests / 80 files, coverage gates 80/75/70 |
| Stores | 11 Zustand stores, each tested |
| Tools | 21 built-in tools across 6 categories × 4 risk levels |
| Rust commands | 37 |
| Routes | 9 (file-based) |
| Import cycles | 2 (both through tools/categories ↔ settings-store) |

---

*Generated 2026-07-09 from the graphify knowledge graph (`graphify-out/`) and direct source review.*
