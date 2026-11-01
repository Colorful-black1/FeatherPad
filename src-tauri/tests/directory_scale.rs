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
