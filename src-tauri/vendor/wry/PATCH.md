# FeatherPad scoped Windows initialization patch

Upstream: Wry 0.57.1, reused from the existing Cargo registry cache; upstream
repository: https://github.com/tauri-apps/wry. The original MIT and Apache-2.0
license texts are retained. This directory has no independent lockfile.
The registry archive SHA256 in the original Cargo.lock is
`759c50ddad0ef9913bb5496cb9d509a50433a3b78cb0238d61105526589cf0e9`.

The upstream Windows implementation ignores `for_main_frame_only` when adding
document-created scripts. Tauri consequently injects its bridge and invoke key
into sandboxed Markdown frames. The FeatherPad patch guards initialization
scripts marked main-frame-only with `window === window.top` before execution.
Wry's own `window.ipc` wrapper is also scoped to the main frame; it previously
exposed a native-message entry point independently of Tauri's bridge scripts.
Scripts explicitly requested for all frames remain unchanged. Upstream source
files, examples and build script are otherwise preserved; the upstream README
is stored as `UPSTREAM-README.txt` and the manifest readme path follows it.

Regression: `tests/desktop/markdown.spec.ts` asserts the actual Release frame
has no `__TAURI_INTERNALS__` or Wry `ipc`, cannot read the parent, runs no document scripts
or remote image requests, and preserves the real source bytes and undo history.
This assertion failed on the unpatched runtime. Host native chooser/settings
and editor operation are exercised in that same path. Full G3 desktop regression
remains required. Remove this patch only when an upstream replacement passes
the same unchanged security assertions.

`tests/desktop/content.spec.ts` additionally checks the actual HTML static frame
has neither bridge. This caught the separate Wry wrapper during T310 even after
the original main-frame script fix. Native host commands remain covered by both
Release tests.
