use std;
use rand::Rng;
use rand::distributions::StandardNormal;
use rand::seq::SliceRandom;


const PERCENTAGE_MAX: f64 = 1.0 + std::f64::EPSILON;


fn rand() -> f64 {
    rand::thread_rng().gen::<f64>()
}

// TODO verify that this is correct
pub fn bool() -> bool {
    rand::thread_rng().gen::<bool>()
}

pub fn shuffle<A>(slice: &mut [A]) {
    slice.shuffle(&mut rand::thread_rng())
}

pub fn gaussian() -> f64 {
    rand::thread_rng().sample(StandardNormal)
}

// TODO verify that this is correct
pub fn percentage() -> f64 {
    rand() * PERCENTAGE_MAX
}

// TODO verify that this is correct
pub fn between_exclusive(min: u32, max: u32) -> u32 {
    let range = (max - min) as f64;
    let x = (rand() * range).floor() as u32;
    x + min
}

// TODO verify that this is correct
pub fn between_inclusive(min: u32, max: u32) -> u32 {
    let range = ((max - min) + 1) as f64;
    let x = (rand() * range).floor() as u32;
    x + min
}


#[cfg(test)]
mod tests {
    use super::*;
    use rand::{SeedableRng, rngs::StdRng};

    #[test]
    fn test_gaussian() {
        // Exercise the production wrapper without imposing a bounded support
        // on a normal distribution. Distribution checks below use a fixed RNG.
        for _ in 0..1024 {
            let value = gaussian();
            assert!(value.is_finite(), "non-finite Gaussian sample: {}", value);
        }
    }

    #[test]
    fn test_standard_normal_distribution() {
        const SAMPLES: usize = 1_000_000;
        // This seed includes a legitimate sample above +6 with the locked rand
        // version, reproducing the old test's invalid hard-bound assertion.
        let mut rng = StdRng::seed_from_u64(755);
        // Standard-normal CDF values; the outer buckets include all tails.
        let cdf = [
            (-3.0, 0.0013498980316301),
            (-2.0, 0.0227501319481792),
            (-1.0, 0.1586552539314571),
            (0.0, 0.5),
            (1.0, 0.8413447460685429),
            (2.0, 0.9772498680518208),
            (3.0, 0.9986501019683699),
        ];
        let mut counts = [0usize; 7];
        let mut sum = 0.0;
        let mut sum_squares = 0.0;

        for _ in 0..SAMPLES {
            let value: f64 = rng.sample(StandardNormal);
            assert!(value.is_finite(), "non-finite Gaussian sample: {}", value);
            sum += value;
            sum_squares += value * value;
            for (count, &(threshold, _)) in counts.iter_mut().zip(cdf.iter()) {
                if value <= threshold {
                    *count += 1;
                }
            }
        }

        let n = SAMPLES as f64;
        let mean = sum / n;
        let variance = (sum_squares - sum * mean) / (n - 1.0);
        // Six standard errors for N(0, 1): mean SE = 1/sqrt(n),
        // unbiased sample variance SE = sqrt(2/(n - 1)).
        assert!(mean.abs() < 6.0 / n.sqrt(), "mean: {}", mean);
        assert!((variance - 1.0).abs() < 6.0 * (2.0 / (n - 1.0)).sqrt(),
                "variance: {}", variance);

        // Check shape and both tails, beyond just the first two moments.
        // Each cumulative count has binomial SE = sqrt(n*p*(1-p)).
        for (&count, &(threshold, probability)) in counts.iter().zip(cdf.iter()) {
            let expected = n * probability;
            let tolerance = 6.0 * (n * probability * (1.0 - probability)).sqrt();
            assert!((count as f64 - expected).abs() < tolerance,
                    "CDF at {}: got {}, expected {} +/- {}",
                    threshold, count, expected, tolerance);
        }
    }
}
