# Controlled test fixtures

All tests use generated, owned fixtures under `.artifacts/` in this repository.
Never pass a user document to fault injection, deletion, replacement, or corruption tests.

- Rust integration tests create a unique UUID directory per case under `.artifacts/T003/`. `authorized` and sibling `outside` are both test-owned; a real Windows junction intentionally points between them to prove grant rejection.
- No recursive cleanup is performed by these tests. Any future cleanup must resolve and validate the absolute test root before deleting, and must not traverse a junction target.
- Web tests explicitly identify their mock bridge. Plain browser mode produces a visible IPC error; it never synthesizes successful native file operations.
- Desktop tests spawn a real compiled Tauri binary and attach to its real WebView2 using CDP. Only this child gets a loopback debug port and an isolated E-drive WebView profile; no production test IPC is registered.
- The default desktop test includes the real OS picker: it creates a Chinese/space-named file with a random marker, selects it through native Win32 dialog controls, checks CodeMirror contents and confirms the original hash is unchanged. The helper verifies the exact fixture root/hash, executable/hash, PID and parent test worker before acting. A foreign-worker manifest is rejected before touching controls. No production IPC or grants are mocked.
- `FEATHERPAD_CHOOSER_AUTOMATION=manual` waits for a person to select the generated file recorded in `.artifacts/T002/chooser-fixture.json`. `FEATHERPAD_VERIFY_CHOOSER=0` explicitly limits a run to shell/IPC checks and records `nativeChooserVerified:false`; such a run cannot satisfy the G0 picker acceptance. A timeout is a failure, never a skip or pass.
- Default `pnpm test:desktop` targets the Release binary; `FEATHERPAD_DESKTOP_PROFILE=debug` explicitly selects a dev build (requires the local dev server). The result JSON states which profile and executable hash was tested.
