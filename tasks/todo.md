# 开发任务清单

当前阶段：**M0/G0已通过，开始M1**。`[ ]` 待做，`[~]` 进行中，`[x]` 通过验收。禁止仅因代码存在就打勾；关联 [计划](plan.md)、[进度](PROGRESS.md) 与 [完整功能矩阵](../docs/FEATURE-MATRIX.md)。范围写 `F-FILE-001..005` 表示含端点的连续ID。
执行更新（2026-11-02）：T000–T005/G0、T101–T114通过。T102已加入真实16MiB WSL2 `tmpfs`满盘场景：Release保存停在`write-temporary`，源文件不变、缓冲保持dirty、恢复正文和原件一致；Windows 9P错误31与NTFS错误112映射限制已明确记录。T106已用真实Release验证CodeMirror事务编辑、选区/字数、undo/redo、缩进、语言高亮、括号配对/匹配、剪贴板，以及Windows微软拼音候选窗提交；T108已用共享TS/Rust夹具和真实Release验证Unicode/大小写/整词、选区范围、零长度、非法式、捕获组、全部替换单次undo与只读保护。T105新建/重命名/仅回收站删除均通过真实Release验收。T107单预览/固定偏好、dirty关闭保存/放弃/取消、恢复副本清理及未知释放结果另存均通过相关真实Release。T109统一命令、重映射及受授权候选快速打开已验收；T110单组恢复/热退出、T111外部变化与安全冲突处理、T112版本化设置/主题/字体/损坏恢复、T113最近记录/缺失修复/隐私关闭已验收；T114字号/焦点导航及实际Windows 11系统缩放/高对比/减少动效/讲述人样本已验收；下一项T115整体回归，G1尚未通过，不代表MVP或完整v1。

## 执行约定

每次选择一个依赖已完成的任务，先读其模块规格，再实现最小切片；表内文件是**未来规划路径**，不存在时在M0约定的结构下创建。一个任务超过约5个生产文件时先拆`.a/.b`并保留追踪。测试文件与fixtures不受机械数量限制。

验证简称（M0实际建立脚本后使用）：

- **Q**：受影响模块的类型/lint/行为检查；如`pnpm exec vitest run src/features/editor/close.test.ts`、`pnpm exec eslint src/features/editor/close.ts`。全局`pnpm typecheck`仅在共享契约/跨模块类型受影响时执行；所有命令检查exit code。
- **R**：受影响Rust包/测试目标的fmt/clippy/test；如`cargo test --manifest-path src-tauri/Cargo.toml --test discard_recovery`，不随普通TS/UI修改重跑全部Rust测试。
- **W**：受影响Web用例（如`pnpm test:e2e tests/e2e/trash.spec.ts`；mock只证明UI/bridge），M阶段再全量。
- **D**：`pnpm test:desktop`只跑原生smoke；按能力用`pnpm exec playwright test --config desktop.config.ts --project tabs`等选择`saving/tabs/commands/workspace/editor/search`；专项为`large-files/disk-full/forced-exit`。日常workspace只验树与变更流程，低层release/chunk/discard IPC仍在regression；`pnpm test:desktop:all`包含原完整综合场景及tabs/commands供M阶段。未实际执行的新入口/场景保持待验，不用smoke代替相关原生IO。
- **B**：普通相邻T可合并`pnpm build`及Release验收，高风险T完成必须有相关真实Release；记录产物hash及覆盖范围，已有同构建有效证据直接复用。
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
| [x] T102 安全保存闭环 | T101 | F-FILE-003..005,F-FILE-009 | 保存/另存/副本/全部保存/覆盖/硬链接、进程终止与真实满盘安全失败 | src/features/editor/{save,save-all}.ts、src-tauri/src/commands/save.rs、src-tauri/src/services/{save,save_requests,create_file,save_as}.rs、tests/desktop/{forced-exit,disk-full}.ts | typecheck/lint、TS74、Rust68+1 ignored、Web27、Release build、真实桌面1（1.1分钟）exit0；真实16MiB WSL2 tmpfs满盘在write-temporary安全失败，源哈希/dirty/恢复body+original均正确；Win11 NTFS 112→DISK_FULL有单测。9P错误31限制见M1验收 |
| [x] T103 大文件模式 | T101 | F-FILE-013 | 完整<20MiB降级/长行、≥20MiB单页分块、>100MiB显式前1MiB预览、动态增长重判、片段保存/As/Copy后端拒绝 | src-tauri/src/services/{open_policy,files,stream_snapshot}.rs、src/features/editor/{LargeFileView,EditorDocument}.tsx | TS33/Web16/Rust61/clippy/fmt/typecheck/lint/build exit0；真实Release1 exit0。原生20MiB分块前后页、100MiB+1显式预览、哈希不变；测量首屏上界1.12s/预览动作0.36s，进程树348–444MiB超M5目标，M5继续复核。见M1验收 |
| [x] T104 单根目录树 | T101 | F-WORK-001,F-WORK-003 | 打开根、懒加载/分页/排序/刷新/当前文件定位，空和拒绝态完整 | src/features/workspace/Explorer.tsx、src/features/workspace/store.ts、src-tauri/src/services/directories.rs | typecheck/lint、TS38、Rust66（100k基准另跑）、Web17、Release build、真实桌面1（55.2秒）exit0；原生空/无权限根恢复、205项分页、刷新保展开、junction拒绝、dirty保留；100k首分页159.669ms<300ms。见M1验收 |
| [x] T105 树内变更 | T102,T104 | F-FILE-017,F-WORK-004..005 | 排他新建、不覆盖改名、仅回收站；dirty保存/保护/取消，失败保树、缺失缓冲可另存 | src/features/workspace/{Explorer,TrashDialog}.tsx、src-tauri/src/services/{file_ops,trash,windows_trash,recovery}.rs | 最终check.ps1 exit0：TS84/Rust89+1 ignored/Web31/fmt/clippy；Release build与真实桌面1（1.3分钟）exit0。原生锁定失败/草稿摘要/文件及目录回收/取消/新路径另存/越权拒绝已验。M1单项操作；多选编排仍由T206跟踪。 |
| [x] T106 真实编辑内核 | T101 | F-EDIT-001..003,F-EDIT-008,F-EDIT-018 | CM事务/undo/缩进/括号/高亮及手动语言，IME正常 | src/features/editor/{documents,editor-state,EditorDocument,EditorStatus,editor-metrics,editor-language,language-loader}.ts/tsx | typecheck/lint、TS63、Rust66+1 ignored、Web22、Release build、真实桌面1（56.0秒）exit0；真实WebView2/CDP composition、系统剪辑板及Windows微软拼音候选窗均验证。见M1验收 |
| [x] T107 标签与关闭保护 | T102,T106 | F-EDIT-013,F-FILE-018 | 单组单预览、dirty固定、关闭保存/放弃/取消不丢内容 | src/features/editor/{tabs,TabStrip,CloseDialog,close}.ts/tsx、src/app/App.tsx | 定向模型22、tabs Web7/相关Web7、相关eslint/typecheck、Release build均exit0；真实tabs1/12.6s及workspace1/20.2s通过，含恢复副本物理清理、外部冲突保源、取消路径、未知释放保副本另存与固定偏好重载。a/b原生IPC有效证据复用；完整会话恢复仍T110。见PROGRESS及M1验收 |
| [x] T108 文件内搜索替换 | T106 | F-SEARCH-001..003 | 一致正则/整词语法，选区范围、计数、替换单次undo | src/features/search-tools/{FindBar,search-query}.ts/tsx、src/workers/find.worker.ts、tests/fixtures/search-semantics.json | typecheck/lint、TS74、Rust67+1 ignored、Web27、Release build、真实桌面1（56.8秒）exit0；共享TS/Rust语义夹具、真实只读文件与单次undo原生化均验证，取消耗时25.64ms<250ms。见M1验收 |
| [x] T109 命令入口与快捷键 | T107 | F-EDIT-017 | 统一注册/分发、命令与快速打开、重映射/冲突/焦点 | src/shared/commands/{keyboard,registry}.ts、src/shared/ui/CommandPalette.tsx、src/app/{register-commands,quick-candidates}.ts | 定向模型11/相关Web15/受影响eslint/typecheck/Release build exit0；真实commands1/5.2秒，OS选取、真实保存字节、只读保源、CM重映射、同名候选、偏好重载和默认重置通过。完整导航T210，原生设置整合T112，全局唤起T214。见PROGRESS |
| [x] T110 恢复与热退出 | T102,T107 | F-FILE-010..011,F-DESK-011 | 周期快照/启动校验、事务副本、单组会话/授权/位置、退出flush/失败/放弃 | src/features/desktop/、editor/recovery.ts、src-tauri/src/services/{recovery,session,session_grants,startup_storage,storage_budget}.rs | 2026-11-02定向TS86/Rust相关51+授权4/事务与会话、fmt/clippy/typecheck/ESLint、相关Web21及Release均exit0；真实recovery1/18.2秒：WM_CLOSE/重启、坏副本回退、磁盘差异、存储失败保正文/代次、真实另存、放弃不复活、周期快照强杀恢复、越屏夹取。M1单组；见PROGRESS/M1验收 |
| [x] T111 外部变化 | T102,T110 | F-FILE-008 | a只读磁盘快照/接纳lease；b监听/聚焦与clean重载；c脏冲突比较/保护重载/另存/覆盖 | src-tauri/src/services/{external,watch}.rs、src/features/editor/external-changes.ts、src/features/editor/ConflictBanner.tsx | 定向TS67/Rust50+授权5/Web17、fmt/clippy/lint/typecheck/build exit0；真实external1/12.7秒，编辑/对象替换/rename/delete、保护重载/原生确认覆盖和注入聚焦/overflow后的真实stat均通过。见PROGRESS/M1验收 |
| [x] T112 设置与主题 | T002,T110 | F-DESK-001..002 | a受保护设置存储/版本/损坏隔离；b合并/导入预览/工作区允许项；c主题/字体/编辑器即时预览；d设置页和真实验收 | src/features/desktop/settings.ts、src/features/desktop/SettingsDialog.tsx、src-tauri/src/services/settings.rs | 2026-11-02 TS45/Rust6、Web3 mock、ESLint/typecheck/fmt/clippy/build exit0；真实settings 1 passed/3.5秒，同版本外改拒绝/坏JSON隔离在Rust，Release验证保存/重启/未知字段/旧副本恢复/200%。见PROGRESS/M1验收 |
| [x] T113 最近记录 | T104,T112 | F-WORK-007 | 50项去重、缺失修复、单删/清空和关闭记录不再落盘 | src/features/workspace/RecentList.tsx、src/features/workspace/recent.ts | 2026-11-02 TS57/Rust相关4+3+6/受影响ESLint/typecheck/clippy、Web1 mock及真实Release1/10.7秒exit0；验证文件/工作区记录、身份去重、重启授权恢复、缺失重选、单删/清空、关闭后跨重启保留且不新增。见PROGRESS/M1验收 |
| [x] T114 视图与无障碍 | T106,T112 | F-EDIT-012,F-DESK-010 | a编辑器Tab焦点；b字号缩放/区域导航；c读屏/媒体/设置分类；d1相关Release、d2平台验收 | src/features/editor/view-settings.ts、src/shared/ui/focus-navigation.ts、src/styles/accessibility.css | a/b/c定向TS/Web通过；d1真实accessibility1及tabs/settings2通过，Release/ESLint/类型/文档检查exit0；d2实际Win11讲述人8条/深浅高对比/减少动效/125–200%系统缩放通过，系统已恢复；整项证据见PROGRESS |
| [~] T115 G1 MVP验收 | T103,T105,T108..114 | M1全部 | 原生从打开到保存恢复闭环，矩阵M1逐项证据，保留可试用包 | tasks/PROGRESS.md、docs/acceptance/M1.md | 恢复BUSY已修复；F-FILE-015只读试开补齐，相关真实试开/mvp/recovery3项通过；最终矩阵/试用包待补，G1未通过 |

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
