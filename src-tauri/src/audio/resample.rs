/// Stateful linear resampler: arbitrary input rate → 16 kHz mono.
///
/// Linear interpolation is sufficient for speech-model input (the models were
/// trained on far noisier channels than interpolation error); a windowed-sinc
/// stage can replace this later without touching call sites.
pub struct LinearResampler {
    ratio: f64,
    // Fractional read position between the last sample of the previous chunk
    // and the first of the next.
    pos: f64,
    last: f32,
    primed: bool,
}

impl LinearResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            ratio: input_rate as f64 / output_rate as f64,
            pos: 0.0,
            last: 0.0,
            primed: false,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        self.ratio == 1.0
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        if self.is_passthrough() {
            return input.to_vec();
        }

        // Virtual buffer: [last, input...] with pos measured from `last`.
        let mut out = Vec::with_capacity((input.len() as f64 / self.ratio) as usize + 2);
        if !self.primed {
            self.last = input[0];
            self.primed = true;
            self.pos = 0.0;
        }

        loop {
            let idx = self.pos.floor() as usize;
            let frac = (self.pos - idx as f64) as f32;
            // idx==0 interpolates last↔input[0]; idx>=1 interpolates within input.
            let (a, b) = if idx == 0 {
                (self.last, input[0])
            } else if idx <= input.len() - 1 {
                let a = input[idx - 1];
                let b = if idx < input.len() { input[idx] } else { break };
                (a, b)
            } else {
                break;
            };
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
            if self.pos.floor() as usize > input.len() - 1 {
                break;
            }
        }

        self.pos -= input.len() as f64;
        self.last = input[input.len() - 1];
        out
    }
}

/// Downmix interleaved multi-channel f32 to mono by averaging.
pub fn downmix_to_mono(input: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return input.to_vec();
    }
    let ch = channels as usize;
    input
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_at_same_rate() {
        let mut r = LinearResampler::new(16_000, 16_000);
        let input = vec![0.1, 0.2, 0.3];
        assert_eq!(r.process(&input), input);
    }

    #[test]
    fn halves_sample_count_at_2x_rate() {
        let mut r = LinearResampler::new(32_000, 16_000);
        let input: Vec<f32> = (0..3200).map(|i| (i as f32 / 3200.0).sin()).collect();
        let out = r.process(&input);
        let expected = input.len() / 2;
        assert!(
            (out.len() as i64 - expected as i64).abs() <= 2,
            "expected ~{expected}, got {}",
            out.len()
        );
    }

    #[test]
    fn preserves_total_output_across_chunks() {
        // 48k -> 16k over many small chunks should produce ~1/3 the samples.
        let mut r = LinearResampler::new(48_000, 16_000);
        let total_in = 48_000;
        let mut total_out = 0;
        let chunk: Vec<f32> = (0..480).map(|i| (i as f32 * 0.01).sin()).collect();
        for _ in 0..(total_in / 480) {
            total_out += r.process(&chunk).len();
        }
        let expected = total_in / 3;
        assert!(
            (total_out as i64 - expected as i64).abs() <= 10,
            "expected ~{expected}, got {total_out}"
        );
    }

    #[test]
    fn downmix_stereo_averages_frames() {
        let out = downmix_to_mono(&[1.0, 0.0, 0.0, 1.0, 0.5, 0.5], 2);
        assert_eq!(out, vec![0.5, 0.5, 0.5]);
    }
}
