use featherpad_lib::services::open_policy::{
    has_long_line, OpenPolicy, CHUNKED_THRESHOLD, FULL_READ_LIMIT, NORMAL_LIMIT,
};

#[test]
fn raw_byte_boundaries_preserve_the_product_two_twenty_and_hundred_mib_limits() {
    for (size, policy) in [
        (0, OpenPolicy::Normal),
        (NORMAL_LIMIT - 1, OpenPolicy::Normal),
        (NORMAL_LIMIT, OpenPolicy::Normal),
        (NORMAL_LIMIT + 1, OpenPolicy::Degraded),
        (CHUNKED_THRESHOLD - 1, OpenPolicy::Degraded),
        (CHUNKED_THRESHOLD, OpenPolicy::LargeReadOnly),
        (CHUNKED_THRESHOLD + 1, OpenPolicy::LargeReadOnly),
        (FULL_READ_LIMIT - 1, OpenPolicy::LargeReadOnly),
        (FULL_READ_LIMIT, OpenPolicy::LargeReadOnly),
        (FULL_READ_LIMIT + 1, OpenPolicy::HeadPreviewOnly),
    ] {
        assert_eq!(OpenPolicy::for_size(size), policy);
        assert_eq!(
            policy.editable_read_limit(),
            if size < CHUNKED_THRESHOLD {
                Some(CHUNKED_THRESHOLD - 1)
            } else {
                None
            }
        );
    }
}

#[test]
fn long_line_limit_counts_unicode_characters_and_resets_on_lf_crlf_and_cr() {
    assert!(!has_long_line(&"😀".repeat(100_000)));
    assert!(has_long_line(&"😀".repeat(100_001)));
    for ending in ["\n", "\r\n", "\r"] {
        assert!(!has_long_line(&format!(
            "{}{ending}{}",
            "中".repeat(50_001),
            "文".repeat(50_001)
        )));
    }
}
