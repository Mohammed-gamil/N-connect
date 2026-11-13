pub const BACKOFF_SCHEDULE_SECS: [u64; 5] = [30, 120, 600, 1800, 7200];
pub const MAX_RETRY_DELAY_SECS: u64 = 14_400;

/// Computes the retry delay in seconds for a queue delivery attempt.
/// Uses `[30, 120, 600, 1800, 7200]` exponential backoff, respecting
/// `retry_after_secs` if larger, and clamped to `14400` seconds (4 hours).
pub fn backoff_seconds(attempt: u32, retry_after_secs: Option<u64>) -> u64 {
    let idx = (attempt.saturating_sub(1) as usize).min(BACKOFF_SCHEDULE_SECS.len() - 1);
    let base = BACKOFF_SCHEDULE_SECS[idx];
    let delay = match retry_after_secs {
        Some(ra) => base.max(ra),
        None => base,
    };
    delay.min(MAX_RETRY_DELAY_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule_matches_spec_and_respects_retry_after() {
        assert_eq!(backoff_seconds(0, None), 30);
        assert_eq!(backoff_seconds(1, None), 30);
        assert_eq!(backoff_seconds(2, None), 120);
        assert_eq!(backoff_seconds(3, None), 600);
        assert_eq!(backoff_seconds(4, None), 1800);
        assert_eq!(backoff_seconds(5, None), 7200);
        assert_eq!(backoff_seconds(6, None), 7200);

        // Smaller Retry-After does not shorten exponential backoff
        assert_eq!(backoff_seconds(2, Some(15)), 120);
        // Larger Retry-After is respected
        assert_eq!(backoff_seconds(1, Some(300)), 300);
        // Excessively large Retry-After is clamped to MAX_RETRY_DELAY_SECS
        assert_eq!(backoff_seconds(1, Some(86_400)), MAX_RETRY_DELAY_SECS);
    }
}
