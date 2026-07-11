# Fixtures

Tiny models + WAVs for Rust integration tests (spec §3.1, decision A.21).

## Layout

- `wavs/speech-en-16k.wav` — committed. 2.5 s of 16 kHz mono English speech
  ("The quick brown fox jumps over the lazy dog.", macOS `say -v Samantha`,
  84 KB).
- `models/` — **gitignored**; populated by `./fetch.sh` (~123 MB download,
  pinned URLs + sha256, idempotent):
  - `vad/silero-vad-v5/silero_vad.onnx` (0.6 MB)
  - `asr-streaming/zipformer-en-20M/` (streaming Zipformer EN, 20M params —
    the smallest published English streaming transducer)

## Running the tests

```sh
./fixtures/fetch.sh
cd src-tauri && cargo test --test fixtures_integration
```

The tests run un-ignored under plain `cargo test`; when `fixtures/models/` is
absent each test skips with a message pointing at `fetch.sh`.

## Coverage

Fixtures cover **VAD** and **streaming ASR**. TTS has no small option: the
`KokoroTts` engine only loads Kokoro models and the smallest release is
~305 MB, so TTS (and full-size ASR) stay in
`src-tauri/tests/engines_integration.rs` as `--ignored` tests against real
models in `~/.vocalis/models/`.
