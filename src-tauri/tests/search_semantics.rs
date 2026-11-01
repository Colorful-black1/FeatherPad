use regex::{Regex, RegexBuilder};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    pattern: String,
    text: String,
    is_regex: bool,
    is_case_sensitive: bool,
    is_whole_word: bool,
    scope: Option<[usize; 2]>,
    expected: Vec<[usize; 2]>,
}

fn byte_offset(text: &str, utf16_offset: usize) -> usize {
    let mut consumed_units = 0;
    for (byte_index, character) in text.char_indices() {
        if consumed_units == utf16_offset {
            return byte_index;
        }
        consumed_units += character.len_utf16();
    }
    text.len()
}

fn utf16_offset(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].encode_utf16().count()
}

fn is_word_character(character: char) -> bool {
    character == '_' || character.is_alphabetic() || character.is_numeric()
}

fn has_word_boundaries(text: &str, start: usize, end: usize) -> bool {
    if start == end {
        return false;
    }
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    !before.is_some_and(is_word_character) && !after.is_some_and(is_word_character)
}

#[test]
fn local_worker_semantics_match_shared_rust_fixture() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../../tests/fixtures/search-semantics.json")).unwrap();
    for case in fixture.cases {
        let source = if case.is_regex {
            case.pattern.clone()
        } else {
            regex::escape(&case.pattern)
        };
        let regex: Regex = RegexBuilder::new(&source)
            .case_insensitive(!case.is_case_sensitive)
            .unicode(true)
            .build()
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let scope = case.scope.unwrap_or([0, case.text.encode_utf16().count()]);
        let start = byte_offset(&case.text, scope[0]);
        let end = byte_offset(&case.text, scope[1]);
        let mut actual = Vec::new();
        for matched in regex.find_iter(&case.text[start..end]) {
            let full_start = start + matched.start();
            let full_end = start + matched.end();
            if !case.is_whole_word || has_word_boundaries(&case.text, full_start, full_end) {
                actual.push([
                    utf16_offset(&case.text, full_start),
                    utf16_offset(&case.text, full_end),
                ]);
            }
        }
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}
