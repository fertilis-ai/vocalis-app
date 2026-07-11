mod capture;
mod decode;
mod resample;

pub use capture::*;
pub use decode::*;
pub use resample::*;

/// All local speech models consume 16 kHz mono f32.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;
