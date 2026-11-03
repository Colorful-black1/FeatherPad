# 开发任务清单

当前阶段：**M0/G0、M1/G1、M2/G2 已通过（2026-11-03）；用户已确认继续，M3/T304进行中**。完整 v1 需要 M0–M5 全部 86 项必需功能，M1 只是可试用 MVP，不是成品。

2026-11-03 用户修订验收粒度：**以 M 为验收单元**。M 内各 T 只做实现和最小自检，不再每个 T 跑一遍大量测试；整个 M 的 T 全部完成后，统一执行一次全量回归、真实 Release 验收和矩阵证据汇总，通过后打勾并停止，等待用户确认后再推进下一阶段。M0 与 M1 的已完成任务产生于旧的逐任务策略，其逐项证据仍然有效，保存在 [PROGRESS](PROGRESS.md) 和 [M0验收](../docs/acceptance/M0.md)、[M1验收](../docs/acceptance/M1.md)（按 `T1xx` 检索即可定位）。

## 状态标记

- `[ ]` 未开始。
- `[~]` 实现中。
- `[x]` 实现完成并通过该任务的最小自检，**不代表功能已验收**。

功能验收只在所属 M 的统一验收通过后记录。M0/M1 已完成任务保留 `[x]` 和有旧策略下的逐项证据；M2 已通过 G2 并记录整阶段证据；M3–M5 的任务在各自关卡通过前，一律不得写成“已验收”。

## 验收策略（M 为验收单元）

一个 M 是一个大任务，下面若干 T 是它的实现步骤。**验收只在 M 结束时做一次。**

### T 完成时：最小自检（几分钟）

1. 改动涉及的模块能编译或通过类型检查：只改 TS 用 `pnpm exec tsc --noEmit`（或直接跑受影响测试）；只改 Rust 用 `cargo check --manifest-path src-tauri/Cargo.toml`；改了共享契约则两端都要过。
2. 新行为至少有 1 个能证明"它确实工作了"的定向用例：`pnpm exec vitest run <file>`、`cargo test --test <name>`，或该功能的 Web 用例。失败必须修完再往下，不能带着红测试堆功能。
3. 在 [PROGRESS](PROGRESS.md) 写 2–5 行：改了哪些文件、跑了什么、结果、留给 M 验收的待验点。

**这一层不做**：全量 `pnpm typecheck/lint/test/test:e2e`、Release 构建、`pnpm test:desktop:all`、大文件/满盘/强杀/性能专项、逐任务验收文档和截图。

### 高风险 T 的唯一例外

保存、删除/回收站、恢复/热退出、编码与换行转换、跨文件替换、预览与 HTML 安全清洗，这几类实现完成时**额外跑一条真实路径冒烟**（真实文件保存/删除/恢复一次并核对字节，5–10 分钟）。只做一条，不做故障矩阵；完整故障验证仍然留给 M 验收。理由是这类功能一旦地基写错，后面十几个 T 都建在坏数据路径上，返工成本高于一次冒烟。

### M 结束时：统一验收（一次）

执行下方 [M 统一验收清单](#m-统一验收清单) 全部项目，写出阶段报告，通过后该 M 关卡才打勾并推进下一阶段。

同一代码/构建已有的有效证据可以直接复用；只有相关改动、失败或未解决问题才扩大复测。不删除测试、不降低断言或性能门槛、不把待验写成通过。

## M 统一验收清单

每个 M 收尾时按顺序执行一次，全部 exit 0 并记录产物后才算该 M 通过。命令在 `. .\scripts\Enter-Dev.ps1` 之后运行。

### 1. 静态与单元

| 命令 | 覆盖 |
|---|---|
| `pnpm typecheck` | 全部 TS 类型 |
| `pnpm lint` | 全部 lint，0 warning |
| `pnpm test:unit` | 全部 TS 行为 |
| `pnpm test:integration` | Rust 原生磁盘/服务集成 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Rust 格式 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Rust lint |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust 全部测试 |

### 2. Web 回归

| 命令 | 覆盖 |
|---|---|
| `pnpm test:e2e` | 全部 Web 交互；mock 只证明 UI/bridge，不证明原生 IO |

Web 全量不要和 Release 编译并行跑（本机曾因此 `page.goto` 超时），先编译再跑 Web。

### 3. 真实 Release

```powershell
pnpm build
pnpm test:desktop:all
```

产物为 `src-tauri/target/release/featherpad.exe`，记录 bytes 与 SHA256。`test:desktop:all` 覆盖 regression 以及 mvp/tabs/commands/settings/recent/accessibility/text-preview/recovery/external 全部场景。新增的原生场景必须先加进该脚本，否则不算进入统一验收。

### 4. 阶段专项

按阶段选择，不随普通功能重复：

| 关卡 | 专项 |
|---|---|
| G1 | 真实大文件（<20MiB / ≥20MiB / >100MiB 预览）、满盘安全失败、强杀恢复、关闭保护 |
| G2 | 编码与混合换行 round-trip、10k 文件/100MiB 搜索与取消、跨文件替换中断与回滚、100k 目录 |
| G3 | Markdown 恶意 HTML/SVG/URL、离线 HTML 导出重开、真实多页 PDF、格式化异常退出 |
| G4 | 独立环境安装/卸载/便携、CLI 与单实例、关联 opt-in 与撤销、缺 WebView2 指引 |
| G5 | 全 86 项逐 ID 证据、故障矩阵、性能 10 样本 p95、发布材料 |

### 5. 收尾

- `node scripts/validate-docs.mjs` 通过（功能/任务/链接/依赖一致性）。
- 写 `docs/acceptance/<M>.md`：命令与 exit code、构建标识与 SHA256、Windows/WebView2 版本、真实/mock 范围、已知问题、未验项。
- 更新本文件该 M 关卡状态、[PROGRESS](PROGRESS.md) 状态行和 [功能矩阵](../docs/FEATURE-MATRIX.md) 对应 ID。
- 未达标继续修；不能把失败写成通过，也不能靠删测试或降阈值过关。

## 阶段验收状态

| 阶段 | 关卡 | 状态 | 说明 |
|---|---|---|---|
| M0 | G0 | 已通过（2026-11-01） | 真实 Tauri 与 Release 启动、测试通路建立，见 [M0验收](../docs/acceptance/M0.md) |
| M1 | G1 | 已通过（2026-11-03） | T101–T115 完成；34项feature ID统一验收通过，见 [M1验收](../docs/acceptance/M1.md) |
| M2 | G2 | 已通过（2026-11-03） | T201–T216 完成；29项feature ID统一验收通过，见 [M2验收](../docs/acceptance/M2.md) |
| M3 | G3 | 进行中 | 用户确认继续；T301实现中，G3待验 |
| M4 | G4 | 未开始 | 依赖 G3 |
| M5 | G5 | 未开始 | 依赖 G4 |

## M0 环境与骨架（依赖：无）

验收：G0 已通过；下列任务在旧逐任务策略下逐项验收，证据见 [PROGRESS](PROGRESS.md) 与 [M0验收](../docs/acceptance/M0.md)。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [x] T000 复核已有环境 | — | F-DESK-013 | 版本/组件实查，复用本机工具；新增目录仅 E 盘，Rust 最小编译成功 | scripts/Probe-Environment.ps1、scripts/Enter-Dev.ps1、scripts/Verify-NativeToolchain.ps1、docs/ENVIRONMENT.md |
| [x] T001 工程与锁文件 | T000 | F-DESK-013 | T001.a 精确依赖/脚本策略；T001.b 原生骨架/质量检查；bundler 工具缓存到 E 盘 | package.json、pnpm-lock.yaml、src-tauri/Cargo.toml、src-tauri/Cargo.lock、pnpm-workspace.yaml |
| [x] T002 壳层和品牌 | T001 | app-shell | 轻羽标题、布局、主题 token 和焦点框；亮暗与缩放可用 | src/app/App.tsx、src/shared/ui/Shell.tsx、src/styles/{tokens,app}.css、src/main.tsx |
| [x] T003 最小IPC与授权 | T001 | F-DESK-013 | a 授权 / b 有界读取 / c typed IPC / ACL / d 真实系统选取→只读 CodeMirror | src/bridge/、src/shared/contracts/files.ts、src-tauri/src/{commands,models}.rs、services/{grants,files}.rs、capabilities/main.json |
| [x] T004 测试与证据通路 | T002,T003 | F-DESK-013 | Web 与原生测试明确区分；fixture 隔离与测试脚本；失败能阻断 | vitest.config.ts、playwright.config.ts、tests/desktop/config.ts、tests/fixtures/README.md、scripts/check.ps1 |
| [x] T005 G0真实Release | T004 | F-DESK-013 | 真正窗口可启动；断网、无 dev server 也能运行 | tasks/PROGRESS.md、docs/ENVIRONMENT.md、package.json、src-tauri/tauri.conf.json |

## M1 MVP（依赖：G0）

验收：T101–T115 已完成，G1 于 2026-11-03 统一验收通过；34项feature ID、最终Release和证据见 [PROGRESS](PROGRESS.md) 与 [M1验收](../docs/acceptance/M1.md)。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [x] T101 文档身份与打开 | T005 | F-FILE-001..002,F-FILE-014..015 | a 原生身份/严格解码；b 唯一 CM 缓冲/新建多选；c 原生多选验收；binary/未知编码不误写 | src/features/editor/documents.ts、src/bridge/files.ts、src-tauri/src/services/{files,identity,grants}.rs |
| [x] T102 安全保存闭环 | T101 | F-FILE-003..005,F-FILE-009 | 保存/另存/副本/全部保存/覆盖/硬链接、进程终止与真实满盘安全失败 | src/features/editor/{save,save-all}.ts、src-tauri/src/commands/save.rs、src-tauri/src/services/{save,save_requests,create_file,save_as}.rs、tests/desktop/{forced-exit,disk-full}.ts |
| [x] T103 大文件模式 | T101 | F-FILE-013 | 完整 <20MiB 降级/长行、≥20MiB 单页分块、>100MiB 显式前 1MiB 预览、动态增长重判、片段保存/As/Copy 后端拒绝 | src-tauri/src/services/{open_policy,files,stream_snapshot}.rs、src/features/editor/{LargeFileView,EditorDocument}.tsx |
| [x] T104 单根目录树 | T101 | F-WORK-001,F-WORK-003 | 打开根、懒加载/分页/排序/刷新/当前文件定位，空和拒绝态完整 | src/features/workspace/Explorer.tsx、src/features/workspace/store.ts、src-tauri/src/services/directories.rs |
| [x] T105 树内变更 | T102,T104 | F-FILE-017,F-WORK-004..005 | 排他新建、不覆盖改名、仅回收站；dirty 保存/保护/取消，失败保树、缺失缓冲可另存 | src/features/workspace/{Explorer,TrashDialog}.tsx、src-tauri/src/services/{file_ops,trash,windows_trash,recovery}.rs |
| [x] T106 真实编辑内核 | T101 | F-EDIT-001..003,F-EDIT-008,F-EDIT-018 | CM 事务/undo/缩进/括号/高亮及手动语言，IME 正常 | src/features/editor/{documents,editor-state,EditorDocument,EditorStatus,editor-metrics,editor-language,language-loader}.ts/tsx |
| [x] T107 标签与关闭保护 | T102,T106 | F-EDIT-013,F-FILE-018 | 单组单预览、dirty 固定、关闭保存/放弃/取消不丢内容 | src/features/editor/{tabs,TabStrip,CloseDialog,close}.ts/tsx、src/app/App.tsx |
| [x] T108 文件内搜索替换 | T106 | F-SEARCH-001..003 | 一致正则/整词语法，选区范围、计数、替换单次 undo | src/features/search-tools/{FindBar,search-query}.ts/tsx、src/workers/find.worker.ts、tests/fixtures/search-semantics.json |
| [x] T109 命令入口与快捷键 | T107 | F-EDIT-017 | 统一注册/分发、命令与快速打开、重映射/冲突/焦点 | src/shared/commands/{keyboard,registry}.ts、src/shared/ui/CommandPalette.tsx、src/app/{register-commands,quick-candidates}.ts |
| [x] T110 恢复与热退出 | T102,T107 | F-FILE-010..011,F-DESK-011 | 周期快照/启动校验、事务副本、单组会话/授权/位置、退出 flush/失败/放弃 | src/features/desktop/、editor/recovery.ts、src-tauri/src/services/{recovery,session,session_grants,startup_storage,storage_budget}.rs |
| [x] T111 外部变化 | T102,T110 | F-FILE-008 | a 只读磁盘快照/接纳 lease；b 监听/聚焦与 clean 重载；c 脏冲突比较/保护重载/另存/覆盖 | src-tauri/src/services/{external,watch}.rs、src/features/editor/external-changes.ts、src/features/editor/ConflictBanner.tsx |
| [x] T112 设置与主题 | T002,T110 | F-DESK-001..002 | a 受保护设置存储/版本/损坏隔离；b 合并/导入预览/工作区允许项；c 主题/字体/编辑器即时预览；d 设置页 | src/features/desktop/settings.ts、src/features/desktop/SettingsDialog.tsx、src-tauri/src/services/settings.rs |
| [x] T113 最近记录 | T104,T112 | F-WORK-007 | 50 项去重、缺失修复、单删/清空，关闭记录后不再落盘 | src/features/workspace/RecentList.tsx、src/features/workspace/recent.ts |
| [x] T114 视图与无障碍 | T106,T112 | F-EDIT-012,F-DESK-010 | a 编辑器 Tab 焦点；b 字号缩放/区域导航；c 读屏/媒体/设置分类；d 相关 Release 与平台验收 | src/features/editor/view-settings.ts、src/shared/ui/focus-navigation.ts、src/styles/accessibility.css |
| [x] T115 G1 MVP验收 | T103,T105,T108..114 | M1全部 | 原生打开到保存恢复闭环；34项矩阵证据统一验收；Release与可试用包已保留 | tasks/PROGRESS.md、docs/acceptance/M1.md、.artifacts/T115/FeatherPad-M1-portable-935A3E54.zip |

## M2 效率与可靠性补齐（依赖：G1，2026-11-03 已通过）

验收：T201–T216 已全部完成，G2 于 2026-11-03 通过；29项feature ID、最终Release和专项证据见 [M2验收](../docs/acceptance/M2.md)。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [x] T201 编码与逐行换行 | T115 | F-FILE-006..007 | 所列编码 round-trip、原混合换行保留、转换 undo 与有损确认；定向及一条真实Release路径已自检，G2统一验收待阶段末 | src-tauri/src/services/encoding.rs、src/features/editor/line-endings.ts、src/features/editor/EncodingMenu.tsx |
| [x] T202 可选自动保存 | T201 | F-FILE-012 | 默认 off、1500ms 空闲保存；冲突暂停、无标题仅快照 | src/features/editor/autosave.ts、src/features/desktop/SettingsDialog.tsx |
| [x] T203 冲突对比 | T111,T201 | F-FILE-016 | 返回磁盘快照与 revision，对比后变动再次阻止旧授权覆盖 | src/features/editor/ConflictDiff.tsx、src-tauri/src/services/files.rs |
| [x] T204 多根/收藏/工作区文件 | T115 | F-WORK-002,F-WORK-008..009 | 根重排/移除不删 buffer，收藏独立，迁移相对路径/坏配置保护 | src/features/workspace/roots.ts、src/features/workspace/FavoriteList.tsx、src/features/workspace/workspace-file.ts |
| [x] T205 排除/监听/链接遍历 | T204 | F-WORK-010..012 | ignore 规则可见，默认不跟链接，启用后 visited/越界授权；watch 溢出重扫 | src-tauri/src/services/walker.rs、src-tauri/src/services/search.rs、src/features/workspace/sync.ts、src/features/workspace/filters.ts |
| [x] T206 拖放与移动 | T105,T204 | F-WORK-006 | 外部拖入打开；内部移动确认/碰撞/跨卷结果不伪原子 | src/features/workspace/drag-drop.ts、src-tauri/src/services/file_ops.rs |
| [x] T207 标签/双分栏 | T115 | F-EDIT-014..015 | 拖排重开批量关闭，最多两组同文档共 buffer/undo 独立视图 | src/features/editor/tabs.ts、src/features/editor/TabStrip.tsx、src/features/editor/editor-state.ts |
| [x] T208 常用编辑操作 | T115 | F-EDIT-004,F-EDIT-007,F-EDIT-009..011 | 注释/行移动复制/词补全/空白/折叠，未知语言禁用解释 | src/features/editor/editing.ts、src/features/editor/EditorDocument.tsx |
| [x] T209 多光标与列选择 | T208 | F-EDIT-005..006 | AltClick/下个相同词、矩形选择和 IME/Tab 宽字符规则 | src/features/editor/editing.ts、src/features/editor/EditorDocument.tsx |
| [x] T210 导航与大纲接口 | T207 | F-EDIT-016 | 文件/行列/前后导航/面包屑；无 LSP 的大纲扩展槽 | src/features/editor/navigation.ts、src/features/editor/GoToLineDialog.tsx、src/features/editor/OutlineDialog.tsx、src/features/editor/Breadcrumbs.tsx |
| [x] T211 增量目录搜索 | T108,T205 | F-SEARCH-004..006 | 多根过滤/进度/取消/结果限额，dirty 语义明确，旧结果丢弃 | src-tauri/src/services/search.rs、src/features/search-tools/WorkspaceSearchPanel.tsx、src/bridge/search.ts |
| [x] T212 跨文件替换计划 | T203,T211 | F-SEARCH-007 | 逐文件不可变预览、版本与风险、dirty 排除可见，未确认零写入 | src-tauri/src/services/replace_plan.rs、src/features/search-tools/ReplacePreviewDialog.tsx |
| [x] T213 提交/恢复记录 | T212 | F-SEARCH-008..009 | 二次确认、写前备份、冲突停止并列部分结果，回滚不覆盖新修改 | src-tauri/src/services/replace_plan.rs、src/features/search-tools/ReplaceResult.tsx、tests/desktop/reliability.spec.ts |
| [x] T214 快捷键定制与全局唤起 | T109,T112 | F-DESK-003 | 应用内映射可编辑冲突检测；全局默认 off、失败反馈和释放 | src/shared/commands/keyboard.ts、src-tauri/src/global_shortcut.rs、scripts/Test-GlobalShortcut.ps1 |
| [x] T215 隐私管理 | T110,T113 | F-DESK-004 | 最近/恢复/收藏独立清理，唯一未保存副本保护，无遥测 | src/features/desktop/privacy.ts、src/features/desktop/SettingsDialog.tsx、src-tauri/src/services/recovery.rs |
| [x] T216 G2效率验收 | T201..215 | M2全部 | G2 专项通过，效率操作与数据安全无回归，输入/大目录开始基准 | tasks/PROGRESS.md、docs/acceptance/M2.md |

## M3 Markdown与工具（依赖：G2）

验收：本表全部 `[x]` 后，一次性执行 [M 统一验收清单](#m-统一验收清单) 的 G3 项，通过则 G3 打勾。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [x] T301 Markdown三模式 | T216 | F-MD-001..002 | source/read/split 共 buffer，GFM 渲染，双组布局不改源码 | src/features/markdown/MarkdownView.tsx、src/workers/markdown.worker.ts、src/features/markdown/parser.ts |
| [x] T302 代码块/任务编辑 | T301 | F-MD-003,F-MD-011 | 高亮复制安全；勾任务定位原始节点，一次 undo，旧映射不可改 | src/features/markdown/code-block.ts、src/features/markdown/task-mapping.ts |
| [x] T303 安全资源和链接 | T301 | F-MD-004,F-MD-006..007 | 相对资源授权、远程默认阻止、受限 HTML 清洗、危险协议拒绝 | src/features/markdown/sanitize.ts、src/features/markdown/links.ts、src-tauri/src/services/assets.rs |
| [~] T304 目录与同步滚动 | T302 | F-MD-005,F-MD-008 | H1-6 稳定锚点、源映射、版本取消，大文档降级 | src/features/markdown/Outline.tsx、src/features/markdown/source-map.ts、src/features/markdown/scroll-sync.ts |
| [ ] T305 HTML导出 | T303,T304 | F-MD-009 | 实际离线独立 HTML，安全资源内嵌、覆盖确认与失败保护 | src/features/markdown/export-html.ts、src-tauri/src/services/export.rs |
| [ ] T306 PDF导出spike和实现 | T305 | F-MD-010 | WebView2 生成真 PDF，纸张方向边距，中文分页/取消失败 | src-tauri/src/platform/windows/pdf.rs、src/features/markdown/ExportDialog.tsx |
| [ ] T307 JSON/XML/Web格式化 | T216 | F-SEARCH-010 | Worker 按需 parser、JSONC 注释、格式一次 undo、解析错定位且不执行代码 | src/workers/format.worker.ts、src/features/search-tools/formatters.ts、src/features/search-tools/format.ts |
| [ ] T308 SQL/YAML格式化 | T307 | F-SEARCH-011 | SQL 显式方言；YAML 注释锚点多文档保真，Java 无伪 formatter | src/features/search-tools/formatters-sql.ts、src/features/search-tools/formatters-yaml.ts |
| [ ] T309 文本变换 | T208,T307 | F-SEARCH-012 | 排序去重大小写清尾空白等，选区明确、预览 undo、不隐式改编码 | src/features/search-tools/text-transforms.ts、src/features/search-tools/TransformPreview.tsx |
| [ ] T310 双文件diff与安全预览 | T203,T303 | F-EDIT-019..020 | 只读 diff 差异导航；图像尺寸/缩放、安全 SVG 和解码上限；HTML 静态隔离预览不执行脚本/联网/IPC 且不改源码 | src/features/editor/DiffView.tsx、src/features/editor/ImageView.tsx、src/features/editor/HtmlPreview.tsx、src-tauri/src/services/images.rs |
| [ ] T311 G3内容体验验收 | T301..310 | M3全部 | 原型体验落到真实文件，安全/导出/格式化证据完整 | tasks/PROGRESS.md、docs/acceptance/M3.md |

## M4 桌面完善（依赖：G3）

验收：本表全部 `[x]` 后，一次性执行 [M 统一验收清单](#m-统一验收清单) 的 G4 项，通过则 G4 打勾。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [ ] T401 单实例/多窗口/CLI | T311 | F-DESK-007..008 | 单实例路由、同文件写所有权、CLI new/reuse/goto/wait 正确 | src-tauri/src/services/windows.rs、src-tauri/src/services/cli.rs、src/features/desktop/windows.ts |
| [ ] T402 安装/升级/卸载 | T401 | F-DESK-005 | 用户级安装真实可用，缺 runtime 离线指引、不删文档/未确认恢复 | src-tauri/tauri.conf.json、src-tauri/windows/installer.nsi、scripts/package.ps1 |
| [ ] T403 便携数据模式 | T402 | F-DESK-006 | portable.flag 决定同级 data，不可写报错/选择；与安装版隔离 | src-tauri/src/services/data_dir.rs、scripts/package.ps1 |
| [ ] T404 系统集成选择加入 | T402 | F-DESK-009 | 关联/右键显式选择，可撤销只清自有项、遵守系统限制 | src-tauri/src/platform/windows/associations.rs、src/features/desktop/IntegrationSettings.tsx |
| [ ] T405 G4可分发验收 | T401..404 | M4全部 | 包能独立启动/工作/恢复/退出，路径与证据清楚 | docs/acceptance/M4.md、tasks/PROGRESS.md |

## M5 完整v1验收（依赖：G4）

验收：本表全部 `[x]` 后，一次性执行 [M 统一验收清单](#m-统一验收清单) 的 G5 项；这是全项目最终统一验收。

| 状态/任务 | 依赖 | 功能追踪 | 交付内容与验收点 | 主要规划文件（非穷举） |
|---|---|---|---|---|
| [ ] T501 Release性能 | T405 | F-DESK-012 | 冷热启动/全树私有内存/输入/目录/搜索/预览/包大小达到预算 | tests/benchmarks/runner.ts、scripts/bench.ps1、docs/acceptance/performance.md |
| [ ] T502 故障安全回归 | T501 | F-DESK-012,全部数据安全ID | 实际强杀/磁盘满/锁定/外部变化/恶意预览/坏清单无未解严重问题 | tests/integration/faults/、tests/desktop/recovery/、docs/acceptance/faults.md |
| [ ] T503 全矩阵和兼容验收 | T502 | 全部86项 | 每 ID 有实现+证据；Win10/11 目标核查；无 TODO/mock 伪完成 | docs/FEATURE-MATRIX.md、docs/acceptance/v1.md、tasks/PROGRESS.md |
| [ ] T504 内部发布材料 | T503 | F-DESK-012 | 便携/安装包、hash、许可证、指南/恢复说明/已知问题，未签名状态明确 | docs/USER-GUIDE.md、docs/RELEASE-NOTES.md、THIRD-PARTY-NOTICES.md、scripts/release.ps1 |

## 完整性规则

任务表共 57 个工作单元（T000..005、T101..115、T201..216、T301..311、T401..405、T501..504；实际数量由 `scripts/validate-docs.mjs` 校验）。最后一个任务完成之前不得宣称完整 v1。

任务状态与功能验收分离：`[x]` 只代表实现完成和最小自检通过，功能 ID 的验收证据在所属 M 统一验收时汇总。完整功能可由多个任务共同实现，一个任务完成也不能代替矩阵逐 ID 证据。

阶段推进以 M 关卡为准：M 内所有 T 为 `[x]` 且该 M 统一验收通过，才把关卡标为已通过并进入下一阶段。并行任务不得同时编辑同一个文件，约定接口后各自提交，再由集成人完成原生关卡。若依赖范围写 `T108..114`，包含 108 到 114；不隐式补齐不存在的任务。
