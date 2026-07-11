//! Offline source separation (catalog task "separation").
//!
//! sherpa-onnx 1.13.4's Rust crate does not wrap the source-separation C API,
//! so this module binds it directly (spec §7.2: drop to the C API via FFI for a
//! single engine rather than switching stacks). The symbols live in the
//! `sherpa-onnx-c-api` static library that `sherpa-onnx-sys` already links, so
//! no extra build wiring is needed — only the `extern "C"` declarations below,
//! kept byte-compatible with `sherpa-onnx/c-api/c-api.h` @ v1.13.4.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::path::Path;

use crate::registry::find_file;

#[repr(C)]
struct SpleeterModelConfig {
    vocals: *const c_char,
    accompaniment: *const c_char,
}

#[repr(C)]
struct UvrModelConfig {
    model: *const c_char,
}

#[repr(C)]
struct ModelConfig {
    spleeter: SpleeterModelConfig,
    uvr: UvrModelConfig,
    num_threads: c_int,
    debug: c_int,
    provider: *const c_char,
}

#[repr(C)]
struct SeparationConfig {
    model: ModelConfig,
}

#[repr(C)]
struct Stem {
    /// `samples[c]` points to channel c's sample array.
    samples: *const *const f32,
    num_channels: c_int,
    n: c_int,
}

#[repr(C)]
struct SeparationOutput {
    stems: *const Stem,
    num_stems: c_int,
    sample_rate: c_int,
}

extern "C" {
    fn SherpaOnnxCreateOfflineSourceSeparation(config: *const SeparationConfig) -> *const c_void;
    fn SherpaOnnxDestroyOfflineSourceSeparation(ss: *const c_void);
    fn SherpaOnnxOfflineSourceSeparationProcess(
        ss: *const c_void,
        samples: *const *const f32,
        num_channels: c_int,
        num_samples: c_int,
        sample_rate: c_int,
    ) -> *const SeparationOutput;
    fn SherpaOnnxDestroySourceSeparationOutput(p: *const SeparationOutput);
}

/// One separated stem: mono samples plus the sample rate they play at.
pub struct SeparatedStem {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Spleeter 2-stem separation engine handle.
pub struct SourceSeparator {
    ptr: *const c_void,
}

// SAFETY: the C engine is used single-threaded behind the SpeechState mutex,
// same contract sherpa's own wrappers rely on.
unsafe impl Send for SourceSeparator {}
unsafe impl Sync for SourceSeparator {}

impl SourceSeparator {
    /// `model_dir` holds a Spleeter release: `vocals.onnx` + `accompaniment.onnx`.
    pub fn new(model_dir: &Path, num_threads: i32) -> Result<Self, String> {
        let vocals = find_file(model_dir, "vocals", ".onnx")
            .ok_or_else(|| format!("no vocals.onnx in {}", model_dir.display()))?;
        let accompaniment = find_file(model_dir, "accompaniment", ".onnx")
            .ok_or_else(|| format!("no accompaniment.onnx in {}", model_dir.display()))?;

        // CStrings must outlive the create() call — hold them on the stack.
        let vocals_c = CString::new(vocals.to_string_lossy().into_owned()).map_err(err)?;
        let accompaniment_c =
            CString::new(accompaniment.to_string_lossy().into_owned()).map_err(err)?;
        let uvr_c = CString::new("").map_err(err)?;
        let provider_c = CString::new("cpu").map_err(err)?;

        let config = SeparationConfig {
            model: ModelConfig {
                spleeter: SpleeterModelConfig {
                    vocals: vocals_c.as_ptr(),
                    accompaniment: accompaniment_c.as_ptr(),
                },
                uvr: UvrModelConfig {
                    model: uvr_c.as_ptr(),
                },
                num_threads,
                debug: 0,
                provider: provider_c.as_ptr(),
            },
        };

        let ptr = unsafe { SherpaOnnxCreateOfflineSourceSeparation(&config) };
        if ptr.is_null() {
            return Err(format!(
                "failed to load source-separation model {}",
                model_dir.display()
            ));
        }
        Ok(Self { ptr })
    }

    /// Separate a mono clip into its stems. Multi-channel stems are downmixed to
    /// mono (average) — the bench previews and exports each stem as mono wav.
    ///
    /// Spleeter operates on stereo, so a mono clip is fed as two identical
    /// channels (the model rejects single-channel input).
    pub fn separate(&self, samples: &[f32], sample_rate: u32) -> Result<Vec<SeparatedStem>, String> {
        if samples.is_empty() {
            return Err("input clip is empty".into());
        }
        let channel: *const f32 = samples.as_ptr();
        let channels: [*const f32; 2] = [channel, channel];

        let out = unsafe {
            SherpaOnnxOfflineSourceSeparationProcess(
                self.ptr,
                channels.as_ptr(),
                2,
                samples.len() as c_int,
                sample_rate as c_int,
            )
        };
        if out.is_null() {
            return Err("source separation produced no output".into());
        }

        let result = self.collect_stems(out);
        unsafe { SherpaOnnxDestroySourceSeparationOutput(out) };
        result
    }

    fn collect_stems(&self, out: *const SeparationOutput) -> Result<Vec<SeparatedStem>, String> {
        let output = unsafe { &*out };
        let rate = output.sample_rate.max(1) as u32;
        let num_stems = output.num_stems.max(0) as usize;
        let stems = unsafe { std::slice::from_raw_parts(output.stems, num_stems) };

        let mut result = Vec::with_capacity(num_stems);
        for stem in stems {
            let channels = stem.num_channels.max(0) as usize;
            let n = stem.n.max(0) as usize;
            if channels == 0 || n == 0 {
                result.push(SeparatedStem {
                    samples: Vec::new(),
                    sample_rate: rate,
                });
                continue;
            }
            let channel_ptrs = unsafe { std::slice::from_raw_parts(stem.samples, channels) };
            // Downmix to mono by averaging channels sample-by-sample.
            let mut mono = vec![0f32; n];
            for &ch_ptr in channel_ptrs {
                let ch = unsafe { std::slice::from_raw_parts(ch_ptr, n) };
                for (m, &s) in mono.iter_mut().zip(ch) {
                    *m += s;
                }
            }
            let scale = 1.0 / channels as f32;
            for m in &mut mono {
                *m *= scale;
            }
            result.push(SeparatedStem {
                samples: mono,
                sample_rate: rate,
            });
        }
        Ok(result)
    }
}

impl Drop for SourceSeparator {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { SherpaOnnxDestroyOfflineSourceSeparation(self.ptr) };
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
