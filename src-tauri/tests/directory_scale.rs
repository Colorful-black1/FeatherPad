#![cfg(windows)]

use featherpad_lib::{
    models::ListDirectoryRequest,
    services::{files::FileService, grants::GrantKind},
};
use std::{
    fs::{self, File},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FILE_COUNT: usize = 100_000;
const FIRST_PAGE_BUDGET: Duration = Duration::from_millis(300);

#[test]
#[ignore = "M5 ten-sample directory benchmark; retains its controlled corpus and raw evidence"]
fn ten_samples_of_100k_direct_children_keep_the_existing_budget() {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts/T501")
        .join(format!("directory-{}", uuid::Uuid::new_v4()));
    let root = evidence.join("corpus");
    fs::create_dir_all(&root).unwrap();
    for index in 0..FILE_COUNT {
        File::create(root.join(format!("item-{index:06}.txt"))).unwrap();
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), FILE_COUNT);
    let mut samples = Vec::new();
    for _ in 0..10 {
        let mut service = FileService::default();
        let reference = service
            .grants
            .register_selection(&root, GrantKind::Directory)
            .unwrap();
        let started = Instant::now();
        let page = service
            .list_directory(ListDirectoryRequest {
                reference,
                cursor: None,
                limit: None,
                show_hidden: false,
            })
            .unwrap();
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(page.items.len(), 200);
        assert!(page.next_cursor.is_some());
        assert_eq!(page.items.first().unwrap().name, "item-000000.txt");
        assert_eq!(page.items.last().unwrap().name, "item-000199.txt");
    }
    let mut ordered = samples.clone();
    ordered.sort_by(f64::total_cmp);
    let p95 = ordered[(0.95_f64 * ordered.len() as f64).ceil() as usize - 1];
    let report = serde_json::json!({
        "scope": "Release native service, fresh FileService for each sample, OS cache not cleared; excludes GUI paint",
        "fixtureFileCount": FILE_COUNT, "pageItemCount": 200, "nextCursorIssued": true,
        "samplesMs": samples, "p50Ms": ordered[4], "p95Ms": p95,
        "maxMs": ordered.last().unwrap(), "budgetMs": FIRST_PAGE_BUDGET.as_millis(),
        "corpusRetained": true,
    });
    fs::write(
        evidence.join("directory.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Directory evidence: {}", evidence.display());
    assert!(
        p95 < FIRST_PAGE_BUDGET.as_secs_f64() * 1000.0,
        "100k first-page p95 {p95:.3}ms exceeds the existing 300ms budget"
    );
}

struct ControlledRoot {
    artifact_root: PathBuf,
    path: PathBuf,
}

impl Drop for ControlledRoot {
    fn drop(&mut self) {
        if self.path.parent() == Some(self.artifact_root.as_path())
            && self
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("scale-"))
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[test]
#[ignore = "100k direct-child scale evidence; run explicitly in release"]
fn first_page_of_100k_direct_children_stays_within_budget() {
    let artifact_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".artifacts")
        .join("T104");
    fs::create_dir_all(&artifact_root).unwrap();
    let root = artifact_root.join(format!("scale-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let fixture = ControlledRoot {
        artifact_root: artifact_root.clone(),
        path: root.clone(),
    };

    for index in 0..FILE_COUNT {
        File::create(root.join(format!("item-{index:06}.txt"))).unwrap();
    }

    let mut service = FileService::default();
    let reference = service
        .grants
        .register_selection(&root, GrantKind::Directory)
        .unwrap();
    let started = Instant::now();
    let page = service
        .list_directory(ListDirectoryRequest {
            reference,
            cursor: None,
            limit: None,
            show_hidden: false,
        })
        .unwrap();
    let elapsed = started.elapsed();

    assert_eq!(page.items.len(), 200);
    assert!(page.next_cursor.is_some());
    assert_eq!(
        page.items.first().map(|entry| entry.name.as_str()),
        Some("item-000000.txt")
    );
    assert_eq!(
        page.items.last().map(|entry| entry.name.as_str()),
        Some("item-000199.txt")
    );

    let observed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let report = format!(
        "{{\n  \"observedAtUnixSeconds\": {observed_at},\n  \"fixtureFileCount\": {FILE_COUNT},\n  \"pageItemCount\": {},\n  \"elapsedMs\": {:.3},\n  \"budgetMs\": {},\n  \"nextCursorIssued\": {}\n}}\n",
        page.items.len(),
        elapsed.as_secs_f64() * 1_000.0,
        FIRST_PAGE_BUDGET.as_millis(),
        page.next_cursor.is_some(),
    );
    fs::write(artifact_root.join("directory-scale.json"), report).unwrap();
    drop(fixture);

    assert!(
        elapsed < FIRST_PAGE_BUDGET,
        "100k direct-child first page took {:.3}ms; budget is {}ms",
        elapsed.as_secs_f64() * 1_000.0,
        FIRST_PAGE_BUDGET.as_millis()
    );
}
