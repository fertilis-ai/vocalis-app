use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::audio::{downmix_to_mono, LinearResampler, TARGET_SAMPLE_RATE};

// Pure-Rust file decoding for session import (spec §4, M3 item 4) and for the
// bench/separation tools. symphonia probes the container by content (with a
// filename-extension hint) and decodes wav / mp3 / m4a-aac(+alac) / flac; the
// stream is downmixed to mono. Originals are never modified.

/// Decode any supported audio file to mono f32 at its native sample rate — no
/// resampling. Callers that need a fixed rate (e.g. speech models) should
/// resample themselves; callers like source separation want the original
/// rate preserved. Errors are actionable (unopenable / unsupported / no audio
/// track / empty), so the import UI can surface why a file was rejected.
pub fn decode_native_mono(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported or corrupt audio file {}: {e}", path.display()))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| format!("no decodable audio track in {}", path.display()))?;
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder for {}: {e}", path.display()))?;

    let mut rate: u32 = TARGET_SAMPLE_RATE;
    let mut channels: u16 = 1;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut out: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Clean end-of-stream: symphonia signals it as an unexpected EOF.
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("decode error in {}: {e}", path.display())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                // Size the interleave buffer from the first frame.
                if sample_buf.is_none() {
                    channels = spec.channels.count() as u16;
                    rate = spec.rate;
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                let buf = sample_buf.as_mut().unwrap();
                buf.copy_interleaved_ref(decoded);
                out.extend_from_slice(&downmix_to_mono(buf.samples(), channels));
            }
            // A single corrupt frame shouldn't abort a whole import.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(format!("decode error in {}: {e}", path.display())),
        }
    }

    if out.is_empty() {
        return Err(format!("no audio decoded from {}", path.display()));
    }
    Ok((out, rate))
}

/// Decode any supported audio file to 16 kHz mono f32 — the rate the speech
/// models consume, same downmix + resample the live capture path uses.
pub fn decode_to_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let (mono, rate) = decode_native_mono(path)?;
    let mut resampler = LinearResampler::new(rate, TARGET_SAMPLE_RATE);
    Ok(resampler.process(&mono))
}
