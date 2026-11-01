use featherpad_lib::{
    models::{ErrorCode, Newline, NewlineMap, SaveRequest, TextFormat},
    services::{
        encode::encode_snapshot,
        text::{decode_basic, normalize_newlines},
    },
};

fn snapshot(text: &str, encoding: &str, bom: &str, eol: &str) -> SaveRequest {
    SaveRequest {
        document_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        document_version: 7,
        expected_disk_revision: "controlled revision".into(),
        text: text.into(),
        format: TextFormat {
            encoding: encoding.into(),
            bom: bom.into(),
            line_ending: eol.into(),
        },
        newline_map: None,
    }
}

#[test]
fn utf8_newline_and_bom_bytes_are_exact_including_empty_and_no_final_newline() {
    let plain = snapshot("中文😀\nlast", "utf-8", "none", "crlf");
    assert_eq!(
        encode_snapshot(&plain).unwrap(),
        "中文😀\r\nlast".as_bytes()
    );
    let bom = snapshot("中文😀\nlast\n", "utf-8", "utf8", "lf");
    assert_eq!(
        encode_snapshot(&bom).unwrap(),
        "\u{feff}中文😀\nlast\n".as_bytes()
    );
    assert_eq!(
        encode_snapshot(&snapshot("", "utf-8", "none", "crlf")).unwrap(),
        b""
    );
    assert_eq!(
        encode_snapshot(&snapshot("", "utf-8", "utf8", "crlf")).unwrap(),
        [0xef, 0xbb, 0xbf]
    );
}

#[test]
fn decoded_mixed_utf8_and_utf16_round_trip_without_changing_any_original_bytes() {
    let original = "中文😀\r\nsecond\nthird\rfinal";
    for encoding in ["utf-8", "utf-16le", "utf-16be"] {
        let mut golden = match encoding {
            "utf-8" => vec![0xef, 0xbb, 0xbf],
            "utf-16le" => vec![0xff, 0xfe],
            _ => vec![0xfe, 0xff],
        };
        if encoding == "utf-8" {
            golden.extend_from_slice(original.as_bytes());
        } else {
            for unit in original.encode_utf16() {
                golden.extend_from_slice(&if encoding == "utf-16le" {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
        }
        let decoded = decode_basic(&golden).unwrap();
        let (text, endings) = normalize_newlines(&decoded.text);
        let mut request = snapshot(&text, decoded.encoding, decoded.bom, "mixed");
        request.newline_map = Some(NewlineMap {
            document_version: 7,
            endings,
        });
        assert_eq!(encode_snapshot(&request).unwrap(), golden);
    }
}

#[test]
fn rejects_stale_incomplete_or_mislabelled_newline_maps_and_incompatible_bom() {
    let valid = snapshot("one\ntwo", "utf-8", "none", "lf");
    let mut candidates = vec![];
    for (version, endings) in [
        (6, vec![Newline::Lf]),
        (7, vec![]),
        (7, vec![Newline::Crlf]),
    ] {
        let mut request = valid.clone();
        request.newline_map = Some(NewlineMap {
            document_version: version,
            endings,
        });
        candidates.push(request);
    }
    let mut mixed_missing = valid.clone();
    mixed_missing.format.line_ending = "mixed".into();
    candidates.push(mixed_missing);
    let mut bom_mismatch = valid.clone();
    bom_mismatch.format.bom = "utf16le".into();
    candidates.push(bom_mismatch);
    let mut raw_cr = valid.clone();
    raw_cr.text = "one\r\ntwo".into();
    candidates.push(raw_cr);
    let mut unsafe_version = valid;
    unsafe_version.document_version = 9_007_199_254_740_992;
    candidates.push(unsafe_version);
    for request in candidates {
        assert_eq!(
            encode_snapshot(&request).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
    assert_eq!(
        encode_snapshot(&snapshot("中文", "gbk", "none", "lf"))
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
}

#[test]
fn save_wire_schema_rejects_unknown_fields_without_a_parallel_protocol() {
    let request = snapshot("fixture", "utf-8", "none", "lf");
    let mut value = serde_json::to_value(&request).unwrap();
    value["format"]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<SaveRequest>(value).is_err());
    let mut value = serde_json::to_value(&request).unwrap();
    value["path"] = serde_json::json!("ungranted.txt");
    assert!(serde_json::from_value::<SaveRequest>(value).is_err());
}
