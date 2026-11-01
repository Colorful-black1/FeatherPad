# 开发任务清单

当前阶段：**M0/G0已通过，开始M1**。`[ ]` 待做，`[~]` 进行中，`[x]` 通过验收。禁止仅因代码存在就打勾；关联 [计划](plan.md)、[进度](PROGRESS.md) 与 [完整功能矩阵](../docs/FEATURE-MATRIX.md)。范围写 `F-FILE-001..005` 表示含端点的连续ID。
执行更新（2026-11-01）：T000–T005/G0、T101与T103通过；T102除真实磁盘满外已完成。T103已用真实Release验证2/20/100MiB边界、分块/限量预览、动态增长和片段保存拒绝。下一项T104单根目录树；G1尚未通过，不代表MVP或完整v1。

## 执行约定

每次选择一个依赖已完成的任务，先读其模块规格，再实现最小切片；表内文件是**未来规划路径**，不存在时在M0约定的结构下创建。一个任务超过约5个生产文件时先拆`.a/.b`并保留追踪。测试文件与fixtures不受机械数量限制。

验证简称（M0实际建立脚本后使用）：

- **Q**：`pnpm typecheck`、`pnpm lint`、对应 `pnpm test:unit` / `pnpm test:integration`；所有命令检查exit code。
- **R**：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`、`cargo test --manifest-path src-tauri/Cargo.toml`。
- **W**：`pnpm test:e2e`（Web mock，只验证UI/bridge调用）。
- **D**：真实Windows Tauri：`pnpm test:desktop`，并执行任务指定的手动场景；不可用时在PROGRESS记录原因及原生人工证据，不能声称自动化已通过。
- **B**：`pnpm build`，运行实际Release产物，记录路径与sha256。
- **P**：`pnpm bench:app`，固定版本/机器/夹具，10次样本取p95，完整进程树统计。

Q/R/W/D/B命令已建立；具体通过范围见PROGRESS，命令存在不等于产品验收通过。P（bench:app）仍待创建。

## M0 环境与骨架（依赖：无）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件（非穷举） | 验证 |
|---|---|---|---|---|---|
| [x] T000 复核已有环境 | — | F-DESK-013 | 版本/组件实查，复用本机工具；新增目录仅E盘，Rust最小编译成功 | scripts/Probe-Environment.ps1、scripts/Enter-Dev.ps1、scripts/Verify-NativeToolchain.ps1、docs/ENVIRONMENT.md | 2026-11-01 探针及原生编译运行exit 0；见PROGRESS |
| [x] T001 工程与锁文件 | T000 | F-DESK-013 | T001.a精确依赖/脚本策略；T001.b原生骨架/质量检查；bundler工具缓存到E盘 | package.json、pnpm-lock.yaml、src-tauri/Cargo.toml、src-tauri/Cargo.lock、pnpm-workspace.yaml | 最终冻结离线安装、TS/lint/Web构建、Rust fmt/clippy/test exit 0；audit仅1条开发工具moderate已记录可达性；见M0验收 |
| [x] T002 壳层和品牌 | T001 | app-shell | 轻羽标题、布局、主题token和焦点框；亮暗/缩放可用 | src/app/App.tsx、src/shared/ui/Shell.tsx、src/styles/{tokens,app}.css、src/main.tsx | TS/lint、2项Web测试、1项真实Tauri WebView2测试exit 0；原生内容区1200×800截图；CSS200%通过，OS缩放留T114 |
| [x] T003 最小IPC与授权 | T001 | F-DESK-013 | a授权/b有界读取/c typed IPC/ACL/d真实系统选取→只读CM全部验证 | src/bridge/、src/shared/contracts/files.ts、src-tauri/src/{commands,models}.rs、services/{grants,files}.rs、capabilities/main.json | 2026-11-01 全量检查exit 0：TS3/Rust原生5/Web4/真实Release1（系统选择器随机fixture及错误worker拒绝）；旧CU失败保留历史 |
| [x] T004 测试与证据通路 | T002,T003 | F-DESK-013 | Web与原生测试明确区分；建立fixture隔离与测试脚本 | vitest.config.ts、playwright.config.ts、tests/desktop/config.ts、tests/fixtures/README.md、scripts/check.ps1 | 各跑一个有意义的正/负例；确认测试失败能阻断 |
| [x] T005 G0真实Release | T004 | F-DESK-013 | 真正窗口可启动；断网无dev server也运行 | tasks/PROGRESS.md、docs/ENVIRONMENT.md、package.json、src-tauri/tauri.conf.json | Q/R/B、原生启动证据；G0通过后继续 |

## M1 MVP（依赖：G0）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件 | 验证 |
|---|---|---|---|---|---|
| [x] T101 文档身份与打开 | T005 | F-FILE-001..002,F-FILE-014..015 | a原生身份/严格解码；b唯一CM缓冲/新建多选；c原生多选验收；binary/未知编码不误写 | src/features/editor/documents.ts、src/bridge/files.ts、src-tauri/src/services/{files,identity,grants}.rs | 初验check.ps1 -Desktop exit 0；授权单项失败补正后TS31/Rust39/Web全量12+定向3/真实Release1及typecheck/lint/fmt/clippy/build exit 0；真实授权保其他成功项，Web失败不清buffer。见M1验收；手动编码/只读试开由T103/T201追踪 |
| [~] T102 安全保存闭环 | T101 | F-FILE-003..005,F-FILE-009 | 保存/另存/副本/全部保存/覆盖/硬链接已验；新增保存进程终止，真实磁盘满待权限 | src/features/editor/{save,save-all}.ts、src-tauri/src/commands/save.rs、src-tauri/src/services/{save,save_requests,create_file,save_as}.rs、tests/desktop/forced-exit.ts | 最新Rust46/fmt/clippy、typecheck/lint/真实Release1 exit0；Rust替换前/提交后强杀+放行正控，真实Tauri提交后Ack前终止再核对磁盘。历史TS31/Web13/构建保留。64MiB VHD创建权限拒绝，磁盘满不标通过；先推进T103，见M1验收 |
| [x] T103 大文件模式 | T101 | F-FILE-013 | 完整<20MiB降级/长行、≥20MiB单页分块、>100MiB显式前1MiB预览、动态增长重判、片段保存/As/Copy后端拒绝 | src-tauri/src/services/{open_policy,files,stream_snapshot}.rs、src/features/editor/{LargeFileView,EditorDocument}.tsx | TS33/Web16/Rust61/clippy/fmt/typecheck/lint/build exit0；真实Release1 exit0。原生20MiB分块前后页、100MiB+1显式预览、哈希不变；测量首屏上界1.12s/预览动作0.36s，进程树348–444MiB超M5目标，M5继续复核。见M1验收 |
| [ ] T104 单根目录树 | T101 | F-WORK-001,F-WORK-003 | 打开根、懒加载/分页/排序/刷新/当前文件定位，空和拒绝态完整 | src/features/workspace/Explorer.tsx、src/features/workspace/store.ts、src-tauri/src/services/directories.rs | Q/R/W/D：空目录、无权限、100k文件首层 |
| [ ] T105 树内变更 | T102,T104 | F-FILE-017,F-WORK-004..005 | 新建/重命名/回收站，dirty决策、保留名/碰撞/失败无假成功 | src/features/workspace/file-actions.ts、src/features/workspace/EntryInput.tsx、src-tauri/src/services/file_ops.rs | Q/R/D：失败不移除树项、无永久删除回退 |
| [ ] T106 真实编辑内核 | T101 | F-EDIT-001..003,F-EDIT-008,F-EDIT-018 | CM事务/undo/缩进/括号/高亮及手动语言，IME正常 | src/features/editor/Editor.tsx、src/features/editor/extensions.ts、src/features/editor/languages.ts、src/features/editor/status.ts | Q/W/D：中文输入法、选区粘贴、undo和保存历史 |
| [ ] T107 标签与关闭保护 | T102,T106 | F-EDIT-013,F-FILE-018 | 每组单预览、dirty固定、关闭保存/放弃/取消不丢内容 | src/features/editor/tabs.ts、src/features/editor/TabStrip.tsx、src/features/editor/close.ts | Q/W/D：预览复用、取消、保存失败、放弃清理恢复 |
| [ ] T108 文件内搜索替换 | T106 | F-SEARCH-001..003 | 一致正则/整词语法，选区范围、计数、替换单次undo | src/features/search-tools/FindBar.tsx、src/features/search-tools/pattern.ts、src/workers/find.worker.ts | Q/W/D：Unicode、零长度、非法式、捕获组、只读 |
| [ ] T109 命令入口与快捷键 | T107 | F-EDIT-017 | CtrlP/CtrlShiftP/快捷键全指向同一命令注册，启用态/焦点正确 | src/shared/commands/registry.ts、src/shared/ui/CommandPalette.tsx、src/app/register-commands.ts | Q/W/D：键盘循环/冲突提示/Escape恢复焦点 |
| [ ] T110 恢复与热退出 | T102,T107 | F-FILE-010..011,F-DESK-011 | 草稿与dirty快照真实落盘，退出等flush，损坏隔离，恢复不覆盖源 | src/features/desktop/session.ts、src-tauri/src/services/recovery.rs、src-tauri/src/services/session.rs、src/features/desktop/RecoveryPanel.tsx | Q/R/D：强杀/重启、恢复文件变化、flush失败、未命名 |
| [ ] T111 外部变化 | T102,T110 | F-FILE-008 | clean重载/dirty横幅、外部删除可另存、聚焦补stat | src-tauri/src/services/watch.rs、src/features/editor/external-changes.ts、src/features/editor/ConflictBanner.tsx | Q/R/D：外部编辑/rename/delete/watch溢出 |
| [ ] T112 设置与主题 | T002,T110 | F-DESK-001..002 | 搜索/优先级/导入导出/重置、schema错误恢复、亮暗系统字体 | src/features/desktop/settings.ts、src/features/desktop/SettingsDialog.tsx、src-tauri/src/services/settings.rs | Q/R/W/D：坏JSON、字体不存在、200%缩放 |
| [ ] T113 最近记录 | T104,T112 | F-WORK-007 | 50项去重、缺失修复、单删/清空和关闭记录不再落盘 | src/features/workspace/RecentList.tsx、src/features/workspace/recent.ts | Q/R/W：上限和隐私关闭重启 |
| [ ] T114 视图与无障碍 | T106,T112 | F-EDIT-012,F-DESK-010 | 字号/换行/行号，键盘焦点、读屏状态、高对比、减少动效 | src/features/editor/view-settings.ts、src/shared/ui/FocusBoundary.tsx、src/styles/accessibility.css | Q/W/D：全键盘冒烟、读屏手查、125/150/200% |
| [ ] T115 G1 MVP验收 | T103,T105,T108..114 | M1全部 | 原生从打开到保存恢复闭环，矩阵M1逐项证据，保留可试用包 | tasks/PROGRESS.md、docs/acceptance/M1.md | Q/R/W/D/B；按QUALITY-GATES的MVP脚本 |

## M2 效率与可靠性补齐（依赖：G1）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件 | 验证 |
|---|---|---|---|---|---|
| [ ] T201 编码与逐行换行 | T115 | F-FILE-006..007 | 所列编码round-trip、原混合换行保留、转换undo与有损确认 | src-tauri/src/services/encoding.rs、src/features/editor/line-endings.ts、src/features/editor/EncodingMenu.tsx | Q/R/D：每编码fixtures及混合CRLF/LF/孤立CR |
| [ ] T202 可选自动保存 | T201 | F-FILE-012 | 默认off、1500ms空闲保存；冲突暂停、无标题仅快照 | src/features/editor/autosave.ts、src/features/desktop/SettingsDialog.tsx | Q/R/D：持续输入/保存中输入/外部变化/无标题 |
| [ ] T203 冲突对比 | T111,T201 | F-FILE-016 | 返回磁盘快照与revision，对比后变动再次阻止旧授权覆盖 | src/features/editor/ConflictDiff.tsx、src-tauri/src/services/files.rs | Q/R/D：比对期间外部再次改文件 |
| [ ] T204 多根/收藏/工作区文件 | T115 | F-WORK-002,F-WORK-008..009 | 根重排/移除不删buffer，收藏独立，迁移相对路径/坏配置保护 | src/features/workspace/roots.ts、src/features/workspace/Favorites.tsx、src/features/workspace/workspace-file.ts | Q/R/W/D：同名根、搬目录、配置损坏 |
| [ ] T205 排除/监听/链接遍历 | T204 | F-WORK-010..012 | ignore规则可见，默认不跟链接，启用后visited/越界授权；watch溢出重扫 | src-tauri/src/services/walker.rs、src-tauri/src/services/watch.rs、src/features/workspace/filters.ts | Q/R/D：junction循环/网络断开/权限拒绝 |
| [ ] T206 拖放与移动 | T105,T204 | F-WORK-006 | 外部拖入打开；内部移动确认/碰撞/跨卷结果不伪原子 | src/features/workspace/drag-drop.ts、src-tauri/src/services/file_ops.rs | Q/R/D：多选、跨卷失败、dirty文件移动 |
| [ ] T207 标签/双分栏 | T115 | F-EDIT-014..015 | 拖排重开批量关闭，最多两组同文档共buffer/undo独立视图 | src/features/editor/groups.ts、src/features/editor/TabStrip.tsx、src/features/editor/EditorGroup.tsx | Q/W/D：取消批关、双视图编辑与恢复 |
| [ ] T208 常用编辑操作 | T115 | F-EDIT-004,F-EDIT-007,F-EDIT-009..011 | 注释/行移动复制/词补全/空白/折叠，未知语言禁用解释 | src/features/editor/commands.ts、src/features/editor/extensions.ts、src/features/editor/completion.ts | Q/W/D：首末行/重叠选区/长文档降级 |
| [ ] T209 多光标与列选择 | T208 | F-EDIT-005..006 | AltClick/下个相同词、矩形选择和IME/Tab宽字符规则 | src/features/editor/multicursor.ts、src/features/editor/keymap.ts | Q/W/D：软换行、中文宽字符、Escape恢复主光标 |
| [ ] T210 导航与大纲接口 | T207 | F-EDIT-016 | 文件/行列/前后导航/面包屑；无LSP的大纲扩展槽 | src/features/editor/navigation.ts、src/shared/ui/QuickOpen.tsx、src/features/editor/Breadcrumbs.tsx | Q/W/D：缺失目标、重复文件名、Unicode列 |
| [ ] T211 增量目录搜索 | T108,T205 | F-SEARCH-004..006 | 多根过滤/进度/取消/结果限额，dirty语义明确，旧结果丢弃 | src-tauri/src/services/search.rs、src/features/search-tools/SearchPanel.tsx、src/bridge/search.ts | Q/R/D：10k命中/50MiB/编码/取消≤250ms |
| [ ] T212 跨文件替换计划 | T203,T211 | F-SEARCH-007 | 逐文件不可变预览、版本与风险、dirty排除可见，未确认零写入 | src-tauri/src/services/replace_plan.rs、src/features/search-tools/ReplacePreview.tsx | Q/R/W/D：过期计划、取消勾选、只读/编码风险 |
| [ ] T213 提交/恢复记录 | T212 | F-SEARCH-008..009 | 二次确认、写前备份、冲突停止并列部分结果，回滚不覆盖新修改 | src-tauri/src/services/replace_apply.rs、src-tauri/src/services/replace_recovery.rs、src/features/search-tools/ReplaceResult.tsx | Q/R/D：中途强杀/失败/后改回滚冲突 |
| [ ] T214 快捷键定制与全局唤起 | T109,T112 | F-DESK-003 | 应用内映射可编辑冲突检测；全局默认off、失败反馈和释放 | src/features/desktop/keybindings.ts、src-tauri/src/services/shortcuts.rs | Q/R/W/D：系统已占用、重启/退出释放 |
| [ ] T215 隐私管理 | T110,T113 | F-DESK-004 | 最近/恢复/收藏独立清理，唯一未保存副本保护，无遥测 | src/features/desktop/PrivacySettings.tsx、src-tauri/src/services/recovery.rs | Q/R/D：容量满/30天未认领不静默删唯一副本 |
| [ ] T216 G2效率验收 | T201..215 | M2全部 | 效率操作与数据安全无回归，输入/大目录开始基准 | tasks/PROGRESS.md、docs/acceptance/M2.md | Q/R/W/D/B、初步P与替换故障报告 |

## M3 Markdown与工具（依赖：G2）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件 | 验证 |
|---|---|---|---|---|---|
| [ ] T301 Markdown三模式 | T216 | F-MD-001..002 | source/read/split共buffer，GFM渲染，双组布局不改源码 | src/features/markdown/MarkdownView.tsx、src/workers/markdown.worker.ts、src/features/markdown/parser.ts | Q/W/D：表格/引用/嵌套列表/切换恢复 |
| [ ] T302 代码块/任务编辑 | T301 | F-MD-003,F-MD-011 | 高亮复制安全；勾任务定位原始节点，一次undo，旧映射不可改 | src/features/markdown/code-block.ts、src/features/markdown/task-mapping.ts | Q/W/D：重复任务/源码修改/只读/危险代码块 |
| [ ] T303 安全资源和链接 | T301 | F-MD-004,F-MD-006..007 | 相对资源授权、远程默认阻止、受限HTML清洗、危险协议拒绝 | src/features/markdown/sanitize.ts、src/features/markdown/links.ts、src-tauri/src/services/assets.rs | Q/R/W/D：脚本/SVG/junction/越界/远程像素 |
| [ ] T304 目录与同步滚动 | T302 | F-MD-005,F-MD-008 | H1-6稳定锚点、源映射、版本取消，大文档降级 | src/features/markdown/Outline.tsx、src/features/markdown/source-map.ts、src/features/markdown/scroll-sync.ts | Q/W/D：重复标题/图片晚载入/双栏/旧版本 |
| [ ] T305 HTML导出 | T303,T304 | F-MD-009 | 实际离线独立HTML，安全资源内嵌、覆盖确认与失败保护 | src/features/markdown/export-html.ts、src-tauri/src/services/export.rs | Q/R/D：断网重新打开HTML、中文/图片/失败 |
| [ ] T306 PDF导出spike和实现 | T305 | F-MD-010 | WebView2生成真PDF，纸张方向边距，中文分页/取消失败 | src-tauri/src/platform/windows/pdf.rs、src/features/markdown/ExportDialog.tsx | Q/R/D：真实多页PDF打开检查；必要时拆.a/.b |
| [ ] T307 JSON/XML/Web格式化 | T216 | F-SEARCH-010 | Worker按需parser、JSONC注释、格式一次undo、解析错定位且不执行代码 | src/workers/format.worker.ts、src/features/search-tools/formatters.ts、src/features/search-tools/format.ts | Q/W/D：各语言fixtures、XML外部实体、迟到结果 |
| [ ] T308 SQL/YAML格式化 | T307 | F-SEARCH-011 | SQL显式方言；YAML注释锚点多文档保真，Java无伪formatter | src/features/search-tools/formatters-sql.ts、src/features/search-tools/formatters-yaml.ts | Q/W/D：MySQL/PG/SQLite、YAML锚点与拒绝态 |
| [ ] T309 文本变换 | T208,T307 | F-SEARCH-012 | 排序去重大小写清尾空白等，选区明确、预览undo、不隐式改编码 | src/features/search-tools/text-transforms.ts、src/features/search-tools/TransformPreview.tsx | Q/W/D：Unicode、空行、多选区和混合换行 |
| [ ] T310 双文件diff与安全预览 | T203,T303 | F-EDIT-019..020 | 只读diff差异导航；图像尺寸/缩放、安全SVG和解码上限；HTML静态隔离预览不执行脚本/联网/IPC且不改源码 | src/features/editor/DiffView.tsx、src/features/editor/ImageView.tsx、src/features/editor/HtmlPreview.tsx、src-tauri/src/services/images.rs | Q/R/W/D：损坏图片/40MP/20MiB、巨大diff、HTML恶意脚本/表单/远程图拒绝 |
| [ ] T311 G3内容体验验收 | T301..310 | M3全部 | 原型体验落到真实文件，安全/导出/格式化证据完整 | tasks/PROGRESS.md、docs/acceptance/M3.md | Q/R/W/D/B；离线HTML/PDF实际文件与截图 |

## M4 桌面完善（依赖：G3）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件 | 验证 |
|---|---|---|---|---|---|
| [ ] T401 单实例/多窗口/CLI | T311 | F-DESK-007..008 | 单实例路由、同文件写所有权、CLI new/reuse/goto/wait正确 | src-tauri/src/services/windows.rs、src-tauri/src/services/cli.rs、src/features/desktop/windows.ts | Q/R/D：中文参数、--wait关闭/异常退出、重复打开 |
| [ ] T402 安装/升级/卸载 | T401 | F-DESK-005 | 用户级安装真实可用，缺runtime离线指引、不删文档/未确认恢复 | src-tauri/tauri.conf.json、src-tauri/windows/installer.nsi、scripts/package.ps1 | B/D：独立环境安装升级卸载、无dev server |
| [ ] T403 便携数据模式 | T402 | F-DESK-006 | portable.flag决定同级data，不可写报错/选择；与安装版隔离 | src-tauri/src/services/data_dir.rs、scripts/package.ps1 | R/B/D：解压移动、只读目录、安装版共存 |
| [ ] T404 系统集成选择加入 | T402 | F-DESK-009 | 关联/右键显式选择，可撤销只清自有项、遵守系统限制 | src-tauri/src/platform/windows/associations.rs、src/features/desktop/IntegrationSettings.tsx | R/D：安装默认不抢、用户手动改变后撤销不覆盖 |
| [ ] T405 G4可分发验收 | T401..404 | M4全部 | 包能独立启动/工作/恢复/退出，路径与证据清楚 | docs/acceptance/M4.md、tasks/PROGRESS.md | Q/R/W/D/B；安装和便携sha256 |

## M5 完整v1验收（依赖：G4）

| 状态/任务 | 依赖 | 功能追踪 | 切片与明确验收 | 主要规划文件 | 验证 |
|---|---|---|---|---|---|
| [ ] T501 Release性能 | T405 | F-DESK-012 | 冷热启动/全树私有内存/输入/目录/搜索/预览/包大小达到预算 | tests/benchmarks/runner.ts、scripts/bench.ps1、docs/acceptance/performance.md | P，10次样本/p95/夹具/版本/机器、未达标继续处理 |
| [ ] T502 故障安全回归 | T501 | F-DESK-012,全部数据安全ID | 实际强杀/磁盘满/锁定/外部变化/恶意预览/坏清单无未解严重问题 | tests/integration/faults/、tests/desktop/recovery/、docs/acceptance/faults.md | R/D，原生故障注入+人工演练 |
| [ ] T503 全矩阵和兼容验收 | T502 | 全部86项 | 每ID有实现+证据；Win10/11目标核查；无TODO/mock伪完成 | docs/FEATURE-MATRIX.md、docs/acceptance/v1.md、tasks/PROGRESS.md | Q/R/W/D/B，完整逐项审查；未经测系统不得标已支持 |
| [ ] T504 内部发布材料 | T503 | F-DESK-012 | 便携/安装包、hash、许可证、指南/恢复说明/已知问题，未签名状态明确 | docs/USER-GUIDE.md、docs/RELEASE-NOTES.md、THIRD-PARTY-NOTICES.md、scripts/release.ps1 | pnpm audit+依赖处置、产物重开；不自动公开上传 |

## 完整性规则

任务表有57个工作单元（T000..005、T101..115、T201..216、T301..311、T401..405、T501..504；实际数量由校验工具统计，文案若不一致应修正）。最后一个任务完成之前不得宣称完整v1。任务状态与功能验收独立：任务完成不能代替矩阵逐ID证据，完整功能可有多个任务共同实现。

若阶段依赖范围写`T108..114`，包含108到114；跨阶段编号不要隐式补齐不存在任务。并行任务不得同时编辑同一个文件，约定接口后各自提交，再由集成人完成原生关卡。
