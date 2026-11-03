use featherpad_lib::services::preview_links::{open_external_url, validate_external_url};

#[test]
fn only_explicitly_confirmed_safe_uri_schemes_can_reach_the_os_handler() {
    for input in [
        "javascript:alert(1)",
        "shell:calc",
        "file:///C:/secret",
        "https://user:password@example.com",
        "mailto://server/share",
        "https://example.com/\" --flag",
        "https://example.com/\n",
        "\\\\server\\file",
    ] {
        assert!(validate_external_url(input, true).is_err(), "{input}");
        assert!(open_external_url(input, false).is_err());
    }
    assert_eq!(
        validate_external_url("https://example.com/中文", true).unwrap(),
        "https://example.com/%E4%B8%AD%E6%96%87"
    );
    assert_eq!(
        validate_external_url("mailto:author@example.com", true).unwrap(),
        "mailto:author@example.com"
    );
    assert!(open_external_url("https://example.com", false).is_err());
}
