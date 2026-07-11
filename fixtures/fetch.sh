#!/usr/bin/env bash
# Fetch the fixture models and reference wavs used by
# src-tauri/tests/fixtures_integration.rs.
#
# Everything lands in fixtures/models/ and fixtures/wavs/fetched/ (both
# gitignored). URLs and sha256 are pinned, same convention as
# catalog/catalog.json. Idempotent: already-installed fixtures are skipped.
# Total download ~189 MB.
set -euo pipefail

cd "$(dirname "$0")"
MODELS_DIR="models"
TMP_DIR="$MODELS_DIR/.tmp"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

verify_sha256() {
  local file="$1" expected="$2" actual
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "sha256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# fetch_file <url> <sha256> <dest-path>
fetch_file() {
  local url="$1" sha="$2" dest="$3"
  if [ -f "$dest" ]; then
    echo "skip (present): $dest"
    return
  fi
  echo "fetching $url"
  local tmp="$TMP_DIR/$(basename "$dest")"
  curl -sfL --retry 3 -o "$tmp" "$url"
  verify_sha256 "$tmp" "$sha"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp" "$dest"
  echo "installed: $dest"
}

# fetch_tarball <url> <sha256> <dest-dir>  (top-level dir stripped)
fetch_tarball() {
  local url="$1" sha="$2" dest="$3"
  if [ -d "$dest" ]; then
    echo "skip (present): $dest"
    return
  fi
  echo "fetching $url"
  local tmp="$TMP_DIR/$(basename "$url")"
  curl -sfL --retry 3 -o "$tmp" "$url"
  verify_sha256 "$tmp" "$sha"
  mkdir -p "$dest"
  tar xjf "$tmp" --strip-components=1 -C "$dest"
  rm -f "$tmp"
  echo "installed: $dest"
}

# Silero VAD v5 (0.6 MB) — same artifact as catalog vad/silero-vad-v5.
fetch_file \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" \
  "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" \
  "$MODELS_DIR/vad/silero-vad-v5/silero_vad.onnx"

# Streaming Zipformer EN 20M (122 MB tarball) — the smallest published
# English streaming transducer; same layout as the catalog's zipformer.
fetch_tarball \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2" \
  "9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9" \
  "$MODELS_DIR/asr-streaming/zipformer-en-20M"

# CAM++ VoxCeleb speaker embedding (28 MB) — same artifact as catalog
# speaker-embedding/campplus-en-voxceleb.
fetch_file \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx" \
  "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b" \
  "$MODELS_DIR/speaker-embedding/campplus-en-voxceleb/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"

# Pyannote segmentation 3.0 (6.6 MB tarball) — same artifact as catalog
# diarization/pyannote-segmentation-3-0.
fetch_tarball \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" \
  "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488" \
  "$MODELS_DIR/diarization/pyannote-segmentation-3-0"

# CAM++ zh-cn speaker embedding (28 MB) — test-only, NOT a catalog model.
# The pinned real-speaker reference wavs below are Chinese, and the shipped
# en-voxceleb embedding cannot discriminate them (language mismatch); this is
# the model sherpa-onnx's own speaker-identification examples pair them with.
fetch_file \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx" \
  "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11" \
  "$MODELS_DIR/speaker-embedding-zh/campplus-zh-cn/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"

# Reference wavs for the speaker tests — real human voices (synthetic TTS
# voices share vocoder artifacts and embed almost identically, so they can't
# exercise speaker discrimination). Same 3D-Speaker test data sherpa-onnx's
# own speaker-identification examples use, plus its diarization test clip.
fetch_file \
  "https://github.com/csukuangfj/sr-data/raw/main/test/3d-speaker/speaker1_a_cn_16k.wav" \
  "5f20ce0ddc378ca3239d3ce864b1142726a46a1221ae553912e4e142045df58b" \
  "wavs/fetched/speaker1-a-cn-16k.wav"
fetch_file \
  "https://github.com/csukuangfj/sr-data/raw/main/test/3d-speaker/speaker1_b_cn_16k.wav" \
  "20745dc08a4281894d146140b99b9ef7417ac681119b7f7202f553cdf1a85f65" \
  "wavs/fetched/speaker1-b-cn-16k.wav"
fetch_file \
  "https://github.com/csukuangfj/sr-data/raw/main/test/3d-speaker/speaker2_a_cn_16k.wav" \
  "8a6cffa452df32ef10503f7992f22ffcdd7f16c4e0273d13311bc5cdcb13abf4" \
  "wavs/fetched/speaker2-a-cn-16k.wav"
fetch_file \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav" \
  "bedf036caed208386c67b4ef4b11f83d74dd0d420b102163a1c33cd09cde7010" \
  "wavs/fetched/four-speakers-zh-16k.wav"

# Zipformer KWS GigaSpeech (17 MB tarball) — same artifact as catalog
# kws/kws-zipformer-gigaspeech.
fetch_tarball \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2" \
  "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a" \
  "$MODELS_DIR/kws/kws-zipformer-gigaspeech"

# Spleeter 2-stems fp16 (35 MB tarball) — same artifact as catalog
# separation/spleeter-2stems-fp16.
fetch_tarball \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2" \
  "d54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2" \
  "$MODELS_DIR/separation/spleeter-2stems-fp16"

# Whisper tiny multilingual (116 MB tarball) — same artifact as catalog
# lang-id/whisper-tiny-langid; used for spoken language identification.
fetch_tarball \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2" \
  "c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1" \
  "$MODELS_DIR/lang-id/whisper-tiny-langid"

echo "fixtures ready."
