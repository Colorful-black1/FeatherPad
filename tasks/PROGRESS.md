# 当前进度与交接

## 目前状态

- 产品名称：**轻羽 FeatherPad**。
- 当前交付：完整产品方案、86项功能矩阵、模块规格、UI规范与离线交互原型、技术/本机环境文档、M0–M5实现计划、57个开发任务、agent执行入口。
- 产品代码：**M0/G0、M1/T101–T115及G1已通过（2026-11-03）**。保存/编辑/树/搜索/标签/命令/恢复、外部变化与安全冲突处理、设置/主题/字体、最近记录与隐私关闭、字号与键盘导航均有相关真实Release证据；M1的34个feature ID已统一验收，但仍不是完整v1。
- 当前：**M1/G1已收尾并提交`94245d5`；用户已确认开始M2，当前T201编码与逐行换行**。每完成一个M阶段必须停止并等待确认；M2完成后不自动进入M3。
- 本次交付检查：详见 [DELIVERY-CHECK](../docs/DELIVERY-CHECK.md)，不代表产品关卡G0–G5通过。

## 已核查环境

复用本机Node22.13.0、pnpm10.32.1、Rust1.99.1、VS2022 Build Tools C++、Windows SDK10.0.26100.0、WebView2。未安装新开发工具。严格遵守新增安装与缓存仅在E:\Codeing，入口见 [ENVIRONMENT](../docs/ENVIRONMENT.md)。

## 实施证据（未来逐任务追加）

### 2026-11-03 M2启动 / T201.a严格编码核心

- 复查环境探针exit 0，复用现有工具；新增`encoding.rs`以固定Windows代码页严格转换GB18030/GBK/Shift_JIS/Big5/Windows-1252，接入已有快照编码，BOM不匹配、非法字节、默认替代和best-fit均拒绝；仅开启已锁windows-sys功能，无新依赖/安装。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --test save_encoding` exit 0，6项通过：独立已知字节、混合换行逐字节往返、GB18030补充平面字符、无BOM UTF16、不可表示/非法字节/不匹配BOM均覆盖。`cargo fmt` exit 0；T201尚在实现，下一步接入编码打开/重开、可撤销格式与逐行映射，真实冒烟与G2统一验收待后续。
- T201.b：CodeMirror新增逐行格式StateField与undo反向效果，保留未改换行、新增行用主导类型（平手取首个），格式转换增加版本/dirty并能撤销；保存Ack记录捕获格式，新格式不被旧Ack清clean。仅在换行变化时复制映射，普通逐键输入复用映射。相关3文件41项与`tsc --noEmit`均exit 0；界面、编码重开和混合/UTF16可写入口尚待接通，T201保持进行中。
- T201.c原生：文件服务支持显式编码打开/按revision安全重开；比较、重载、身份别名、保存/另存后的当前编码均保留，未完成传统编码保存事务可读成恢复副本。定向Rust encoding_reopen/open_document共14项通过，后续编码保存/另存/事务读取3文件16项通过（均exit 0）；实际源字节与有损拒绝已核对。测试首次编译因DTO无PartialEq改用完整序列化内容比较后通过。当前尚未接新的IPC/UI，不记T201完成。
- T201.d接口：新增严格schema的`check_encoding`/`reopen_with_encoding`及精确capability、typed bridge和响应校验；预检查返回完整计数/最多32个UTF16位置及未应用的替代候选，不接受任意路径。编码Rust7项、IPC schema1项、bridge1项与TS类型均exit 0。下一步接UI与转换协调器，并保证传统编码暂不能表示的未保存正文仍能独立UTF8恢复；尚未构建Release或运行阶段回归。
- T201.e恢复：将规范快照元数据/逐行校验与目标编码可表示性分开；恢复/回收保护允许GBK等缓冲包含emoji，正文仍以校验过的UTF8持久化，真正保存仍拒绝有损。相关encoding_reopen/recovery/recovery_snapshot共21项通过/exit 0，保留非法格式/陈旧映射/配额/摘要/来源检查。下一转换协调器与UI；T201未完成。
- T201.f转换协调器：混合/已支持编码解除M1临时只读，仍强制文件属性/预览只读；有损计划绑定文档版本与原始Text，替代与格式同一撤销事务。dirty重开须保存或最新恢复保护，迟到结果保新输入并恢复原生解释，未知解释无法核对时保留完整只读副本供另存。相关5文件53项、后补重开/迟到等协调器5项及TS类型均exit 0。
- T201.g界面/会话：编码、BOM、逐行保留/LF/CRLF及显式有损确认已接真实CM，初次解码失败可按选定编码打开；schema1会话可选记录来源编码，独立于未保存的目标格式。Web编码3项和既有只读试开4项均有有效通过证据（dirty标签选择器修正后单项复验；新增取消焦点断言亦通过）；相关TS类型/ESLint、会话/标签/协调器21项、Rust会话5项均exit 0。200%界面截图已检查；未做阶段整体回归。
- T201.h分块：传统编码及无BOM UTF16支持固定缓冲验证/字符对齐的只读分块，完整revision校验与原字节限额不变，补正1MiB页的窗口额外字节计算。跨64KiB编码边界单测、真实20MiB GBK文件分页/再次打开/拒绝保存均通过，Rust library clippy exit 0；未重跑100k/满盘/强杀/性能专项。初始Release构建exit 0后发现取消焦点与分块编码缺口已修，故该初始构建不记最新产品证据；下一重建并跑一条受控原生编码冒烟。

### 2026-11-03 T115完成：M1/G1统一验收通过并停止

- 最终`scripts/check.ps1` exit 0：TypeScript、ESLint、27个TS测试文件231项、Rust 148 passed/1个100k专项ignored、Rust格式与clippy、Web Playwright 73 passed全部通过；日志`.artifacts/T115/logs/m1-final-check.stdout.log`和`.artifacts/T115/logs/m1-final-check.stderr.log`，ignored不计通过。
- 最终真实Release桌面Playwright `pnpm test:desktop:all`为11 passed/3.4分钟/exit 0；日志`.artifacts/T115/logs/m1-desktop-all-pass.log`，原生结果根`.artifacts/native/2026-11-02T16-43-43-526Z-4356b62a-c96c-40a5-b0dd-8644956e266e/`。覆盖真实Tauri/WebView2、原生选择器、文件读写、保存冲突、回收站、设置、最近记录、只读预览、恢复/热退出、外部变化和键盘无障碍。
- 最终Release为`src-tauri/target/release/featherpad.exe`，12,434,432 bytes，SHA256 `935A3E5450E2E1BC7153FA18F2EAD3FC6B6074ED9DAC4CF8C9029A831A9FB1D5`，WebView2 156.0.4314.58。M1可试用包`.artifacts/T115/FeatherPad-M1-portable-935A3E54.zip`为3,924,638 bytes，SHA256 `11D3335E443D7917137C4B08ACEC2992D0BE912362B7388346891E75CABD547F`，保留exe和README；失败、排错和专项产物均未删除。
- 收尾`git diff --check` exit 0；`node scripts/validate-docs.mjs` exit 0（313文件/29 Markdown/206本地链接/86 feature/57任务/coverage 86），文档检查不计为产品行为测试。
- M1的34个必需feature ID和组织范围见[`docs/acceptance/M1.md`](../docs/acceptance/M1.md)。已知边界继续保留：满盘为受控WSL2 `tmpfs`而非原生NTFS全卷，强杀不承诺零丢失，可选小地图明确不可用，完整编码/转换留待M2。M1/G1完成，M2/T201等待用户确认。

### 2026-11-02 T115补齐F-FILE-015：显式只读文本试开

- `open_document`显式`text-preview`：BOM优先，无法无损解释的字节仅在试开显示为替代字符，控制字符可见化；<20MiB完整显示，≥20MiB保留前1MiB且全文件revision参与校验。既有grant/物理身份去重不变，不升级已有可编辑lease；试开lease沿用只读保护，原生保存/覆盖/另存/副本全拒绝，重载/会话保留模式。无新依赖/权限/联网入口。
- `text_preview.rs`读取/解释，`stream_snapshot.rs`复用固定窗口与全对象校验；files/documents/external/session接入模式，commands只扩展既有枚举值。TS契约/bridge校验、session/tabs、`read-only-open.ts`/`ReadOnlyOpenChoices.tsx`及App/EditorDocument接入用户选择与真实CM只读视图；显示试读字节/截断/替代提示，语言和保存操作禁用，不执行HTML内容。
- 定向TS最终3文件54项、Rust核心4项及相关集成30项、Web mock6项（含200% CSS缩放）通过，typecheck/受影响ESLint/fmt/clippy均exit0。日志`.artifacts/T115/logs/{text-preview-model-final,text-preview-core-verified,text-preview-rust-related,text-preview-longline-web,text-preview-lint-release,text-preview-clippy-final}.log`，Web mock不证明原生IO。
- 原生发现百万控制符单行软换行渲染问题：回调约60ms收到完整1MiB数据，模型快，Web同用例约15.8秒。按产品100,000字符长行规则关闭试开软换行、提示水平滚动后，Web该用例约0.6秒；内容/超时不变。这些单次时间用于定位，不代替M5性能分布。测试快照嵌套IPC参数、TS品牌类型、Fast Refresh导出及Rust collect类型推断问题已修，原失败日志/截图和回调长度诊断保留，不记录正文。
- `pnpm build`exit0：12,432,896 bytes、SHA256 `50BD6B3E0FAA4772BC3D342FD22F080B9F5E1E1A870111DAC09A6BB13813398B`，WebView2 156.0.4314.58，主JS778.93kB/gzip246.08kB警告保留。真实`text-preview/mvp/recovery`3 passed/38.0秒/exit0，试开8.7秒；验证显式选择、非可编辑CM、四种合法格式原生写请求READ_ONLY、20MiB二进制限量1MiB、真正UTF16不误判、正常退出/重启仍只读及三份源SHA不变。七种文件和恢复回归通过，此轮恢复包含既有强杀，未另跑满盘/100k/性能专项。
- 证据`.artifacts/native/2026-11-02T15-49-49-011Z-798a581d-21bd-47f6-b3fc-901f20ecd468/{text-preview,mvp,recovery}/native-release.json`；小文件/大文件截图已视觉检查，重启截图及私有会话保留。日志`{text-preview-longline-release-checked,text-preview-native-final}.log`。F-FILE-015当前M1范围通过；G1逐项报告/试用包待完成，完整编码/转换继续T201，M2–M5未通过。全部历史产物与清理清单保留。
- 收尾将两个启动实例的控制台/请求诊断都纳入断言，并补重启后脚本不执行检查，同一Release试开复验1 passed/7.4秒（总8.3秒）/exit0；最终单项证据`.artifacts/native/2026-11-02T15-58-17-070Z-8dc23935-4a8d-41d2-b618-f2958a8a2f72/text-preview/native-release.json`和`text-preview-native-diagnostics-final.log`。code-review-and-quality复核读取上界、BOM/截断边界、已有lease、重载/会话标志及所有写入口，无新增必改项。
- 2026-11-03收尾类型/文档/差异校验均exit0，日志`{text-preview-typecheck-final,text-preview-docs-checkpoint,text-preview-diff-checkpoint}.log`；同哈希exe保留于`.artifacts/T115/release-50BD6B3E/featherpad.exe`，尚未将单个exe当G1试用包。下一M1逐项审计与试用包。

### 2026-11-02 T115进行中：整体回归及恢复锁竞争修复

- F-FILE-010/011、F-DESK-011相关修复：多个文档周期快照争用总预算锁时，临时BUSY曾永久阻止该版本再次保护。`storage_budget.rs`仅对锁`WouldBlock`标`retryable:true`；`recovery.ts`保留失败提示并按原1秒调度重试，成功Ack才标保护。明确重试旧失败版本后遇BUSY也会清除旧屏障。其他BUSY/满盘/权限/未知结果仍停止自动重试，热退出失败仍可见且不自行退出；无新依赖/grant/IPC权限。
- 整体基线：`scripts/check.ps1`首轮exit101，TS216/类型/ESLint通过，T101旧身份测试与T111既有逻辑ID契约冲突。保留用例并补强不同canonical identity/revision、旧lease不接纳和释放后新ID，定向19项通过；随后Rust全套140 passed/1项100k专项ignored、fmt/clippy exit0。Web首轮66/68通过，补生命周期夹具和精确dirty标记后定向4项通过，保留打开顺序/参数并新增编辑前后全部IPC相同断言。日志`.artifacts/T115/logs/{check,identity-reproduction,identity-final,integration-final,web-all,web-affected-final}.log`。
- 新增`tests/desktop/mvp.ts`并加入原生project与`test:desktop:all`：中文两级懒加载树、MD/Java/JSON/SQL/XML/HTML/TXT七类文件的语言检测/编辑/保存字节、无标题取消/首次保存、跨标签undo通过。原生11项首轮9通过/2失败；回收测试现同时核对明确回收成功及通用缺失提示，并在删除前等操作按钮可用，原字节/恢复断言保留。保存失败定向捕获真实BUSY后才修复，证据日志`{native-m1,native-saving-workspace}.log`及相应native目录保留。
- 修复验证：新增模型先红后绿，最终恢复/热退出/保存3文件23项、Rust预算3项、Web恢复副本1项、类型/受影响ESLint/fmt/clippy均exit0。日志`{recovery-busy-red,recovery-busy-final,recovery-exit-save-final,rust-storage-contention,web-recovery-final,typecheck-final,lint-summary-final,clippy-recovery-fix}.log`。首轮修复Release真实mvp/saving/workspace/recovery 4 passed/2.6分钟/exit0，证据`.artifacts/native/2026-11-02T14-49-39-776Z-d82208d7-4150-4b27-9f50-be1e5ed6ab0e/`，其中mvp截图已检查；此轮恢复包含既有受控强杀，未重复满盘/100k/大文件专项。
- 最终`pnpm build`exit0：12,412,928 bytes，SHA256 `2B99731FF7B8B31D5BE7E354A3D96D10A5D1712DA60B9EF0552FE508B78D0EB6`，WebView2 156.0.4314.58，主JS776.88kB/gzip245.18kB警告保留。保存/恢复相关真实Release复验2 passed/55.3秒/exit0，证据`.artifacts/native/2026-11-02T14-55-50-061Z-1ceb50b1-c204-4785-8ed5-07811352f8e8/{saving,recovery}/native-release.json`及`{release-build-final,native-contention-edge-final}.log`。对应exe保留于`.artifacts/T115/release-2B99731F/featherpad.exe`，不将它称作已通过G1的试用包；其余未相关能力按代码/构建关联性复用，未声称新exe全套重跑。
- code-review-and-quality审查无新增必改项。F-FILE-015严格二进制拒绝/UTF16识别已有证据，但手动只读试开入口尚缺，下一切片必须补齐及相关真实验收，不能借T201依赖G1推迟。README明确可选小地图不可用且默认关闭；M1最终逐项报告/试用包待补，G1及M2–M5未通过。所有失败产物及未提交的`docs/CLEANUP-AFTER-DEVELOPMENT.md`保留，未自动清理。

### 2026-11-02 T114完成：字号、焦点导航和实际Windows辅助功能

- F-EDIT-012/F-DESK-010在当前M1范围通过。实现文件为editor的`keyboard-focus.ts`、`view-settings.ts`及编辑状态/标签，desktop设置队列/分类页，Shell区域导航、统一命令与系统媒体CSS；不新增依赖、Rust源或IPC权限。a/b/c定向模型/Web及d1相关真实Release证据沿用下文，不重复构建或专项检查。
- d2复用d1同一Release（SHA256 `EBE5F3A9BE056646527E9EC72DF81034145A20F861FA913B9E945AFE76210E9F`），实际Windows 11 build26100、2560×1440、WebView2 156.0.4314.58。通过系统设置切换125/150/200%，观测DPR1.25/1.5/2且页面zoom为空；200%有效视口1280×650，主要设置操作可见、内容可滚动，Tab/F6/CtrlM/Escape不改受控正文。未把640px组件测试当最低视口支持。
- 实际“水生/沙漠”高对比下，正文对比度16.29/10.43，搜索和主按钮7.89/7.00，禁用项opacity1、搜索和焦点轮廓可见。减少动效时媒体查询生效，观测动画/非零过渡均0，编辑后单次undo及F6正常。最终恢复100%、无对比主题、动效开启，正文不变；测试实例正常关闭exit0，讲述人退出。未清理任何产物。
- Windows讲述人10.0.26100.3323实际播报样本8条：状态、dirty标签、关闭风险、Tab模式状态/帮助、设置分类、弹窗返回、主动读取搜索“1处”、非法正则自动错误提示。使用[微软键盘命令](https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-b-narrator-keyboard-commands-and-touch-gestures)的读当前/下一项与复制最后播报保存受控UI短句；未取得自动完整计数或瞬时CtrlM公告录音，不据此宣称这些播报已证实。原剪贴板未备份恢复，仅保留受控短句；没有采集用户正文或剪贴板内容。
- 汇总`.artifacts/T114/windows-platform-1SPvhE/platform-acceptance.json`；`dpi*-settings`、`raw-high-contrast-*-search`、`raw-reduced-motion-*`、`final-platform-restored`的JSON/PNG及`narrator-*.txt`保留。125–200%和深浅高对比截图已视觉检查。最初Playwright附着时出现的高对比媒体不匹配证据保留并排除，实际高对比重新启动后的原始CDP只读观测、主题动态切换及恢复为有效证据，未用仿真覆盖系统偏好。
- `node .artifacts/T114/summarize-platform.mjs` exit0（仅核对实际观测，不冒充新产品运行）；日志`.artifacts/T114/logs/platform-summary.log`。d1类型/ESLint/Release和原生证据有效；最终`node scripts/validate-docs.mjs`与`git diff --check`均exit0，日志`{docs-final,diff-check-final}.log`。Windows10及后续功能仍须各阶段验收；下一T115整体回归，G1/M2–M5未通过。

### 2026-11-02 T114.d1：相关真实Release验收（平台矩阵仍待验）

- 新增独立`tests/desktop/accessibility.spec.ts`及desktop `accessibility` project，纳入`test:desktop:all`，日常可单独选择；不改生产测试入口，不使用业务mock或DPI/媒体仿真。验证真实Tab缩进及undo、CtrlM/Tab/ShiftTab/Esc离开、F6及选区/undo、dirty关闭名称/状态AX、设置分类键盘/预览取消/焦点返回、原生800px窗口侧栏和设置操作、快捷键/真实Ctrl滚轮仅改编辑字号、真实设置落盘和正常WM_CLOSE后恢复字号及最后输入。没有故意延迟写入，退出前请求与关闭的观测不代替所有并发时序；串行队列边界复用b1模型证据。
- `pnpm build`exit0，Release 12,412,928 bytes，SHA256 `EBE5F3A9BE056646527E9EC72DF81034145A20F861FA913B9E945AFE76210E9F`，WebView2 156.0.4314.58；主JS776.81kB/gzip245.16kB警告保留，未提高阈值。新原生1 passed/5.2秒（总6.0秒），相关原生tabs/settings 2 passed/30.0秒，均exit0。受影响ESLint、`pnpm typecheck`、文档静态校验及`git diff --check`均exit0；无Rust源改动，复用已有Rust检查，不跑满盘/大目录/强杀/性能专项。
- 证据`.artifacts/native/2026-11-02T13-07-18-817Z-3578ca9a-2242-45a6-bf3d-074b2f6d8f9d/accessibility/native-release.json`及三张截图均已视觉检查；相关原生`.artifacts/native/2026-11-02T13-08-05-639Z-6867fe5e-193e-4634-9dc4-469411b10411/{tabs,settings}/`。日志`.artifacts/T114/logs/{release-build,native-accessibility,native-settings-tabs,lint-native-accessibility,typecheck-native-accessibility}.log`。最终字号14，真实设置version6、SHA256 `B4D25A2418175DB8C047876C1F35E5A08D55604BACD61C18D28B4080B0D479E9`。
- 将退出证据字段改成准确的`lastFontRequestBeforeRealWmClosePersists`，未更改产品代码/断言；同一Release复验1 passed/5.5秒（总6.5秒）/exit0，最终证据`.artifacts/native/2026-11-02T13-11-17-995Z-5f9d3b5d-1e19-422b-a548-f360760486a1/accessibility/native-release.json`和`native-accessibility-final.log`。复用同构建首轮截图视觉检查，最终文档校验/差异检查见`{docs-d1,diff-check-d1}.log`。
- 按code-review-and-quality检查累计实现/测试：核对Tab模式初始化和销毁、焦点记忆失效/模态边界、字号串行/未知回执/迟到Ack、原有设置/最近记录保留和工作区键白名单，没有新增必改项；未新增依赖/IPC权限。T114仍未整项提交或标通过，G1未完成。实际Windows读屏/高对比/减少动效/125–200%系统缩放仍待d2；本轮原生基线DPR1、forcedColors/reducedMotion均false，不外推为平台矩阵通过。computer-use规则禁止同一轮混用直接PowerShell UIA与Computer Use，本轮tabs已使用受控UIA选取器；平台UI切换留下一轮，现有测试产物和清理清单保留。

### 2026-11-02 T114.c2：设置分类键盘与语义（原生待验）

- `SettingsDialog.tsx`将分类改成单一Tab入口的tablist/tab/tabpanel，方向键/Home/End切换并聚焦分类，忽略IME组合；内容区有名称、焦点圈和自然Tab路径。紧凑布局同步水平分类语义，快捷键入口移至设置操作区。分类切换/搜索保留预览；取消恢复效果和原焦点。相关`App.tsx`补设置入口标题，`app.css`及`accessibility.css`补选中/焦点样式；无新设置键/IPC/依赖。
- 新增3项行为测试，连同原设置3项及区域焦点4项，`pnpm test:e2e tests/e2e/settings.spec.ts tests/e2e/focus-navigation.spec.ts`共10 passed/19.0秒/exit0；受影响ESLint和测试入口内TS/前端构建均exit0。覆盖预览跨分类保留、空结果进出内容区、IME、快捷键入口焦点返回、紧凑布局和200% CSS缩放。日志`.artifacts/T114/logs/{lint-settings-category,web-settings-category}.log`。
- 截图`.artifacts/playwright-results/2026-11-02T12-55-28-525Z-d5e08760-66bf-4365-b85f-12cbaaa4cd8e/settings-compact-settings--3ad8f-h-contrast-and-200-CSS-zoom/settings-category-compact.png`已视觉检查，主操作可见，内容区可滚动；640px仅验证设置组件紧凑分支，不表示产品最低视口降至640px。当前仍为Web mock/媒体仿真/CSS缩放证据，不代表Windows读屏或系统DPI已通过。下一d相关Release/平台验收，T114/G1待验，未运行专项或清理产物。

### 2026-11-02 T114.c1：读屏语义、高对比与减少动效（平台验收仍待进行）

- F-DESK-010部分：Shell状态栏保持polite并明确非atomic，App将光标/字数放入可主动读取、live off的命名分组；TabStrip的描述及关闭名称包含dirty/只读风险，clean/预览/固定状态仍准确。`src/styles/accessibility.css`经`src/main.tsx`导入，forced-colors使用系统颜色和状态轮廓，禁用按钮保留不透明文字，搜索与主按钮配对Highlight/HighlightText；reduce模式取消CSS动画、过渡、平滑滚动和自绘光标闪烁。五个生产文件，无新增依赖/IPC/工具。
- `media-accessibility.spec.ts`最终4 passed/13.8秒/exit0；浏览器AX树验证status的polite/atomic false和可读指标分组，DOM验证dirty/clean/只读标签及关闭风险。两种forced-colors配色下正文/搜索/主按钮对比度均≥4.5:1、焦点≥3:1，焦点宽度≥2px；reduce下无运行CSS动画且编辑/undo/F6正常，偏好取消后恢复100ms。相关`accessibility.spec.ts`3项和`tabs.spec.ts`7项均已通过，最后只改强制颜色的主按钮规则，不影响这些非强制颜色场景，复用证据。相关ESLint与Web入口内typecheck/build均exit0；未重复模型或Rust检查。
- 截图核查发现浏览器强制颜色背景板遮住主要按钮文字，已改成明确系统颜色对并关闭该按钮的再次颜色替换，补对比度断言后通过；两张最终截图均视觉检查。构建压缩把100ms改成.1s的断言问题已修为统一毫秒后仍精确比较0/100，没有改动产品时长或性能门槛。最终日志`.artifacts/T114/logs/{web-media-primary-colors-final,lint-media-primary-final}.log`，相关10项证据在`web-media-status.log`（该轮媒体时长断言失败，不记整轮通过）。最终截图位于`.artifacts/playwright-results/2026-11-02T12-46-27-587Z-56f9411c-cedc-4037-bef2-fa368b6649f1/media-accessibility-browse-{e9cef-us-with-light-system-colors,39448-cus-with-dark-system-colors}/forced-colors-{light,dark}.png`；早期日志/截图/trace全部保留。
- 既有Web及原生tabs的精确描述断言同步完整新文案，不降低断言；原生tabs本轮未执行，仍待T114相关Release验证。当前是浏览器AX/媒体仿真辅助证据，未声称实际Windows读屏、高对比、减少动效或125/150/200%系统缩放通过。下一c2补设置分类方向键/语义，然后d平台验收；T114/G1未完成，未构建Release、未跑整体/故障/大目录/性能专项，未提交整项，清理清单与产物保留。

### 2026-11-02 T114.b2：键盘区域导航与窄屏焦点（整项T114仍待验）

- F-DESK-010部分：新增`src/shared/ui/focus-navigation.ts`并接入`Shell.tsx`，F6/Shift+F6按可见区域循环，页面初始body也可进入，记住仍可达的上次控件；跳过关闭区域、disabled/inert/隐藏控件及已退出Tab顺序的旧标签，标签区回到当前活动项。正文往返保持选区和undo，模态与IME不切后台区域。`keyboard.ts`保留F6导航键，`app.css`补状态栏焦点圈，App成功选择已打开文件也能关闭窄屏覆盖侧栏，五个生产文件，无新IPC/依赖。
- 窄屏侧栏打开后聚焦控件，Escape关闭并回切换按钮；CtrlB关闭导致焦点随DOM移除时返回可见按钮，F6进入正文/操作区后收起覆盖层，设置弹窗的Escape只关闭弹窗。浏览器真实键盘验证了窄屏已打开树文件再次选择时不重复缓冲、不丢dirty正文；文件/目录来源为Web mock，不证明原生IO。
- `vitest run keyboard.test.ts registry.test.ts`2文件11项及受影响ESLint均exit0。相关Web首轮`focus-navigation/shell/accessibility`9 passed/21.5秒/exit0；最后补当前标签变化边界后，`focus-navigation.spec.ts`4 passed/15.5秒/exit0，复用无相关修改的壳层2项/Tab焦点3项证据。Web启动包含类型检查/前端构建，均通过。日志`.artifacts/T114/logs/{unit-region-navigation,web-region-navigation-final,web-region-roving-final,lint-region-roving-final}.log`；截图`.artifacts/playwright-results/2026-11-02T12-31-04-103Z-8acbe66e-5439-4439-a340-dff807a3e9ed/focus-navigation-narrow-si-7e091-t-and-returns-visible-focus/narrow-region-focus.png`已视觉检查。
- 下一c补读屏状态、高对比、减少动效；T114整项、真实Release、Windows读屏及125/150/200%系统缩放仍待验。未执行Rust/Release/原生综合/满盘/100k/强杀/性能专项，未提交未完成的T114，全部既有修改、清理清单与测试产物保留。

### 2026-11-02 T114.b1：编辑字号缩放与持久化（整项T114仍待验）

- F-EDIT-012部分：统一注册放大/缩小/恢复14px命令（Ctrl+=与Ctrl++同义、Ctrl+-、Ctrl+0），支持重映射和禁用原因；编辑区真实Ctrl滚轮复用字号动作，8–40px范围只改字体，状态栏显示当前字号，不改变系统/页面缩放或正文/选区/undo。生产改动为`src/features/editor/view-settings.ts`、`src/shared/commands/keyboard.ts`、`src/app/{register-commands.ts,App.tsx}`、`src/features/desktop/settings.ts`五文件。
- 字号立即响应，复用版本化设置串行队列，当前写入期间的新输入只保留最新目标；保留未知字段、最近记录及设置页的新预览。外部冲突不重试覆盖，未知回执只做完整配置/版本/revision读回核对，迟到回执不覆盖后读配置；失败保留本次字号并显示提示，后续成功可解除提示。计划关闭在已有安全退出前等待已发起的字号写入，未改正文恢复/会话的安全流程；无新增IPC/依赖/工具。
- 定向`vitest run settings.test.ts view-settings.test.ts keyboard.test.ts registry.test.ts`4文件29项exit0，覆盖合并连续输入、最近记录串行、预览/迟到Ack/冲突/未知回执/非法值、边界与命令重映射；受影响ESLint exit0。Web `view-settings.spec.ts`3项、`commands.spec.ts`5项、`settings.spec.ts`3项共11 passed/21.0秒/exit0；包含真实浏览器按键/Ctrl滚轮、重载恢复、页面宽度/DPR/zoom不变、正文/选区/undo、失败恢复及模态边界。Web启动内`tsc --noEmit && vite build`通过；设置存储仍为mock，不代表原生Release或系统缩放通过。
- 相关设置Web回归发现T113最近记录保存已把初始版本从1推进到2；夹具现等待该成功记录可见后冻结版本，仍严格断言导入预览不写入，增加初始版本2的明确断言。React回调依赖修复后ESLint通过。最终日志`.artifacts/T114/logs/{unit-zoom-ui,lint-zoom-ui-final,web-zoom-ui-final}.log`，早期失败日志与trace保留；截图`.artifacts/playwright-results/2026-11-02T12-15-06-472Z-3df7423d-b8cd-40e4-9188-f30eedc0132c/view-settings-Web-mock-key-b7219-g-the-page-or-changing-undo/font-zoom-restored.png`已视觉检查。
- 下一b2实现键盘区域导航，然后补读屏状态/高对比/减少动效及相关真实Release、Windows读屏和125/150/200%系统缩放。T114保持进行中，未提交整项；未重跑Rust/Release/原生综合/专项性能或故障测试，所有既有产物和清理清单保留。

### 2026-11-02 T114.a：编辑器Tab焦点模式（整项T114仍待验）

- F-DESK-010部分：新增`src/features/editor/keyboard-focus.ts`并接入`editor-state.ts`，Ctrl+M切换Tab缩进/移动焦点，编辑器底部显示模式及Esc后Tab离开提示；CodeMirror公告只在切换时发出，模式随编辑器状态保留，通过切标签、缩进设置重建view后不丢失。只读编辑器始终允许Tab离开，模式切换不改正文/选区、dirty、bufferVersion或undo。`app.css`补紧凑键盘栏；控制台检查发现缺少favicon，`index.html`与`public/favicon.svg`补用既有羽毛标识的离线资源。无新依赖/工具/原生IPC。
- 最终定向`vitest run keyboard-focus.test.ts documents.test.ts settings-effects.test.ts`3文件34项、受影响ESLint均exit0；`pnpm test:e2e tests/e2e/accessibility.spec.ts`3项/13.3秒/exit0，包含Ctrl+M/ShiftTab/EscTab、选区/undo、标签与view重建、只读离开和无控制台错误。相同生产代码的既有`editor.spec.ts`5项已通过，复用该证据；Web入口包含`tsc --noEmit && vite build`，类型/前端构建通过。Web使用真实CodeMirror，文件读取与只读来源为mock，不证明原生IO或实际屏幕阅读器播报。
- 初始化插件早于CodeMirror输入状态、选区简化消耗Escape的失败已修复；短时公告读取改为预先观察实际DOM公告事件，保持内容断言且无重试/放宽超时。原始失败trace和日志保留。最终日志`.artifacts/T114/logs/{unit-focus-final,lint-focus-observed-announcements-final,web-focus-observed-announcements-final}.log`；既有编辑5项证据在`web-focus-final.log`（该轮新公告断言失败不记整轮通过）。截图`.artifacts/playwright-results/2026-11-02T12-00-54-483Z-ce458cab-4a52-4bd7-8fb7-3f1aa910a14b/accessibility-editor-Tab-f-526c6-ned-through-view-recreation/editor-tab-focus.png`已视觉检查。
- 下一T114.b补Ctrl滚轮/字号快捷键、区域导航及后续读屏状态/高对比/减少动效。T114相关真实Release、Windows读屏和125/150/200%系统缩放仍待验，未重跑Rust/Release/原生综合/满盘/100k/性能专项；暂不提交未完成的整项T114，原有清理清单与全部测试产物保留。

### 2026-11-02 T113完成：最近记录与隐私关闭

- F-WORK-007通过。新增最多50项、48KiB预算的版本化最近记录，文件按原生canonical identity去重、工作区按grant ID去重，只在文件或目录成功打开后记录；独立文件/工作区筛选、缺失灰显、重新选择修复、单项移除和二次确认清空均立即持久化。隐私设置默认开启，关闭后既有数据保留但新打开不再写入；记录不保存正文、搜索词或剪贴板内容。
- 最近记录与设置保存共用串行队列；修复设置写入入队后仍携带旧版本号的问题，现在入队时读取最新版本并合并本地预览。`DocumentRegistry`保留原生canonical identity，启动先从最近记录提取grant IDs，再通过`load_session({restoreGrantIds})`只恢复既有且身份仍匹配的持久授权；新记录写入后flush会话授权，使重启可直接打开记录。工作区重命名同步更新关联记录。
- 主要生产文件：`src/features/workspace/{recent.ts,RecentList.tsx}`、`src/app/App.tsx`、`src/features/desktop/session.ts`、editor文档/设置关联及App样式，`src/shared/contracts/files.ts`、Rust models/commands/files，以及桌面recent project。新增`tests/e2e/recent.spec.ts`和`tests/desktop/recent.spec.ts`；无新增npm/crate依赖。
- 定向行为检查：`pnpm typecheck`、受影响ESLint、Rust全目标clippy均exit0；相关TS 5文件57项exit0；Rust `session_grants`4项、`session`3项、`settings`6项exit0；最近记录Web mock `recent.spec.ts` 1 passed/925ms（总9.7秒）/exit0，明确不证明原生IO。
- 最终`pnpm build` exit0：12,407,296 bytes，SHA256 `2AED610CF93421FA2A71B93A1D71B86C7F6B8135E53096A20C62D28DC684468C`，WebView2 `Edg/156.0.4314.58`，设置最终版本9、SHA256 `CBD01178D1EE954E0299AAE12CDA8E18DC353232ED0378215D8ABA308D9E156B`。相关真实Release `pnpm exec playwright test --config desktop.config.ts --project recent` 1 passed/10.7秒（总11.5秒）/exit0；覆盖文件/工作区成功打开后记录、原生文件identity、重启后经恢复grant直接打开文件与目录、移动后灰显及重选修复、单项移除、关闭历史后跨重启保留且新开不增项/不增版本、清空和持久化内容不含正文/搜索词/剪贴板。
- 证据`.artifacts/native/2026-11-02T10-18-10-040Z-3729b303-9950-4c70-a965-e46dd95f8d26/recent/native-release.json`、原生日志`.artifacts/T113/logs/native-recent.log`、构建日志`.artifacts/T113/logs/release-build.log`及截图`recent-recorded.png`、`recent-cleared-privacy.png`；失败与调试证据保留。未重跑100k目录、大文件、满盘、强杀或性能专项，未执行M1整体回归；完整恢复/历史/收藏/日志隐私管理仍由T215继续，G1和完整v1未通过。

### 2026-11-02 T112完成：版本化设置、主题与字体

- F-DESK-001/002通过。新增Rust私有设置存储与workspace只读适配：原文件revision和单调version共同防止同版本第三方改写被覆盖；OS锁、64KiB/深度/节点限制、临时文件flush、原生不覆盖创建或带唯一备份替换、写后读回、坏JSON隔离、较新schema/超限/权限错误保原件，以及规范UUID旧副本显式恢复。工作区只读取已授权根的`.featherpad/settings.json`，登记项无类型越权，前端再只应用低风险白名单。真实Windows本机字体枚举有4096上限且无网络。
- TS设置层实现默认<用户<工作区允许项<会话临时值、未知键保留、非法值诊断/上层回退、搜索/来源/默认值、单项与分组重置、schema1导入先预览、导出复用安全另存、版本冲突和迟到回读保护；设置页使用原生dialog、焦点返回和退出预览恢复。主题支持跟随系统/亮/暗，字体8–40px、行高、Tab、换行、行号、当前行即时作用于真实CodeMirror状态与view，保留正文/选区/undo且不产生dirty。缺失字体显示固定本地后备提示，不下载。
- 主要生产文件：`src/features/desktop/{settings.ts,settings-effects.ts,settings-schema.ts,SettingsDialog.tsx}`、`src/bridge/settings.ts`、`src/shared/contracts/settings.ts`、`src/features/editor/{documents.ts,editor-state.ts}`、App/Shell/命令入口，以及Rust `commands/settings.rs`、`services/{settings,workspace_settings,fonts}.rs`、精确ACL/autogenerated permissions。没有新增npm/crate依赖，仅启用已锁`windows-sys`的GDI feature。
- 定向行为检查：TypeScript严格检查、受影响ESLint、Rust fmt与affected clippy均exit0；TS 4文件45项exit0；Rust `settings` 6项exit0，覆盖版本roundtrip/未知与非法域值、同版本外部改写、坏JSON隔离/旧副本、较新schema/超限/原型键、工作区只读/越权拒绝、真实本机字体；Web `settings.spec.ts` 3项exit0（明确mock，系统媒体、预览撤销、CodeMirror view/undo、导入未知字段/失败保持临时/200%）。
- 最终`pnpm build` exit0：12,427,264 bytes，SHA256 `CFFDA4328EC828AE067EB41771A0D099B714ADD32E3513C2E1223369379BEC8B`，主JS751.41kB/gzip237.76kB警告保留。相关真实Release `pnpm exec playwright test --config desktop.config.ts --project settings` 1 passed/3.5秒（总4.1秒）/exit0；验证真实主题/字号/换行/行号预览及取消、本机字体、导入未知字段、首次写入、二次保存备份、重启保留、坏JSON原样隔离、旧副本恢复和恢复后文件SHA一致、200% DOM缩放保存按钮可见。
- 证据`.artifacts/native/2026-11-02T09-36-02-808Z-51482a1a-8087-4888-ab22-6fc4763b772d/settings/native-release.json`及三张截图已视觉检查；设置JSON SHA256依次`fb26b714...ddb5c`、`88c02643...b3546c8`，恢复后等于第一版摘要。日志`.artifacts/T112/logs/`，最终为`unit-final-40px.log`、`rust-settings-final.log`、`rust-clippy-final.log`、`rust-fmt-final.log`、`lint-final-40px.log`、`typecheck-final-40px.log`、`web-ui-selectors-fixed.log`、`release-build-final.log`、`native-settings-final.log`；早期断言写法和选择器失败日志保留。
- 200%证据是页面DOM缩放，不冒充Windows OS缩放；系统高对比、读屏/焦点全矩阵、减少动效和OS 125/150/200%仍由T114验收。未重跑大文件、100k、满盘、强杀或性能专项，未执行M1整体回归。历史测试产物未删除，清理清单未动。自审无未解决T112阻断项；下一T113，G1和完整v1仍未完成。

### 2026-11-02 T111完成：外部变化与安全冲突处理

- F-FILE-008通过。Rust新增`services/{external,watch}.rs`与`commands/external.rs`，Windows原生ReadDirectoryChangesW父目录有界监听只返回授权ref；TS新增`external-changes.ts`、`ConflictBanner.tsx`、`DiskComparison.tsx`和typed bridge，接入App/文档/保存队列，新增5条精确ACL。clean自动重载同步已挂载CM并保选区/滚动、单调版本；dirty保正文/undo，比较两份只读快照、保护最新草稿后明确重载、原生另存或带revision的原生覆盖确认。保存/重载排队，过期确认与迟到读取不覆盖新输入，未知覆盖复用原请求。删除/改名无法安全跟随时保原引用/正文并显示缺失，普通保存转系统另存；权限/锁定/离线错误不伪报删除。重复路径和新identity不产生两个DocumentId；重载转入/退出分块模式会转移/作废对应句柄。
- 最终`pnpm build` exit0：12,046,848 bytes，SHA256 `E73FA4190F4B10D481A9CF3EC684CCA07822E295162D38E8ACAAED7C45C274E7`，主JS726.42kB/gzip230.23kB警告保留。相关真实Release `pnpm exec playwright test --config desktop.config.ts --project external` 1 passed/12.7秒（总13.6秒）/exit0，证据`.artifacts/native/2026-11-02T08-33-20-315Z-f0bd467e-41be-4655-85b3-bac329dd7829/external/native-release.json`及截图/chooser回执。验证同长度同mtime改写、对象替换保ID、dirty不覆盖、真实比较、比较后再次改写拒绝重载、草稿真实读回、覆盖取消/确认期间再变化拒绝、明确覆盖字节、外部rename/delete后的系统另存与源hash。停止真实watch后分别注入DOM聚焦和overflow通知，核对真实stat/重载；不冒称OS真实溢出或物理窗口切焦。overflow后重建订阅，监听失败不会因一次stat成功而假装健康。
- 定向TS5文件67项、Rust相关50项及接纳重载/持久授权5项、相关ESLint、typecheck（最终build内）、Rust fmt/lib与受影响test clippy均exit0；最终重验external/protected_save的23项。Web相关6文件17项exit0/15.6秒，含200%/键盘取消/迟到Ack/关闭/保存副本等回归，明确是mock。日志统一`.artifacts/T111/logs/`，最终为`unit-monitor-health-final.log`、`rust-final.log`、`rust-reload-grant.log`、`rust-session-grants.log`、`rust-accepted-reload-final.log`、`clippy-complete.log`、`fmt-complete.log`、`lint-complete.log`、`build-final-verified.log`、`web-complete.log`及`native-complete.log`。早期错误预期、CM标签优先级、并发恢复读取BUSY、创建完成前ENOENT和只读invoke观测失败的原始日志均保留，逐项修正后验收通过。
- 比较不更新持久授权；仅核对grant/句柄/identity/revision后接纳的重载刷新file grant，真实Rust文件测试证明接纳后可恢复同一授权。M1比较完整<20MiB文本，超限使用已有只读重载/分页策略；不伪造分块快照的临时句柄。订阅上限4个、每订阅256引用/64目录，超限有可见错误和聚焦stat兜底。只补与lease切换直接相关的20MiB句柄正确性测试，未重跑100k、满盘、强杀、性能或M整体回归。未安装新工具/依赖，Windows API仅启用已锁windows-sys的必要features；历史产物和既有清理清单保留。自审无未解决T111阻断项。下一T112；G1和完整v1仍未完成。

### 2026-11-02 T110完成：恢复、会话与安全热退出

- F-FILE-010/011及F-DESK-011的M1单组部分通过。实现1秒debounce/最长5秒周期调度、真实快照Ack、启动逐条校验/旧副本回退、无标题/命名dirty及格式/换行恢复、clean来源/根授权/标签顺序/预览/活动文档/光标/滚动和可见窗口位置恢复。缺源占位可重选/移除并保留会话，用户自己的原子保存更新持久授权identity。dirty正文恢复不自动覆盖磁盘；磁盘变化保留原件且恢复正文只读。
- 热退出冻结输入并等待最新dirty快照和会话，失败阻止退出并提供重试/返回/另存/明确放弃；放弃回执未知、清单清理失败或窗口未关闭时推进恢复代次且保正文/undo，避免复活已放弃版本或误标保护。统一256MiB预算覆盖recovery与保存事务，跨进程OS锁避免双花；保持每文档最多10份已验证冗余、30天仅提示、损坏/歧义证据保留。事务候选通过真实IPC读取为新dirty未绑定副本，摘要和编码/换行round-trip校验后才打开。
- 最终Release `pnpm build` exit0，11,769,856 bytes，SHA256 `FB4692800E621C82DBDB388F135583E2A4C84A8471A67DFAB58DAAB1D49DB322`，主JS710.44kB/gzip226.42kB警告保留。相关真实recovery最终1 passed/18.2秒（运行总19.0秒）/exit0，覆盖正常WM_CLOSE后最新正文落盘、重启全部状态、越屏位置夹取、session存储失败、失败放弃后返回再保护、磁盘差异、最新坏副本回退、事务副本、明确放弃不复活、成功周期快照后的受控强杀SIGTERM与最后完整副本恢复，以及故障后真实OS另存/退出/重启为clean。源hash均核对；监视器场景是篡改受控保存边界的模拟，不冒称物理插拔。
- 最终原生证据`.artifacts/native/2026-11-02T07-26-38-165Z-7f60d8b0-1a3f-44e5-9e0c-473dd15566e6/recovery/native-release.json`、同目录截图和hot-exit-manifest.json；原生截图与Web200%截图已视觉检查。日志位于`.artifacts/T110/release-20261102-145522/`：build-final.log、native-release-save-as-final.log、unit-related-final.log、rust-affected-final.log、rust-clippy-final.log、rust-fmt.log和各轮原始失败日志。
- TS受影响8文件86项、Rust相关保存/另存/恢复/放弃/预算51项及新授权4项均exit0；session/startup_storage/storage_budget最终8项、Rust fmt/lib clippy、相关ESLint和build内typecheck均exit0。Web按有效路径组合21项通过：tabs7/save1/事务1，随后commands5/shell2/editor5；首批失效的commands纯Web路径经API实际值判断修复后已重新通过。测试统一生命周期fixture只补测试协议，不改业务断言；Web仍是mock。`test:desktop:all`加入recovery供M阶段，未执行整体回归。
- 自审覆盖身份/授权、版本/Ack/代次、持久化配额/锁/坏记录、IPC校验和编辑/滚动/键盘；无未解决的T110阻断项。没有新增依赖/工具或修改全局环境；既有CLEANUP清单未动，历史产物未清理。恢复指南见`docs/RECOVERY.md`。按完整T110提交；下一T111，G1和完整v1保持未完成。

### 2026-11-02 T110实现与原生验收收尾（尚待最终提交）

- 已补事务候选读取/独立dirty副本、缺文件/根占位及会话保留、持久授权在自身原子保存后的identity更新、clean会话bufferVersion边界、放弃未知结果后的恢复代次推进、关闭调度后的迟到快照不重启定时器，以及窗口内容区尺寸/边界夹取。事务正文按明确UTF8/UTF16±BOM和逐行换行重新编码逐字节核对，不授权或覆盖原路径。完整隐私管理仍T215，双组/多窗口仍各自后续任务。
- 定向TS最终8文件86项exit0，`.artifacts/T110/release-20261102-145522/unit-related-final.log`；定向Rust早前51项及新增session grants4项/transaction2项均通过，最终session/startup_storage/storage_budget 8项和lib clippy/fmt exit0，日志同目录。原生用受控小型fixtures，不重复100k/大文件/满盘/性能专项；T110首次重启强杀恢复单独补验。
- Release先构建hash `96FFB18FBEDD5F75268619029E0B56D498EE5009D04D586DBED7AC91261EE0E2`，原生首次两次被选择器受控路径/前缀拒绝，调整测试目录而未扩大选择器授权。随后实际发现CM已挂载时恢复仅更新模型未更新view/滚动，修为同步已挂载view并在measure后恢复滚动，再构建hash `D352DD2D8BA95C8553E730E0387192DCE612B5E387A2A83278025B5376AD94AD`。失败日志和fixture均保留，未降断言。
- 该构建真实recovery用例最终1 passed/13.1秒：两个命名dirty及无标题最新hot-exit正文/摘要、clean预览/根/标签顺序/活动文档/光标/滚动重启恢复，源hash不变；会话位置用无效旧监视器边界模拟，真实窗口被夹回可见工作区；session路径故障阻止退出，放弃后clear失败保正文并推进代次再保护；磁盘变化只读保两者；坏最新快照回退；真实事务正文打开独立副本；明确放弃后重启无标签；周期快照成功后受控SIGTERM终止，重启恢复最后完整快照，不承诺最后未确认输入。证据`.artifacts/native/2026-11-02T07-12-04-339Z-33f2ee8d-24a6-4060-8ebe-b0bd004512a1/recovery/native-release.json`与截图。
- 相关Web旧mock缺少Tauri窗口元数据，新增test-fixture仅补测试生命周期；业务mock和所有断言保持。首次相关批次tabs7/save1/恢复1通过，commands纯Web发现undefined桌面入口判断后已修为检查API实际值；最终commands/shell/editor 12项exit0。日志`web-related-final.log`、`web-lifecycle-related-final.log`。此最后生产guard微调仍待最终Release构建和相关原生复核，T110暂保持进行中；M阶段整体回归未跑，现有测试产物未清理。

### 2026-11-02 T110恢复开发：统一空间预算切片

- `storage_budget.rs`在原生本地数据域用OS锁共同核算recovery和save-transactions的256MiB预算；RecoveryStore写快照/新放弃标记使用该锁，SaveJournal从预留完整事务到阶段/提交结束持有锁，未知条目占用计入预算且不自动清理。既有恢复锁、摘要和reparse校验保留。
- `cargo check --tests`及定向`cargo test --test storage_budget --test recovery_snapshot --test protected_save --test save_as --test discard_recovery`均exit0，51项通过（本聊天工具输出）。新增三项覆盖双目录合计超额先拒绝、不创建receipt/不写源文件；跨线程保存预留阻止恢复写入；事务占满仍可读取最后完整恢复副本。容量夹具是逻辑长度预算测试，未冒称真实满盘。
- 本切片改变原生写入范围，旧Release不能证明新代码；T110最后仍须相关真实Release。下一步事务候选的显式读取与未绑定副本入口。

### 2026-11-02 T110小切片收尾与暂停交接

- 功能追踪F-FILE-010..011/F-DESK-011。当前工作树已接定时/热退出快照、启动恢复、会话保存/加载、clean文件与单根授权恢复、稳定DocumentId、head-preview模式和窗口边界夹取。主要文件：`src/features/desktop/{session,recovery-startup,hot-exit,window-restore}.ts`、editor恢复/文档模型、bridge/contracts，以及Rust `services/{recovery,session,session_grants,startup_storage,grants,files,documents}.rs`和commands/models/capability。六份新增autogenerated权限文件属于本任务，保留。
- 本次小切片完成启动保存事务只读扫描：校验受控receipt、manifest、body/original摘要和阶段；统计恢复目录与事务的占用，歧义temp/backup保留，只提示人工核对。查询同一版本化discard tombstone；坏标记保留证据并暂停认领，不默认恢复。普通恢复副本超过30天仅提示，不自动删除。SessionStore与授权存储的旧backup清理改用摘要校验后的原生删除句柄，校验不符保留。
- 有效定向证据：本轮`cargo fmt --check`、`cargo check --tests`、`cargo test --test session --test startup_storage --test recovery_snapshot`均exit0（3+1+12项）；随后坏标记回归修改后重跑startup_storage 1项exit0。`cargo test --lib services::session_grants::tests`最终2项exit0；`cargo clippy --lib -- -D warnings`exit0。收尾日志在`.artifacts/T110/pause-20261102-141028/`。首次授权测试比较普通路径与Windows规范路径失败，修为与`canonicalize()`结果精确比较后通过；原失败日志`session-grants.log`保留，最终为`session-grants-final.log`。
- 前端最近有效检查为`pnpm typecheck`、受影响文件ESLint、`vitest run recovery-startup/files-bridge/session/window-restore`，均exit0，4文件26项（本聊天工具输出，14:03）；此前含documents的5文件50项通过。之后仅Rust及文档变更，复用这些证据。Rust行为测试是真实Windows受控fixture文件证据；前端transport测试为mock，均不代替真实Tauri Release。没有执行本批Release构建、桌面综合、满盘、强杀、100k或性能专项。
- 暂停时仍待完成：保存事务正文的实际认领/读取交互与统一256MiB写入预算（当前仅合计占用提示，不能称统一配额已实现）；缺根/缺文件占位；热退出错误/明确放弃后的恢复代次复核；窗口保存与恢复的内外尺寸、DPI和最小窗口约束一致性复核；命名恢复与磁盘变动共存的相关测试；最终T110真实Release验收。完整隐私清理仍由T215跟踪，多窗口/双组由相应后续任务实现。
- 下一步从上述待完成项继续，不重新搭建工程。T110保持`[~]`，不提交未完成的整项功能；全部改动和测试产物保留。既有未跟踪`docs/CLEANUP-AFTER-DEVELOPMENT.md`未修改、未提交、未清理。当前小切片检查无剩余失败，暂停不是T110/G1或完整v1完成。

### 2026-11-02 恢复开发环境复查

- 首次Probe-Environment.ps1 exit1：仅WebView2固定旧目录156.0.4314.50不存在；读取标准安装目录确认已有156.0.4314.58/msedgewebview2.exe。修正探针为选择已有数字版本目录内真实exe，保留缺失时失败，不安装/升级任何工具。
- 点源Enter-Dev.ps1后复跑powershell.exe -NoProfile -File scripts/Probe-Environment.ps1 -AsJson，exit0；证据.artifacts/T107-environment-probe.json。ENVIRONMENT表同步实际已有版本，历史原生运行证据不变。

### 2026-11-02 原生确认自动化修复

- T107首次pnpm test:desktop exit1，在既有overwrite.ts保存副本成功提示处失败；源/副本目标字节仍为各自原文，错误快照显示仍在保存。日志.artifacts/T107-release-desktop.log及.artifacts/T107-first-desktop-error.md保留，未把失败当新功能通过。
- Select-ControlledFixture.ps1原先只PostMessage(BM_CLICK)即记为commandInvoked，不能证明未激活确认窗接受选择。改为对已校验进程/内容/按钮的UI Automation InvokePattern调用，并在5秒内验证该确认窗消失，失败明确报错；不扩大fixture范围、进程授权或操作类型。
- 同一Release产物完整重跑pnpm test:desktop exit0，1 passed（1.2分钟），.artifacts/T107-release-desktop-second.log；既有覆盖/取消/外部冲突/副本，以及真实硬链接确认和本轮释放用例均执行到。没有增加测试重试、放宽超时或用mock代替。

| 日期 / 任务 | 功能ID | 变更文件 | 命令 / exit code | mock或原生 | 证据 | 结论 / 下一步 |
|---|---|---|---|---|---|---|
| 2026-11-01 / T000 | F-DESK-013 | 环境/原生探针脚本及记录 | Probe-Environment/Verify-NativeToolchain exit 0 | 原生MSVC，非Tauri | `.artifacts/T000/result.json`：编译/运行均0；exe SHA256=11671D0B9073AA77425DF8C9E50FE8BEF00DA1E08E88CA6428D52287ADA53F44 | 已复用所有工具；下一T001 |
| 2026-11-01 / T001.a,b | F-DESK-013 | manifests/双锁、TS/Vite/ESLint、Tauri骨架与图标 | 冻结offline安装、typecheck/lint/build:web、Rust fmt/clippy/test均0；audit exit 1仅开发工具moderate | 编译级原生；当时Rust行为测试0个 | `docs/acceptance/M0.md`、`.artifacts/T001/` | T001通过；minimatch受控lint模式，2026-12-01复核 |
| 2026-11-01 / T002 | app-shell | React Shell/App/token/CSS、Web及原生测试 | typecheck/lint exit 0；Web 2 passed；真实WebView2 debug 1 passed | Web与原生范围分开，未测OS对话框 | .artifacts/T002/及docs/acceptance/M0.md | T002通过；下一T003 |
| 2026-11-01 / T003.a–d（进行中） | F-DESK-013 | Rust models/grants/files/commands、AppManifest ACL、TS contracts/bridge、CodeMirror只读UI、测试与脚本 | typecheck/lint/TS单测3、Rust原生5、Web4、Release smoke1均exit 0；check.ps1 -Desktop exit 0；交互选择器三次超时，后次显式exit 1 | 原生Rust磁盘+junction，真实Release IPC/WebView2，Web mock独立 | docs/acceptance/M0.md；.artifacts/T003；.artifacts/T002/native-release.json | T003未完成OS选取验收，G0不勾选 |

## T109 命令入口与快捷键完成（2026-11-02）

- F-EDIT-017：14个稳定命令ID统一按钮、快捷键、面板、标签固定/关闭及壳层开关。展示只传摘要数据，执行前重新读取当前文档摘要；同命令在途拒绝重复。命令列表显示名称/快捷键/禁用原因，支持中文/关键词过滤、方向循环、Enter执行、空结果防陈旧执行、Escape/Tab模态与焦点恢复。CM状态和undo保留，不增加每键IPC或React正文状态。
- CtrlP快速打开由app注入已打开文档和已加载/受授权目录文件，同ref去重、同名显示路径、排除链接/未显示隐藏项/其他grant，最多保留5,000候选/显示200匹配；范围与上限可见，不假称完整磁盘导航。完整F-EDIT-016仍T210。应用单组合键可重映射/解除/恢复默认，冲突不改旧绑定；拒绝Windows/AltGr/原生文本编辑及当前CM默认占用。偏好只存schema1命令ID/组合键，≤256项/64KiB，坏配置或写失败可见；原生设置整合T112，完整映射导入导出/全局唤起T214。
- 主要生产文件：src/shared/commands/{keyboard,registry}.ts、src/shared/ui/{CommandPalette,Shell}.tsx、src/app/{register-commands,quick-candidates}.ts、App.tsx及app.css；spec先记录接口/范围决策。没有新增IPC/Rust/依赖；测试新增commands Web/原生与两个核心模型测试文件。
- 定向模型11 passed/exit0（.artifacts/T109-b-model-tests.log）；相关Web15 passed/13.3秒/exit0（T109-commands-related-web.log，commands5/tabs7/save-all3），此前documents/save-all Web6通过证据保留。受影响eslint/typecheck exit0（T109-final-lint、T109-final-types、T109-shell-final-lint）；仅新增壳层快捷键提示后由build内tsc再次验证。200%快捷键编辑截图已视觉检查；Web mock不作为原生IO证据。
- 自审发现CtrlShiftK被现有CM deleteLine占用，已纳入保留键拒绝，并以Web/原生真实输入覆盖；其余检查覆盖数据/动作边界、坏偏好/容量/写失败、原生文本编辑/IME/模态、目标ID、限量候选与授权。未放松lint或断言。早期helper携带ref动作造成的lint失败保留；数据与onClick分离后解决。
- pnpm build exit0（T109-release-build.log），构建终止后才启动原生。exe为10,993,152 bytes，SHA256 F058B832150B1123DFB4A4538BE3C494419759D47644DBC219E335C218BDCB61；JS657.35kB/gzip211.97kB警告保留，未改门槛。真实Release commands 1 passed/5.2秒/exit0（T109-native-commands-first.log），证据.artifacts/native/2026-11-02T03-47-00-635Z-86e89276-53f2-4f9b-b0a1-6555dac63f36/commands/native-release.json。
- 原生范围：命令经真实OS选择器打开中文emoji目录，CtrlP打开真实文件/复用dirty同ID，面板保存字节核对、只读禁用并保持源hash、从CM触发重映射快捷键/拒绝冲突/CM占用、模态不新建、主题操作后正文/undo/焦点、加载前无陈旧候选/加载后同名路径选择、renderer重载偏好和恢复默认。保存SHA256=1b72059e634d31339b0672f5c5b9c4c09aed6daf8023576008c81faa8045fb50，只读源SHA256=c334650b6f73619dcc28664352c06d7aae229319c93900ee493e6636e23a8716，原生禁用截图已视觉检查。不声明完整启动恢复或OS缩放。
- test:desktop:all已加入commands；--list exit0/发现regression+tabs+commands三项（T109-native-all-list.log），没有执行阶段整体。按用户策略仅一次Release/相关原生；未重跑Rust、综合桌面、大文件、100k、满盘、强杀或性能。历史产物及既有未跟踪CLEANUP清单未清理。下一T110，G1仍未通过。
- 收尾文档校验exit0（T109-docs-final.log，86功能/57任务，0失败）、git diff --check exit0。五轴自审完成，未发现未解决阻断项；按完整T109功能提交，保持Goal完整范围。

## T109.a 统一命令分发简记（2026-11-02，当时面板待接）

- shared/commands/{keyboard,registry}与app/register-commands建立稳定命令ID、摘要启用态、执行入口与有限快捷键偏好；App现有高频按钮/快捷键均复用。展示摘要与执行动作分开，命令在途拒绝重复，执行前读取当前文档状态；模态/IME/已处理事件隔离。无新增IPC或依赖。
- 核心定向9 passed（.artifacts/T109-registry-tests.log），typecheck exit0（T109-a-types-state-actions.log），受影响eslint最终exit0（T109-a-lint-final.log）；先前lint失败因展示helper携带含ref执行回调，已将数据与onClick分离，未禁用规则。相关documents/save-all Web6 passed（T109-a-web-related.log），只证明mock流程。未构建/执行Release；面板、重映射UI和完整T109仍待验，按完整功能再提交。

## T107 标签与关闭保护完成（2026-11-02）

- F-EDIT-013/F-FILE-018：单组至多一个预览，树单击预览、双击/输入/命令固定，已有固定标签不降级；结构操作串行，替换仅关闭仍干净且版本未变的旧预览，失败保留。固定偏好有schema/数量/大小限制，不存正文/grant，不自动打开文件；跟随另存/改名，同路径其他保留缓冲的偏好不被误清。同名显示父路径；键盘切换、关闭及最后标签回欢迎/焦点已接通。
- CloseDialog默认取消，保存失败、选择路径取消、旧版本/新输入均保留正文；关闭最终阶段只读fence。放弃实际清理对应恢复副本并持久化版本标记；释放回执未知则保只读副本，真实另存后可恢复编辑。核心文件为editor/{tabs,TabStrip,CloseDialog,close,documents,EditorDocument,LargeFileView}、App/Explorer及样式，详见提交差异；a/b原生IPC沿用此前有效证据。
- 定向模型22 passed（9个标签+13个关闭），.artifacts/T107-tabs-model-final.log；新增tabs Web 7 passed（.artifacts/T107-tabs-web-initial.log），相关documents/save-all/workspace Web 7 passed（.artifacts/T107-web-related.log）。Web明确mock；200%关闭按钮截图已视觉检查。受影响文件eslint及共享类型检查exit0，日志T107-tabs-lint-final、native-tabs-injection-lint/types、native-related-lint及final-types。
- pnpm build exit0（.artifacts/T107-tabs-release-build.log），当前exe为10,988,032 bytes，SHA256 C3B933CEF7C09EC4E4548B992F0BBAF1AFB5EAB43DBF5D20F1D0B2DE49A85A05；主chunk641.69kB/gzip206.15kB警告保留，性能预算未变。构建终止exit0后才启动原生测试；后续仅测试/文档变更，复用同产物。
- 真实Release tabs 1 passed/12.6s/exit0（.artifacts/T107-tabs-native-second.log），证据.artifacts/native/2026-11-02T03-15-58-242Z-5e8de583-5b98-4d6e-bdf1-5e03ad741a09/tabs/native-release.json：干净预览原生lease释放/重开新ID、dirty切换/undo/取消、外部冲突保源/另存保内存、无标题保存取消/再保存关闭、真实before-trash正文摘要/放弃清理receipt及marker、释放回执未知保副本再OS另存、固定偏好renderer重载均通过。冲突/固定标签两张原生截图已视觉检查；不声明完整会话恢复或OS缩放。
- 首次tabs原生exit1（T107-tabs-native-first.log）保留：Tauri invoke是不可写属性，原测试赋值静默无效，故未注入回执丢失。修为测试独有的协议回调拦截，先收到真实release成功，再拒绝对应renderer回执；stat确认原生lease已消失，未伪造IO成功。只重跑tabs，没有重建产品或放宽断言。
- 同构建workspace 1 passed/20.2s/exit0（.artifacts/T107-workspace-native.log）；证据.artifacts/native/2026-11-02T03-17-22-935Z-83382657-05fb-4e11-b115-da0af043ca2b/workspace/native-release.json，树懒加载/分页/定位、创建改名后保存、共享锁回收失败保源/保树、dirty后代保护/取消/缺失后另存均通过。日常workspace入口跳过无改动的低层release/chunk/discard IPC组合，coreIpcLifecycleChecksRun=false；原综合regression保留这些检查及全部断言。test:desktop:all现包含regression和新增tabs，列表发现不等于执行整体回归。
- 测试输出修订：配置及native使用独立runId；本次相关旧Web回归仍曾使用固定截图路径，随后将全部Web显式截图/取消指标写入test.info().outputPath，后续不再覆盖旧路径。仅输出路径调整的用例未额外重跑，行为证据复用；没有自动清理历史产物，既有CLEANUP清单未改。两轮tabs及workspace留下受控回收站fixture，具体原路径在各运行dataDir和recycledFixtures；未枚举/清空用户回收站。
- 本任务按用户新策略收尾：未重复全TS/Rust、综合桌面、大文件、100k、满盘、强杀或性能专项；G1仍待T109–T115。下一项T109，T110须实现真实快照周期、启动扫描及热退出，并遵守已有discard tombstone。
- 收尾自审覆盖身份/版本、保存队列/关闭fence、恢复标记/未知回执、偏好边界及焦点；未发现未解决阻断项。新增证据输出路径的定向eslint exit0（T107-evidence-path-lint.log），阶段入口--list exit0且发现regression/tabs两项（T107-stage-regression-list.log，未执行整体），文档校验exit0/86功能/57任务（T107-docs-final.log）及git diff --check exit0。未新增依赖，未改断言或性能预算。

## T107.c1 关闭编排模型简记（2026-11-02，当时UI待接）

- close.ts复用SaveCoordinator逐文档队列：核对关闭版本，保存失败/路径取消/迟到Ack后有新输入均保留；最终清理/释放期间readonly fence，放弃失败推进恢复版本且保正文/undo/磁盘基线；释放未知则保只读未绑定副本，成功另存恢复绑定。removeClosed清理view映射/metrics/异步语言引用，激活右邻/左邻/欢迎；未暴露关闭UI。
- typecheck/lint exit0（.artifacts/T107-close-core-typecheck.log、T107-close-core-lint.log）；TS100 passed（.artifacts/T107-close-core-unit.log），含13个关闭行为正反例。该批检查启动于用户验收策略调整前，后续小切片改为定向测试；当前Rust和真实Release沿用b3有效证据，不宣称本切片UI/新Release已验。下一步标签模型、TabStrip和CloseDialog，再按受影响场景收尾。

### 用户验收策略修订与原生场景入口（2026-11-02）

- AGENTS/QUALITY-GATES和todo验证简称同步用户8条策略：切片定向，T按完整功能汇总/提交，高风险T必须相关真实Release，普通相邻T可合并，M整体回归；专项不随普通UI重复，既有有效证据复用，未验保持待验，历史产物只列清理清单。
- tasks/plan.md与docs/AGENT-START.md同步同一分层节奏，移除“每完成一个任务即做完整汇总/全套验收”的旧表述；当前T110属于恢复高风险任务，小切片只做定向检查，最终完成时再执行相关真实Release验收。
- 原生按project选择smoke/saving/workspace/editor/search，专项large-files/disk-full/forced-exit；regression保留原完整综合流程及全部原断言。pnpm test:desktop默认smoke，pnpm test:desktop:all用于明确整体回归，check.ps1 -Desktop仍调用整体入口。focused路由复用原有能力验证函数；强杀入口只补其所需的独立受控命名文件，不依赖无关的大文件/满盘/硬链接流程。
- 两份Playwright配置的outputDir和原生证据/控制清单/回收截图改为每次独立目录。旧.artifacts/T102/native-release.json及原目录未删；运行前后hash核对一致，后续search运行也保留smoke结果。根test-evidence.ts生成运行ID并校验目录片段，控制选择器仍校验fixture范围、父进程和exe摘要，没有扩大系统权限。
- 定向eslint及共享测试配置typecheck exit0；原生9个入口--list可发现，默认仅1个smoke（.artifacts/T107-native-routing-lint.log、T107-native-routing-typecheck.log、T107-native-scenarios-list.log、T107-native-smoke-list.log）。列表发现不代表已验收。
- 复用b3现有Release（SHA256 6A0C4525C824C39D0A804FA25CE70CB4A5E286F79D2D5568E1CCF7CFF1412E41），没有重新构建：新smoke实际1 passed（1.9秒），search独立实际1 passed（5.1秒）；日志.artifacts/T107-native-routing-smoke.log与T107-native-routing-search.log。证据分别为.artifacts/native/2026-11-02T02-10-21-880Z-819a488b-6e3d-40cb-a0c5-861b4c37aaae/smoke、2026-11-02T02-10-48-700Z-937b7abe-1abe-4bf1-83fb-d84e9c4ac910/search。smoke的保存/大文件/满盘/强杀等未执行标志均false；search记录仅本场景observation，不借用全量通过标志。
- 其余新入口的独立运行仍待验，原综合b3证据有效保留；没有重跑Rust、大文件、100k、满盘、强杀、性能或完整桌面。此轮是测试调度变更，不宣称T107.c用户流程/新Release通过。下一步继续T107标签与关闭UI，收尾以相关原生场景验收。

## T107.b3 放弃恢复严格IPC及Release验收（2026-11-02，进行中）

- discard_recovery只接受documentId/throughVersion，返回相同ID/版本及discarded=true；严格DTO拒绝path、多余字段、负数/非整数，核心拒绝非规范UUID和超过JS安全整数的版本。app内部派生恢复根，main最小allow-discard-recovery，先取与保存/回收/释放共用许可；不在该入口释放原生lease或清理save-transactions歧义保存候选。
- TS共享契约/typed bridge绑定原请求ID与版本校验回执。单测拒绝false/缺字段/不安全版本，并用mock transport验证其他文档或其他版本的“成功”回执会变为IPC_UNAVAILABLE，不能用错回执关闭文档。9项discard_recovery Rust文件/DTO测试通过；当前scripts/check.ps1 exit0（.artifacts/T107-discard-check.log）：typecheck/lint、TS87、Rust102 passed/1个100k benchmark ignored、Web31、fmt/clippy。pnpm audit --audit-level high exit0，仍1条既有开发工具moderate（.artifacts/T107-discard-audit.log）。
- pnpm build exit0（.artifacts/T107-discard-build.log）；最新Release为10,984,960 bytes，SHA256 6A0C4525C824C39D0A804FA25CE70CB4A5E286F79D2D5568E1CCF7CFF1412E41；Vite主chunk628.72kB/gzip202.46kB警告保留。桌面启动fixture记录hash已与该新产物核对相等，未把旧产物当新功能证据。
- pnpm test:desktop exit0，1 passed（1.3分钟），.artifacts/T107-discard-desktop.log。真实硬链接保存确认期间调用discard_recovery得到BUSY，随后保存/取消正常；新discard.ts在T105草稿/回收验收之后，对已另存的fixture文档明确放弃：非法请求保body，两份对应before-trash快照目录实际消失，tombstone内容读回匹配，重复同意图相同Ack，native stat仍可读且磁盘revision/元数据不变；另一dirty后代草稿正文保留。
- .artifacts/T102/native-release.json的nativeWorkspaceObservation中nativeDiscardValidated、nativeDiscardRemovesOnlyMatchingDrafts、nativeDiscardIdempotentAndSourceLeasePreserved均true，discardedDraftReceipts记录本次主动清理的两个受控receipt；failedDraft的正文是在T105断言完成后作为T107验收明确清理，directoryDraft仍保留。不是用户恢复数据清理，也不清空系统回收站。
- 已按版本绑定、许可互斥、路径边界、幂等/部分失败和证据范围自审，无新增依赖/安装工具。本轮真实范围为原生核心及IPC；T107.c还需预览/固定、关闭保存/放弃/取消、CodeMirror/view资源和焦点清理，并验证旧Ack/新输入、取消另存及存储失败。
- c阶段须处理“放弃标记可能已写入但清理失败或回执未知”：保留缓冲/标签/lease，撤销不再可靠的recoveryProtected；继续保留时要用更高bufferVersion的新恢复代次，正文/undo/磁盘基线不变，不能将已放弃旧版本重新声明已保护。T110再实现启动扫描/认领、会话与热退出，并让save-transactions候选恢复查询同一tombstone。G1和完整v1仍未完成。

## T107.b2 对应恢复副本物理清理（2026-11-02，进行中）

- discard_through仅在tombstone已落盘/读回后清理对应documentId且不高于上界的受控UUID receipt。仅删除固定body.bin、manifest.json和空目录，不沿sourcePath寻址、不递归删除。先验证目录内容，再删正文，最后删除manifest；正文被锁定时保留manifest作为重试定位，旧标记重试也重新执行清理。其他文档/更高版本/未知损坏清单保留；未知嵌套内容拒绝且不触碰正文。
- discard_recovery原生测试扩为8项，exit0（.artifacts/T107-discard-cleanup-tests.log）：匹配旧版本目录实际消失、另文档和较新正文保留；模拟标记后遗留旧快照可在重试时清理；伪造清单sourcePath不影响对应文件；真实无共享删除句柄使清理BUSY、manifest/正文保留，解锁/重建store后同版本清理完成；未知子目录保留并失败。没有递归操作用户路径。
- cargo clippy --locked --offline --all-targets -- -D warnings、cargo test --locked --offline均exit0（.artifacts/T107-discard-cleanup-clippy.log、.artifacts/T107-discard-cleanup-rust.log；101 passed，1个100k benchmark ignored）。仅Rust核心新增，TS/UI沿a2证据；下一步b3严格IPC/typed bridge及真实Release，随后c标签/脏关闭交互。T107/T110/G1仍未完成。

## T107.b1 放弃恢复标记核心（2026-11-02，进行中）

- recovery.rs增加以规范documentId/JS安全整数throughVersion绑定的不可变tombstone，排他写入并flush、读回验证，旧版本重复放弃不降低上界。标记、读取和快照持久化共用OS文件锁；load拒绝已放弃版本，迟到persist同样拒绝，新的更高版本仍可保护。源路径不参与标记寻址，目录预算/100k枚举界限和reparse拒绝继续生效；损坏标记保留副本并停止恢复，不默认忽略。
- discard_recovery.rs新增5项原生文件验证：重建store仍不复活/迟到写拒绝、其他文档保留/更高版本可用、损坏标记与非法输入、逻辑预算/不可写路径、活锁互斥、tombstone目录junction无穿透。首次4/5通过，junction夹具因向cmd传入混合斜杠路径而未创建成功，改为逐段PathBuf后5/5通过；原始.artifacts/T107-discard-marker-tests.log及第二次日志保留，没有放宽生产校验。
- 初次完整Rust回归在既有trash_tests.rs的只读impact预览发生目录枚举/复查revision不一致（.artifacts/T107-discard-marker-rust.log，exit101），同一用例隔离执行通过（.artifacts/T107-directory-preview-isolated.log）。夹具原先固定sleep50ms并假定元数据已一致，改为最多2秒重新枚举并取得通过复查的只读预览；冻结的回收请求一次执行，旧文档集合/缺快照/陈旧身份拒绝断言不变，不自动重试删除。
- 最终cargo clippy --locked --offline --all-targets -- -D warnings exit0（.artifacts/T107-discard-marker-final-clippy.log）；cargo test --locked --offline exit0（.artifacts/T107-discard-marker-final-rust.log，98 passed、1个100k benchmark ignored）。先前recovery/release定向9项亦通过。仅Rust核心新增，不冒称新Release/关闭UI/启动恢复验收。
- 本切片只持久化标记并屏蔽旧版本；物理正文/manifest清理、IPC与关闭确认尚待b2/c，未开放放弃UI。T110启动扫描和save-transactions恢复必须查询同一标记。已审查版本边界、坏标记、容量/锁、源路径与新版本保护；下一步补可重试的对应快照清理。

## T107.a 原生资源释放核心（2026-11-02，进行中）

- F-EDIT-013/F-FILE-018关闭链路的基础切片：documents.rs清理指定文档的身份索引/lease/fragment标志/全部chunk句柄；files.rs校验规范UUID，未知/未命名lease重复释放返回false，不触碰源文件、grant或恢复副本。CONTRACTS先记录释放与显式放弃分离、保存许可及重开新ID语义。
- 新增真实Windows测试release_document.rs：关闭前独占打开失败、释放后成功；硬链接仍共享新DocumentId；源字节和已落盘中文emoji草稿保留；两次打开同一大文件所得旧句柄均失效，新句柄及其他文档正常；非法ID拒绝，未知UUID正常no-op。cargo test --locked --offline --test release_document exit0，3 passed，日志.artifacts/T107-release-service.log。
- cargo clippy --locked --offline --all-targets -- -D warnings exit0（.artifacts/T107-release-core-clippy.log）；cargo test --locked --offline exit0（.artifacts/T107-release-core-rust.log，92 passed、1个100k benchmark ignored）。cargo fmt已执行；本切片未改TS/UI，未冒称新Tauri/Release关闭验收。已按正确性、资源边界、幂等、独立文档影响自审，无新依赖。
- 下一步：release_document严格DTO/最小ACL/typed bridge、逐文档保存许可；再接单预览/固定/关闭UI及持久化放弃标记。T107整体仍[~]，T110/G1及后续阶段未完成。

### T107.a2 资源释放IPC已验（2026-11-02）

- ReleaseDocumentRequest严格DTO、Result及commands入口、AppManifest/handler/仅main窗口的allow-release-document已接；不接受path/discard/recoveryPath/requestId。入口先取得共用逐文档许可，保存/回收在途返回BUSY；未命名/缺失的未知原生lease正常返回released=false。TS共享契约及bridge严格校验boolean回执，未直接暴露任何恢复删除入口。
- scripts/check.ps1 exit0：typecheck/lint、TS85、Rust93 passed/1个100k benchmark ignored、Web31、fmt/clippy；.artifacts/T107-release-check.log。4项release_document原生服务/DTO测试通过；独立TS guard拒绝缺字段/字符串/数字/空值回执。pnpm audit --audit-level high exit0，仍为1条既有开发工具moderate，日志.artifacts/T107-release-audit.log。
- pnpm build exit0（.artifacts/T107-release-build.log）；Release 10,875,392 bytes，SHA256 CA7DFC3E93B5D060F6372C0A8E746AB6B36CE3D54278DA6E5C915C503E9087FA。Vite主chunk628.51kB/gzip202.39kB警告保留。真实pnpm test:desktop第二次exit0（上方记录首轮自动化故障及修复）。
- 原生真实范围：hardlinks.ts在真实保存确认窗打开时调用release_document得到BUSY，随后取消/保存仍正常；release.ts使用真实目录grant打开独立受控文件，拒绝伪路径/非法ID、释放重试/未知ID返回false、旧stat变NOT_FOUND、另一文档继续有效；同一20MiB文件两份旧handle在重开新ID后仍拒绝、新handle可读32字节；原文字节未变。四项nativeRelease*字段在.artifacts/T102/native-release.json的nativeWorkspaceObservation均true。Rust另证明原生lease真关闭与草稿正文不变。
- 本轮只验资源释放IPC，不是标签/脏关闭UI或启动恢复验收；下一步T107.b持久化放弃标记与对应快照清理，再接标签预览/固定和保存/放弃/取消。已按输入、许可顺序、幂等、独立文档及证据范围自审；未新增依赖/安装工具。

## T105 树内变更完成（2026-11-02，M1/G1仍未完成）

- F-FILE-017、F-WORK-004、F-WORK-005完成本任务M1验收。此前a切片已验排他新建/不覆盖改名/dirty后代目录改名，本轮补齐真实回收站删除的完整入口、确认、草稿保护、失败保树与缺失缓冲另存。M1按单项操作验收；多选、拖放及逐项批量编排继续由T206跟踪，没有删除后续需求。
- 生产变更：App编排、Explorer/TrashDialog/store、editor的documents/document-save-state/EditorDocument/LargeFileView、app.css。默认焦点取消，Delete键进入确认；显示真实路径/数量/目录及dirty影响，保存修改后刷新revision/identity并重新确认，或保护草稿再回收。成功保留EditorState/undo并标记缺失，完整缓冲CtrlS真实另存；后续输入使“草稿已保护”失效，片段禁分页与保存。未知传输结果只核对冻结的原请求；错误回执或失败不移除树项，切根后迟到回执不污染新根。侧栏工具栏换行，200%缩放确认按钮可见。
- 测试/工具：新增tests/e2e/trash.spec.ts、tests/desktop/trash.ts和仅受控fixture使用的Hold-ControlledFixture.ps1。helper只锁定T002/webview2-*内UUID小文件及对应ready/release标记，拒绝reparse，30秒自动释放，不扩生产IPC或用户路径权限。
- 最终检查：powershell.exe -NoProfile -File scripts/check.ps1 exit0（typecheck/lint、TS84、Rust89 passed/1个100k基准ignored、Web31、fmt/clippy；.artifacts/T105-final-check.log）；pnpm build exit0（.artifacts/T105-release-build.log）；pnpm test:desktop 1 passed（1.3分钟），exit0（.artifacts/T105-native-desktop.log）。pnpm audit --audit-level high exit0，仍报告1条既有开发依赖moderate，未强制修复；.artifacts/T105-audit.log。主JS chunk 628.40kB/gzip202.36kB仍有Vite警告，未调阈值。
- Web明确mock：取消、失败保树/dirty、未知结果同requestId同快照、保存后新revision/identity再确认、缺失后另存；.artifacts/T105/trash-web-zoom200.png已视觉检查。它不证明磁盘IO。
- 真实Release另验：未授权grant/多余path字段/陈旧revision/junction均拒绝保源；真实无共享删除句柄使系统回收失败，源字节/树/dirty不变且恢复body摘要正确；解除锁后先真实保存，再用新identity确认回收，源消失、缓冲保留，CtrlS经真实OS选择器另存到新路径且字节正确；含dirty后代的目录，Escape取消保原件，确认后目录消失、后代缓冲保留且草稿正文/版本/SHA256正确。
- 原生证据：.artifacts/T102/native-release.json的nativeWorkspaceObservation新增nativeRecycleSharingFailurePreservesSourceAndTree、nativeTrashDraftVerified、nativeTrashInvalidRequestsRejected、nativeSaveBeforeTrashRefreshesIdentity、nativeTrashMissingBufferCanSaveAs、nativeDirectoryTrashWithDirtyDescendant、nativeDirectoryTrashCancellationPreservesSource均true，含两个真实草稿receipt和body SHA256。T105下native-trash-sharing-failure.png、native-trash-directory-confirmation.png、native-trash-missing-buffer.png已视觉检查。系统回收API/回收项字节/还原及永久删除否决另由真实Rust测试证明；Release综合留下2个受控回收站fixture作为真实结果，原始路径列于recycledFixtures，未枚举/清空用户回收站。
- 最新Release：src-tauri/target/release/featherpad.exe，10,786,304 bytes，SHA256 DCBB34B6D535D12FA53F457867C524115AD6CB843CA38C7DF2D24F4237269F72。Win11/WebView2开发机证据，不外推Win10、OS缩放或M5性能。没有新增依赖/工具安装。本轮变更已做正确性、授权边界、失败状态、结构及证据范围自审。
- 下一项T107标签/关闭保护；T110仍须接启动扫描/恢复认领/热退出/冗余与保存事务统一预算。当前仅回收前快照，不宣称启动会话恢复、G1或完整v1通过。下面保留各切片当时状态，当前结论以上方为准。

## T105.b2 typed IPC已接（2026-11-01，确认UI待接）

- get_trash_impact/trash_entry接到commands/file_ops、Tauri handler和两个最小ACL权限；输入严格JSON DTO，不接受本机路径或存储目录。恢复根由既有本地状态入口派生，Rust编排仍独立复核grant、revision、identity和全量文档集合。
- InFlightSaves新增文档组预留，回收与保存/另存互斥；部分预留失败会释放已取得的许可，独立文档继续可操作。原生许可单测1 passed（.artifacts/T105-trash-ipc-rust.log）。
- TS contracts/bridge补typed请求和严格结果guard，拒绝重复文档、非法identity、根引用、false删除结果或不一致草稿/缺失文档映射。typecheck/lint、TS82、Rust clippy --all-targets -D warnings均exit0；编译已生成精确命令权限。首次TS18046由闭包中的unknown属性收窄失效造成，改用已校验的局部常量解决，未用any/类型断言隐藏。
- 尚未进行新IPC的真实Tauri删除验收；下一步确认Dialog、已删除缓冲的缺失/另存状态、失败保树及Web/Release验证。T105仍[~]。

## T105.b2 原生回收编排完成（2026-11-01，IPC/UI待接）

- F-FILE-017/F-WORK-005的原生编排切片：新增services/trash.rs与trash_tests.rs，models增加impact/执行/回执DTO，documents提供后代lease查询与原引用恢复信息；file_ops共用结果缓存，windows_trash补预览identity绑定及可失败的STA线程创建。未开放生产删除IPC或UI。
- impact按真实lease路径包括独立file grant打开的后代，执行严格复核完整文档集合和每份完整缓冲快照。全部快照校验/落盘/读回成功后才释放后代句柄调用真实Shell；失败按原grant/ref/FileIdentity重绑，成功返回缺失文档ID与草稿receipt。拒绝应用私有状态目录及祖先/后代。
- 额外绑定Windows identity摘要：同名、同大小、相同mtime乃至相同字节的替换对象也不能使用旧确认；原生删除前回调再次核对identity。成功/失败均按requestId/payload缓存，256项详细回执过期后仍由会话摘要tombstone阻止旧请求重做；10,000个回收意图上限保护内存，已有请求继续可核对。
- 真实Shell编排5项通过（.artifacts/T105-trash-service-final.log）：dirty正文已真实保护且原字节进入回收站；新同名文件不受重复请求影响，详细缓存过期也不会重复删除已还原文件；目录新增打开后代使旧确认拒绝、缺快照拒绝，补齐后真实回收并还原；共享锁失败后原DocumentId/ref重绑，解除锁后同请求仍只回放失败；存储失败/身份/未知grant/越界/根拒绝保源；同名同mtime同字节新FileIdentity拒绝。测试仅操作受控UUID fixture及本次返回的精确回收项。
- cargo clippy --locked --offline --all-targets -- -D warnings exit0；cargo test --locked --offline为88 passed、1个100k基准ignored，exit0（.artifacts/T105-trash-service-rust.log）；cargo build/fmt检查见提交前最终结果。Rust原生范围，未冒称Tauri删除或新的Web/Release验收。
- 下一步：get_trash_impact/trash_entry最小ACL与typed bridge；删除期间复用保存互斥许可；保存/保护草稿/取消确认、失败保树、缺失缓冲可另存与真实Release验收。T105仍[~]；T107/T110/G1及以后仍未完成。

## T105.b2 草稿存储核心完成（2026-11-01，回收编排待接）

- 功能追踪：F-FILE-017/F-WORK-005删除前保护的存储部分，尚非T105或T110完整验收。新增`services/recovery.rs`与`tests/recovery.rs`，通过lib接入；规格先同步CONTRACTS。不新增IPC、路径权限或依赖。
- before-trash快照保存原始路径/磁盘基线revision、bufferVersion、编码/BOM、逐行换行映射、正文长度/SHA256与时间。正文先排他写入并flush，manifest后写并flush；读回验证正文/摘要/schema后才返回成功。receipt只接受规范UUID，拒绝reparse、过大读取、非法映射与损坏记录，不自动删唯一副本，也不写源文件或清dirty。
- recovery目录总256MiB、单正文64MiB；OS文件锁保护配额核算和写入，并发独立store不能双花剩余预算。预算只覆盖本切片的recovery目录；保存事务统一空间管理、10份冗余/30天提示、启动扫描/认领与热退出仍属T110。
- 原生文件测试5 passed（`.artifacts/T105-b2-recovery-final.log`）：重建store后中文emoji正文、版本、UTF16LE/BOM及CRLF/孤立CR映射完整；等长有效UTF8正文篡改仅因摘要不符被拒绝；独立schema损坏和receipt越界被拒绝且副本保留；逻辑容量配额超限/存储路径不可写保源；junction拒绝零正文写入；两个并发store只有一项成功且总量不超预算。配额fixture只按文件逻辑长度制造，不冒称真实磁盘满。首轮失败是测试夹具用了非64位磁盘revision，原始日志保留`.artifacts/T105-b2-recovery-initial-failure.log`，修正夹具后通过，未放宽生产校验。
- 最终`cargo fmt --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`（83 passed、1个100k基准ignored）、`cargo build --locked --offline`均exit0；全Rust日志`.artifacts/T105-b2-rust.log`。TS/UI本切片未变，沿用b1的typecheck/lint/TS81及a的Web27/真实Release证据，未冒称新Release或删除UI完成。
- 下一步仍T105.b2：原生impact返回准确的已打开文档（包括独立文件grant打开的后代）；trash_entry绑定grant/expectedRevision/requestId和完整快照集合；先持久化后释放后代lease并调用原生回收，失败重绑原lease，成功返回缺失文档ID/草稿receipt。随后接保存/保留草稿/取消确认、失败保树、缺失缓冲与真实Release验收。T105继续[~]，T110/G1以后未完成。

## T105.b1 原生回收适配完成（2026-11-01，删除交互仍未开放）

- 功能追踪：F-FILE-017/F-WORK-005的原生风险切片，不代表T105或UI验收通过。新增`services/windows_trash.rs`及受控原生测试，Cargo直接复用已有Microsoft windows/windows-core 0.62.2，未下载/安装新工具或crate；锁文件只增加本包到已有包的两条直接依赖。Rust/TS同步增加TRASH_UNAVAILABLE错误码。
- IFileOperation固定回收标志、无永久删除实现；专用STA线程和父目录链锁，PreDeleteItem再次核对路径/identity/revision且否决缺少回收标志的系统请求；PostDeleteItem必须有成功结果及真实回收项，源路径消失后才成功。首个失败原因不被后续失败回调覆盖。
- 真实Shell测试5 passed：中文emoji文件进入回收站、回收字节一致并由Shell移回；非空目录及子文件同样回收/还原；锁定原文件导致实际Shell失败且字节不变；移除回收标志的真实永久删除请求被PreDeleteItem拒绝且原件完整；旧revision/缺失路径/junction安全拒绝。还原只操作本次receipt的精确回收项，不扫描或清空用户回收站。
- 检查：`cargo test --locked --offline`为78 passed、1个100k基准显式ignored，exit0（`.artifacts/T105-b1-rust.log`）；移除定位日志后原生5项再验exit0（`.artifacts/T105-b1-native-final.log`）；`cargo build --locked --offline` exit0（`.artifacts/T105-b1-build.log`）；typecheck/lint、TS81、clippy均exit0。这是Rust原生系统API证据，未重建Release、未声称Tauri删除入口或Web删除E2E通过。
- 排错：COM实现宏需要直接windows-core依赖（首编译E0433）；真实Shell创建项曾对`\\?\`路径返回E_INVALIDARG/0x80070057，现仅在传入Shell前去掉扩展前缀，安全核验仍使用canonical路径。测试还收紧为必须触发PreDeleteItem的永久删除专用拒绝，避免前置错误假通过。失败测试残留的9个UUID fixture已在验证绝对目标及无reparse后清理。
- 下一步T105.b2：grant/expectedRevision/requestId、删除前dirty快照落盘、已打开文档缺失标记、真实确认与树状态；尚无生产trash_entry命令或删除按钮。最新可交互Release仍为上节T105.a hash。

## T105.a 树内新建与重命名完成（2026-11-01，T105仍进行中）

- 功能追踪：F-WORK-004完成、F-FILE-017的新建/重命名部分完成；F-WORK-005与回收站删除尚未实现，T105保持[~]。
- Rust `services/file_ops.rs`、`commands/file_ops.rs`、models/grants/documents/directories/windows_file与ACL接真实create_entry/rename_entry；TS contracts/bridge、workspace的file-actions/EntryInput/Explorer/store、editor registry与App接树内交互和文档路径映射。新建排他、不覆盖碰撞；Windows保留名/非法字符/UTF-16长度/越界/链接/旧revision均在Rust复核，requestId绑定payload回放。
- 文件改名更新lease；目录改名释放后代文件句柄、移动后按原FileIdentity与最终路径重开并恢复原DocumentId，失败尝试回卷及重绑。没有扩大FILE_SHARE_DELETE。大小写改名使用唯一中间名；目录revision大小固定0，文件使用原始大小。创建/改名后刷新当前及直属上级目录，切根后迟到结果不污染新根。
- 已执行：typecheck/lint exit0；TS单测81 passed；Rust全套73 passed、1个100k基准显式ignored；Web E2E27 passed；cargo fmt/clippy、pnpm build均exit0；pnpm test:desktop 1 passed（1.1分钟）。最终`powershell.exe -NoProfile -File scripts/check.ps1` exit0（含TS81/Rust73/Web27/fmt/clippy），日志`.artifacts/T105-a-final-check.log`；文档校验exit0（178文件/142链接/86功能），diff检查exit0。第一次最终整链Web为26通过/1失败，原因是mock未同步改名后的目录事实；修正fixture使后续list返回新名称后，定向workspace和最终整链通过，未放宽产品revision或断言。
- 原生范围：真实Release/OS目录选择器/NTFS/IPC，新建文件自动打开、新建目录、保留名拒绝、碰撞不覆盖、文件改名保留dirty与原DocumentId并保存到新路径、目录含已打开dirty后代时仍可改名且保存到新路径。Web E2E为明确mock，Rust文件行为和原生Release另验。
- 证据：`.artifacts/T102/native-release.json`的nativeWorkspaceObservation新增nativeCreateFileVerified、nativeCreateDirectoryVerified、nativeReservedNameRejected、nativeCollisionPreserved、nativeRenameKeepsDocumentIdAndDirtyBuffer、nativeRenameSaveUsesUpdatedPath、nativeDirectoryRenameKeepsDocumentIdAndDirtyBuffer、nativeDirectoryRenameSaveUsesUpdatedPath均为true；`.artifacts/T104/native-workspace-tree.png`已视觉检查。
- Release：`src-tauri/target/release/featherpad.exe`，10,544,128 bytes，SHA256 `23FE13DCBB164AEF1640E13CE7E216D363367B275C461951711CDFE438AF5063`。下一步T105.b：真实回收站、dirty前置决策、成功保留缺失缓冲、失败不移除树项、绝无永久删除回退；恢复/G1及完整v1尚未完成。

## T102 安全保存闭环完成（此前切片，2026-11-01）

- F-FILE-003、F-FILE-004、F-FILE-005、F-FILE-009完成。此前已验收保存/另存/副本/全部保存/已有目标覆盖/硬链接确认、保存事务强杀，以及真实Tauri提交后Ack前终止；本轮补齐真实满盘故障，故T102不再保留磁盘满阻塞。
- `tests/desktop/disk-full.ts`在本机已有Ubuntu WSL2中创建唯一UUID命名的16MiB `tmpfs`，Linux端填满后真实返回`ENOSPC`；该文件经`\\wsl.localhost`由真实OS选择器和Tauri Release打开。编辑后CtrlS在`write-temporary`阶段失败，UI显示恢复receipt与阶段，编辑器及当前输入保持dirty，源文件SHA256不变。
- 测试随后按receipt读取E盘私有保存事务：`manifest.json`、`body.bin`和`original.bin`存在，body摘要与manifest一致、original摘要与源文件一致，`original.bin`文本等于满盘前源文件。测试结束先终止Tauri，再lazy detach并删除WSL挂载，未残留`featherpad-fault-*`挂载或目录。
- `scripts/Select-ControlledFixture.ps1`新增仅测试用的`open-fault`动作：只接受manifest绑定的`\\wsl.localhost\Ubuntu\mnt\featherpad-fault-<32hex>`根、UUID ownership token、真实Tauri PID/父worker/exe hash及源hash，不增加生产IPC或任意路径授权入口。
- 限制：Windows WSL 9P把底层`ENOSPC`映射为`ERROR_GEN_FAILURE (31)`，不是原生NTFS磁盘满的`ERROR_DISK_FULL (112)`。为隔离该限制，`io_error`新增Windows 112→`DISK_FULL`及“磁盘空间不足”专用文案的Rust单测；本次原生证据仍然证明真实满盘时的数据安全，但不宣称已完成物理NTFS小卷演练或断电恢复。
- 实际检查：`pnpm typecheck`、`pnpm lint` exit0；`pnpm test:unit` 74 passed；`pnpm test:integration`为Rust 68 passed且100k benchmark显式ignored；`pnpm test:e2e` 27 passed；`pnpm build` exit0；`pnpm test:desktop` 1 passed（1.1分钟）；`cargo fmt --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`node scripts/validate-docs.mjs`与`git diff --check`均exit0。
- 原生证据：`.artifacts/T102/native-release.json`的`nativeDiskFullVerified:true`；observation记录`backingFilesystemFullVerified`、`sourceFileUnchanged`、`editorBufferPreservedAndDirty`、`recoveryReceiptFound`、`recoveryBodyMatchesIntendedText`及`recoveryOriginalMatchesSource`均为true，failureStage为`write-temporary`。`.artifacts/T102/native-release-disk-full.png`已视觉检查。
- 当前Release：`src-tauri/target/release/featherpad.exe`，10,366,976 bytes，SHA256 `9DFA0600EA304BE2DD352106A5C08E431A7E87F82FE45280CC885C2F03ABAD93`。主JS chunk仍609.67kB（gzip 196.96kB），保留Vite警告。下一项T105；T107依赖已满足，恢复/G1以后仍未完成。

## T108 文件内搜索替换完成（此前切片，2026-11-01）

- F-SEARCH-001、F-SEARCH-002、F-SEARCH-003完成。CtrlF在当前CodeMirror文档打开非模态面板，支持字面/安全正则、大小写、Unicode字母/数字/下划线整词边界、显式选区范围、上下导航、环绕提示、高亮、当前定位、总数和匹配摘要；Enter/Shift+Enter导航，Escape关闭后保留查询并恢复编辑器焦点。
- 搜索在本地module worker执行，5秒watchdog限制病态输入；新查询立即终止旧worker并丢弃旧generation。受控病态正则场景从输入新查询到新结果显示为25.64ms，低于250ms取消目标。单文档最多保留10,000处，超出明确截断；模式上限按UTF-8字节执行10KiB。未来不适合交叉语义的`\b`/`\B`、look-around和回溯引用会明确拒绝并引导使用“整词”，不静默扩大JS `RegExp`语义。
- `tests/fixtures/search-semantics.json`由TS worker与Rust `regex` crate两端读取，覆盖字面/大小写、Unicode整词、选区、非捕获/命名组、多行零长度、Unicode属性和UTF-16偏移。该夹具是当前公开安全子集的代表证据，不声称全部Rust regex语法均已等价。
- 替换支持字面文本、`$1`、`${name}`、`$$`及显式`\n`/`\t`解释；非法组引用行内报错。单个替换后定位下一处；全部替换在单个CodeMirror transaction完成并只产生一次undo，不自动保存。文档registry绑定唯一view，替换前校验expectedVersion、文档仍存在、非只读且范围单调有效；旧搜索结果不能写回变化后的缓冲。
- 只读文件可查找和导航，替换输入及按钮禁用并显示“只读文档仅支持查找”。选区随缓冲版本变化时安全重置全文，不继续使用旧offset。
- 实际检查：`pnpm typecheck`、`pnpm lint` exit0；`pnpm test:unit` 74 passed；`pnpm test:integration`为Rust 67 passed且100k benchmark显式ignored；`pnpm test:e2e` 27 passed；`pnpm build` exit0；`pnpm test:desktop` 1 passed（56.8秒）。最终`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、文档校验与`git diff --check`见提交前检查。
- 原生证据：`.artifacts/T102/native-release.json`的`nativeSearchVerified:true`；`nativeSearchObservation`记录Unicode/大小写、整词、导航和环绕、非法正则、捕获组替换、全部替换单次undo、选区范围及只读查找均为true。真实只读fixture SHA256在测试后保持`5CF5863A08ECF95927A508F08CF2493DEED211022497D3A7478EB7D1BBB79F1F`。`.artifacts/T108/native-search-editable.png`、`native-search-readonly.png`及Web `search-web.png`已视觉检查。Web取消证据为`.artifacts/T108/cancellation-web.json`。
- T108验收时Release为10,367,488 bytes、SHA256 `09C3842A4BA28ACF752EA0AE05741886E7E7385BDAA25F0511233DFDEED4E039`。该hash已被上方T102最终Release取代；T108证据本身未过期。T108通过时T102仍待验，后续由上方完成。

## T106 真实编辑内核完成（此前切片，2026-11-01）

- F-EDIT-001、F-EDIT-002、F-EDIT-003、F-EDIT-008、F-EDIT-018完成。文档registry继续独占CodeMirror事务与文档历史；标准编辑、两套redo快捷键、按词/行移动、全选、剪贴板、保存后保留undo、单事务多行空格缩进和2/4/8视觉列均已接真实编辑器。React只接收状态与指标通知，不在每键维护全文。
- 状态栏按Unicode code point显示字符数和选区字符数，按tabSize计算视觉列；纯光标移动不发布正文快照。括号匹配与自动配对使用独立Compartment，可分别关闭；冒号等输入法组合内容由CodeMirror composition事务提交，不触发重复配对。
- 本地语言包按需加载并精确锁定：纯文本、Markdown、JSON/JSONC、XML、HTML、CSS、JavaScript/TypeScript、SQL、YAML、Java、Rust、Python、Shell、TOML、INI/Properties及日志纯文本回退。扩展名检测、手动语言选择、另存为后自动重判和过期异步加载丢弃均已覆盖；语言/缩进/括号设置及选择、undo跨文档切换保持。Java只声明高亮与括号能力，不暗示formatter/LSP。
- 实际检查：依赖用`pnpm add --save-exact --ignore-scripts`加入并审查脚本；`pnpm typecheck`、`pnpm lint` exit0，`pnpm test:unit` 63 passed，`pnpm test:integration`为Rust 66 passed且100k benchmark显式ignored，`pnpm test:e2e` 22 passed，`pnpm build` exit0，`pnpm test:desktop` 1 passed（56.0秒）。最终`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`git diff --check`均exit0。`pnpm audit --audit-level high` exit1只因既有ESLint→minimatch开发依赖moderate，未自动强制修复。
- 原生证据：`.artifacts/T102/native-release.json`的`nativeEditorVerified:true`，`nativeEditorObservation`记录状态/选区、undo/redo、词导航、缩进、Java高亮/手动选择、括号开关、WebView2 composition和系统剪贴板粘贴均为true；`.artifacts/T106/native-release-editor.png`、`editor-web.png`已视觉检查。随后用Windows Computer Use在真实Release CodeMirror中切到微软拼音，观察到OS候选窗显示拼音`h`和候选“好”，按空格提交后正文`z好`、行1列3、2字符；该桌面观测记录在`.artifacts/T106/os-ime-observation.json`，未使用生产测试钩子。
- 当前Release：`src-tauri/target/release/featherpad.exe`，10,359,808 bytes，SHA256 `883DEBB2CC260B5AF276FB4CB831E2F9D8E0F23527DCA050A8A9C7787A86DFA7`。构建仍有单个主JS chunk 594.21kB（gzip 191.73kB）的Vite警告，未修改阈值。此证据是Win11/WebView2真实进程与IME，不外推Win10、OS缩放或全部输入法；下一项T108，G1仍未通过。

## T104 单根目录树完成（此前切片，2026-11-01）

- F-WORK-001、F-WORK-003完成。`choose_folder`现在返回内存目录grant和安全根显示名；树只读取授权根的直接子项，展开目录时才按需请求下一层。替换根不清dirty文档、不重建CodeMirror；树文件点击复用真实`open_document`，工具栏和欢迎页均可打开/替换根。空根、空子目录、无权限后的行内错误与重试、刷新、当前文件逐层定位、隐藏项开关、只读/链接标记和树形键盘导航均已实现。
- Rust `list_directory`默认200、最大1000条，文件夹优先、自然排序；cursor绑定grant根、canonical目录、目录项签名、隐藏过滤和偏移，目录变化后旧cursor返回CONFLICT。目录解析再次校验grant、相对路径和canonical边界；枚举期间以不共享删除的句柄锁住父路径链和目录本身，并对打开句柄的最终路径复核，缩小junction换名竞态。重复选择同一canonical根复用原grant，使原先打开文档仍可定位且不扩大授权。
- 刷新会按路径子树作废旧请求和缓存，同时保留展开身份；新一页返回后仅重载仍存在的展开目录，旧请求晚到不会覆盖新结果。真实原生场景在刷新新增文件后仍保留已展开的当前文件。
- 100k真实目录首版Release首分页为3,204ms，超过既定300ms硬预算，未降阈值。改用`FindFirstFileExW`、`FindExInfoBasic`和`FIND_FIRST_EX_LARGE_FETCH`，旧文件系统对basic级别不支持时回退标准级别；加入路径锁后最终首分页159.669ms、200项并正常发cursor。原生UI另用205项真实子目录验证首屏200、加载更多后205。
- 本切片实际检查：`pnpm typecheck`、`pnpm lint`、`pnpm test:unit`（38）、`pnpm test:integration`、`cargo test`（66 passed，1个100k benchmark为显式ignored）、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`pnpm test:e2e`（17）、`pnpm build`、`pnpm test:desktop`（1，55.2秒）均exit0；100k Release benchmark exit0。没有新增依赖或工具。审查补正后在最终Release上重跑静态/单元/E2E/构建/原生综合和Release基准。
- 原生证据：`.artifacts/T102/native-release.json`的`nativeWorkspaceVerified:true`，observation记录lazyNestedLoad/pagination/hiddenFilter/emptyRoot/permissionDeniedRootAndRetry/currentFileLocate/refresh/keyboardNavigation/dirtyDocumentPreservedOnRootReplacement/junctionBoundaryRejected均为true；`.artifacts/T104/native-workspace-tree.png`已视觉检查，显示中文根/目录、当前文件、只读/链接标记和dirty编辑。`.artifacts/T104/directory-scale.json`记录100k文件、200项、159.669ms/budget300ms。Web E2E仍是明确mock，只证明同一前端交互；原生根、NTFS ACL、真实文件、真实IPC和OS文件夹选择器另验。
- T104验收时Release为10,176,000 bytes、SHA256 `BF73C9C9E7DCA54E511D37DB8198F68FAFB3E067FD68BE142B80D8EA1E4AEA41`。实现采用分页而非虚拟化，因此不声明超大目录整表渲染通过。

## T103 大文件模式完成（历史切片，2026-11-01）

- F-FILE-013完成。`open_policy.rs`继续作为2/20/100MiB原始字节阈值的唯一入口：≤2MiB normal、>2且<20MiB完整降级、20–100MiB只读分块、>100MiB自动打开拒绝且仅由用户显式选择前1MiB预览。`stream_snapshot.rs`用固定64KiB缓冲完成全文件摘要、UTF-8/UTF-16流式校验、换行统计和受控窗口；初始/后续块默认64KiB，后续请求上限1MiB并校验DocumentId、片段handle、磁盘revision及编码边界。旧revision返回CONFLICT。完整只读普通文件仍可另存；大文件片段由Rust文档lease标记，保存、另存和副本均在服务层返回READ_ONLY。
- 动态增长已收紧：文件在可编辑读取时跨过20MiB会重新打开并按真实大小进入分块；跨过100MiB只返回可选择前1MiB预览的TOO_LARGE；未越上限但读取期间变化的文件返回CONFLICT，不返回截断正文。`LargeFileView`只持有当前64KiB页及页起点历史；上一块从已读精确起点重新请求，不在React中累加正文。>100MiB流程先关闭自动读取，用户明确点击后才调用head-preview。
- 真实边界证据：Rust实际文件覆盖2MiB−1/2MiB/2MiB+1、20MiB−1/20MiB/20MiB+1、100MiB/100MiB+1；并发真实写入使读取跨过20MiB和100MiB上限均得到TOO_LARGE，未越限增长得到CONFLICT；另用“初次观察为可编辑大小、实际文件已增长”的路径验证自动分块重判。流式20MiB摘要与既有全文件快照一致且只保留小窗口；100MiB扫描保留零正文窗口，末尾UTF-8窗口精确。原生Release打开受控20MiB文件后可前/后分页，单页<64KiB+16字符，源文件SHA256不变；100MiB+1文件自动打开被拒，用户明确选择后显示前1MiB预览且保存/另存禁用，源文件SHA256不变。
- 本切片实际检查：typecheck/lint、TS33、全Web16（分块下一页只显示新页、上一页恢复且保存入口禁用；Web mock与原生证据独立）、Rust全套61、`cargo fmt --check`、`cargo clippy --all-targets -D warnings`、Release build及真实桌面综合1（43.0秒）均exit0。没有新增依赖/工具。原生截图`native-release-large-chunk.png`显示第1页65,536字节/20,971,520字节及上一/下一按钮，`native-release-head-preview.png`显示截断前1MiB；均已视觉检查。`native-release.json`记录nativeLargeChunkReadonlyVerified=true、nativeHeadPreviewVerified=true。
- 当前Release：10,088,960 bytes，SHA256 `1472127164a831ac654bd3985b757b6da14ef02ed5fc1cd936ce5b8747257633`。Win11/WebView2 156.0.4314.58、浏览器offline重载。单次开发机观测：20MiB分块首屏上界1,116.8ms（含受控原生选择器自动化），100MiB打开到预览选项上界1,596.4ms，用户预览动作361.2ms；该长流程进程树私有工作集约348–444MiB。计时不是10次p95/目标机结论，内存也高于SPEC的180MiB目标，故不标M5性能通过，后续bench:app与常驻预算继续复核。
- T104和T102磁盘满此后已由上方最新切片完成。以下T102/T103各节保留实施时的历史状态；当前结论、最终Hash和下一项以上页记录为准。

## T103.a 完整降级编辑（历史切片）

- 完整可编辑降级已接真实纵向切片：原始字节≤2MiB normal、>2且<20MiB degraded；初次stat与实际读取均有20MiB排他上界。Unicode单行>100,000字符触发degraded；UTF-16/换行/二进制保护不变。真实Rust覆盖2MiB±1、20MiB−1和100,000/100,001 emoji长行，2MiB+1编辑后保存全字节正确；原生受控OS选择器打开2,097,153 bytes文件，中文emoji编辑保存后整份字节匹配。
- 当时TS31/Web14/Rust50/Release/真实桌面1均exit0，Release为9,961,472 bytes、SHA256 `8A18D66E9589CA2EC46FEA65AA5AFA536A1F15F9C561C9B0A3E2895532FF0814`；截图模式和200% CSS检查见M1验收。该历史切片不包含分块/预览，已由上方T103完成项补齐。

## T102故障恢复点（历史，2026-11-01 16:51）

- T102/F-FILE-009进程终止故障新增真实证据：`src-tauri/tests/save_interruption.rs`用同一Rust集成测试exe的私有stdin屏障，在TemporaryReady或Committed后确认子进程仍活着，再通过所持Child handle强杀。替换前原件未变、临时正文与original/body blob及摘要齐全、无replacing/committed；提交后新字节与committed保持；放行同屏障的正向对照实际提交且exit 0。两个被杀worker均exit 1，无ignored测试、无生产钩子/假IO。新FileService重开核对磁盘，不自动修复或冒称会话恢复。最终3项result在`.artifacts/T102/interruptions/{3851fc2f-de45-4b2f-9c3b-04f0a8fe4c74,a52a2f3f-de91-4c24-8ddb-6e7ba1ce6e6f,743f902a-0a65-4d2e-9fa6-8848cd82975c}/result.json`。
- 真实Tauri Release强杀：`tests/desktop/forced-exit.ts`利用现有框架debug callbacks只暂缓一次真实SaveAck交付，不改返回/磁盘/grant。实际目标/body.bin字节及唯一committed receipt验证完成，UI仍正在保存时终止本轮spawn的Tauri子进程，终止后再核对目标/body/committed正确。`.artifacts/T102/native-release.json`新增nativeForcedExitVerified=true，forcedExit记录ackDelivered=false、实际signal=SIGTERM/exitCode=null及receipt/hash；这是Windows Node Child.kill结果，不冒称重启会话恢复或物理断电。
- 本切片检查：Rust全套46（新增3）/fmt --check/clippy --all-targets -D warnings、typecheck/lint、真实Release综合1（44.7秒）均exit 0。首编译测试时间戳误用未启用clock的Utc::now，E0599/exit101；改用现有SystemTime转换后通过，未加依赖/feature。生产代码未变，沿用9950208 bytes、SHA256 `4320A43CD7E1E04E23E610EA1B73F84C52D2D4B0C193845CEBDFD7BB9DFCE6C3`的Release；本轮未重复Web/TS单测或重建不变产品。
- 磁盘满具体缺口：`powershell.exe -NoProfile -File scripts/Probe-FaultVolume.ps1`仅尝试在E盘独立UUID目录创建64MiB动态VHDX，exit1；New-VHD返回“没有所需权限”、errorId=Unspecified,Microsoft.Vhd.PowerShell.Cmdlets.NewVhd，HResult=-2146233088。`.artifacts/T102/fault-volumes/cf75923e-e034-4bf1-935b-7efe5737de97/probe.json`证实created/imageExists/mounted/formatted均false；没有挂载/格式化/填盘，没有安装工具或修改权限策略。该权限缺口只阻塞此真实磁盘满方案，不把整个Goal标blocked。
- T102仍[~]，真实磁盘满待具备受控小容量卷权限后补验；T110启动扫描/预算、恢复与热退出仍未实现。接下来按目标的“先做不受影响且依赖就绪项”推进T103大文件模式（依赖T101已通过），不反复重跑同一New-VHD失败，不用mock磁盘满替代，不标G1或完整v1通过。

## T102硬链接恢复点（历史，2026-11-01 16:38）

- T102/F-FILE-003/009普通CtrlS硬链接确认已接真实IPC/Release：先begin_save回放已知结果，再只读检查授权目标/磁盘revision及link_count；不可Deserialize确认对象绑定完整快照摘要和canonical路径，No缓存CANCELLED且不写事务，Yes重验路径/revision/权限/身份后复用保护替换。原生确认等待不持有FileService锁，无新IPC字段/路径/权限。全部保存取消文案统一为“已取消保存”，兼容路径与硬链接确认的取消。
- 自审补充原生DocumentId互斥：旧在途表只拒绝同requestId，等待弹窗释放锁后同文档不同requestId可能重复进入；现同文档保存/As/Copy在途均BUSY，不同文档及stat不受该文档等待阻塞。保留同ID异payload INVALID_INPUT、RAII释放与512条结果缓存。补普通保存documentVersion JS safe integer校验，不能通过非法大版本制造确认。
- 检查实际通过：环境探针；typecheck/lint/TS31；全Web13（包括改取消文案）；Rust全套43（新增4，protected_save现16）；clippy --locked --offline --all-targets -- -D warnings；Release build、真实桌面综合1项均exit 0。第一版硬链接UI原生47.1秒通过；加文档互斥与并发原生断言后重跑Rust全套/typecheck/lint/build/native，最终44.6秒通过。未因信心重复无变更的Web测试，未冒称check.ps1整链再运行。
- 原生证据：创建真实Windows硬链接→OS选取原路径→编辑CtrlS→inspect时两条路径仍原字节；此时真实stat成功，第二个同DocId不同requestId保存BUSY，证明无服务锁等待/无重入写入。No保正文/dirty/双路径原字节；下一CtrlS Yes只改原路径、别名旧字节且tab/DocumentId不变。打开旧别名得到独立文档，再加别名，在确认显示后真实外部写入，Yes触发CONFLICT、双别名外部字节和内存输入均保留，第一已保存路径不受影响。此前全部保存/覆盖/副本/迟到Ack/越权拒绝均原生回归。`.artifacts/T102/native-release.json`新增nativeHardlinkConsentVerified=true；hardlink步骤JSON、`native-release-hardlink-{saved,conflict}.png`为证据，截图已视觉检查。
- 当前Release：9950208 bytes，SHA256 `4320A43CD7E1E04E23E610EA1B73F84C52D2D4B0C193845CEBDFD7BB9DFCE6C3`；Win11/WebView2 156.0.4314.58、浏览器offline重载，非Win10/IME/OS缩放/断电证据。确认核心首切片已提交`f0833fd`。没有新增依赖/工具安装。
- 最后cargo fmt --check、文档静态检查（130文件/27 Markdown/141链接/86功能/57任务覆盖）和git diff --check均exit 0；文档检查不是产品验收。最后通过后仅更新交接文档，产品/行为测试未再改动。
- 下一仍T102受控磁盘满/强杀；T110启动扫描/预算/恢复、关闭保护尚未实现，T102/G1不勾选。故障环境只读盘点：当前非提权，已有New-VHD/diskpart，无imdisk；尚未执行挂载或填盘，不据此宣称外部阻塞或磁盘满已测。后续先验证受控E盘小容量卷方案，不能填满宿主盘；有权限缺口时推进不受影响的进程终止测试及依赖就绪任务。

## T102覆盖恢复点（历史，2026-11-01 16:23）

- T102硬链接确认第一切片：`save.rs`新增原生不可Deserialize的确认对象，绑定完整请求摘要/canonical路径；只读检查多链接，不创建journal，确认后重验快照/revision再准备写入。`save_requests.rs`拆出begin_save/finish_save，在弹窗前回放已知结果，取消也可缓存；既有save_existing复用相同缓存。受控protected_save 15 passed（新增3：未确认零写入与别名字节保留、改快照/确认期间外改拒绝、取消缓存回放），clippy --all-targets -D warnings exit 0、cargo fmt执行成功。当前尚未接原生CtrlS弹窗，不声称新Release或硬链接GUI完成；继续IPC适配/原生验收。
- T102/F-FILE-004原生已有目标覆盖/副本/碰撞已验收：新增`tests/desktop/overwrite.ts`，真实系统覆盖确认后另有绑定revision的应用确认；拒绝覆盖保原目标/无标题正文/dirty，inspect确认窗口后真实外部写入再Yes触发CONFLICT且不覆写；重新确认成功后同一tab/DocumentId绑定已有目标、字节正确。保存副本选源文件被拒绝，覆盖其他已有目标时副本字节更新而源路径/原字节/dirty保持；目标为另一打开文档时拒绝且双方保留。不是Web mock。
- 原生helper扩展仅准单个已存在的受控小文件，仍检查E盘fixture根/无reparse/哈希/测试exe/PID/父worker；系统/应用确认分别限定标题、目标文本和唯一启用是/否按钮，UIAutomation只读取该owned确认框且限100个Text元素。文件选择提交用异步PostMessage避免嵌套OS确认阻塞；实际Button用BM_CLICK路由真实通知。inspect仅校验，不发送点击，JSON commandInvoked=false。没有生产IPC改动、没有新依赖/安装。
- 排错证据：desktop先因“Expected exactly one owned, named overwrite confirmation” exit 1；追加owned控件诊断再现exit 1，确认系统对话框为“确认另存为”、DirectUIHWND/Button ID0；改为标题/按钮文字后又因WM_GETTEXT无法读DirectUI目标文本而“Overwrite confirmation is not for the controlled destination” exit 1。读取已锁rfd TaskDialog实现及微软按钮/异步消息文档后，使用已有UIAutomation系统程序集验证目标文字，定向原生综合通过；再扩展同ID/副本覆盖/同源拒绝后typecheck/lint及desktop综合1项exit 0（37.5秒），不改timeout/断言。
- 当前Release仍为9935360 bytes、SHA256 `81349CFF6D7FE0A7CF68A4035C4596D7E6468CEEF61BA4D117FD1633A45CBF74`（本覆盖切片只改测试/helper，无需重建相同产品）；`.artifacts/T102/native-release.json`记录nativeExistingOverwriteVerified=true及既有全部保存/保存/另存/副本等回归。`native-release-overwrite-{copy,collision}.png`已视觉检查；Win11/WebView2 156.0.4314.58、浏览器offline重载，非Win10/IME/OS缩放证据。
- 文档静态检查`node scripts/validate-docs.mjs` exit 0（129文件/27 Markdown/141链接/86功能/57任务完整覆盖），git diff --check exit 0；没有把文档检查计为产品测试。最后成功后仅追加证据文档，未继续修改被验证的代码。
- 下一T102普通CtrlS硬链接原生确认（现仍安全拒绝，Rust确认核心已测），真实磁盘满/强杀；T110启动扫描/预算/恢复和关闭保护仍缺。不标T102/G1或完整v1通过。全部保存与F-FILE-002授权单项失败已完成，不再重做。

## F-FILE-002恢复点（历史，2026-11-01 16:13）

- F-FILE-002授权单项失败补正已接完整UI/bridge：choose_files返回成功grant与零基选择序号/安全AppError，guard拒绝坏索引/重复索引/坏错误；App先收集授权失败再逐项open其余成功项，失败不清已有正文。Rust真实授权有效/缺失/有效仍读出两份，转换/类型失败逐项反馈，取消两个空数组；Web混合授权/open失败仍打开两份，全部授权失败保已有dirty草稿、随后取消清提示。没有路径IPC/测试后门，没有回传系统原始路径。
- 本修复检查：typecheck/lint/TS31 exit 0；全Web12 exit 0，新增全部失败场景后定向documents3 exit 0（共13个独立Web场景，未声称该命令一次全量13）；Rust全套39、fmt --check、clippy --all-targets -D warnings exit 0；pnpm build、真实Release桌面综合1 exit 0。原生GUI验证正常选择器→新DTO→真实打开/保存/全部保存回归；授权失败分支由Rust真实文件测试+Web UI分别证明，没有声称OS对话框精确注入了缺失项。
- 当前Release为9935360 bytes，SHA256 `81349CFF6D7FE0A7CF68A4035C4596D7E6468CEEF61BA4D117FD1633A45CBF74`，`.artifacts/T102/native-release.json`含该hash及nativeSaveAllVerified等true。既有保存/另存/副本/批次真实磁盘结果回归通过；WebView2 156.0.4314.58，浏览器offline重载。无新依赖/工具安装。全部保存已提交`1a80eb9`，授权Rust切片`fe4186b`。
- 下一仍T102：原生已存在目标覆盖/取消/碰撞GUI验收、普通CtrlS硬链接确认、真实磁盘满/强杀；T110事务扫描/预算与恢复/关闭保护尚未完成。T102/G1及完整v1均未通过；不要重做已完成的全部保存或授权单项失败修复。

## T102.c3恢复点（历史，2026-11-01 16:05）

- F-FILE-002补正第一切片：先更新CONTRACTS，再把choose_files的collect整批失败改为GrantRegistry逐项收集成功grant及`{selectionIndex,error}`；取消两个空列表，不回传原始失败路径。受控Windows授权测试5 passed（新增2：有效/缺失/有效仍可读两份，转换/类型失败与取消），clippy --all-targets -D warnings exit 0，cargo fmt已执行。此时前端尚未显示failures，继续桥接guard/UI与回归，不提前记完整修复或新Release。
- T102.c3/F-FILE-005全部保存已实现：`save-all.ts`固定开始时dirty文档列表，复用SaveCoordinator逐项保存，不预复制全部正文；单项失败继续其他独立项，原生路径取消/停止后续保存则等当前真实结果后停止。`SaveAllResults.tsx`逐项列成功/失败/取消/未处理与总体进度，支持点击定位文档、关闭回焦；实时显示保存后仍有的新输入及全部当前dirty计数，不伪报全局已保存。App接真实入口并阻止批次期间其他手动保存快捷键；CSS让200%结果列表可滚动且关闭按钮固定可见。规格先记录了批次/取消语义，无新增IPC/依赖。
- 本切片已执行：Probe-Environment、typecheck/lint、TS30（新增4）、全Web12（新增3）、Release build、原生桌面综合1项均exit 0；200%滚动结果头部小调整后定向Web3 exit 0。Rust生产未改，本切片没有冒称重跑Rust全套；此前37项记录仍保留。真实Release五文档：前两份UTF8/CRLF中文emoji字节保存正确，第三份外部变化CONFLICT且外部字节不变，第四份原生Cancel，第五份未处理；第三/四/五正文和dirty都正确。证据`.artifacts/T102/native-release.json`与`native-release-save-all.png`，以及`save-all-failure-web.png`（Web mock，200% CSS zoom）；截图已视觉检查。
- 最后CSS调整后Release build/原生桌面综合1项复验exit 0；当前exe为9955840 bytes、SHA256 `41DF8AB018AC8A5821657EE7F381A3D721CCCAB275DED370FBBDA2C4B4372026`。`node scripts/validate-docs.mjs` exit 0，128 files/27 Markdown/141 links/86 features/57 tasks覆盖，无失败；仅文档静态检查，不是产品行为验收。
- 上轮未提交的另存UI/bridge/controller及原生helper/测试/文档已保存为`432cf33`；本轮重新运行其typecheck/lint/TS26 exit 0后继续，未重建既有工程。当前T102仍进行中：下一原生既有目标覆盖/碰撞与硬链接确认，磁盘满/强杀及T110启动扫描/预算/恢复/关闭保护尚未完成；F-FILE-002授权注册阶段单项失败回归也仍待修复。不标T102/G1通过。

## T102.c2恢复点（历史，2026-11-01 15:40）

- T102.c2新目标另存/副本已接真实UI/IPC：未命名CtrlS进入原生保存选择器，取消保留正文/无标题/dirty；成功后同一DocumentId绑定新路径。CtrlShiftS/另存、保存副本有真实入口；copy成功只显示目标结果，源路径/dirty/undo不改。未知As结果保留原捕获请求，重试同requestId取回结果后再保存较新输入，避免重复选择器/盲写。只读完整UTF8另存到可写路径可继续编辑，mixed/UTF16仍按M1策略只读。
- 最新检查：typecheck/lint/TS26、Rust全套37、fmt/clippy、Web9、Release build、原生桌面综合1项均exit 0（分开实际运行）。Web9在与Release编译并行时首批5个page.goto 30s超时、尚未进入功能断言，trace本地请求12–15s；编译结束后原配置单独复验9 passed，未修改timeout/worker/断言。以后将Web验证与原生编译分开，独立只读检查可并行。
- 当前Release：`src-tauri/target/release/featherpad.exe`，9954304 bytes，SHA256 `8AE2488D45561ADB6D290D0D9FA194A830C7482F27E9CF28D8D4989E3CFD72BD`。`.artifacts/T102/native-release.json`的newSaveAs/cancel/copy及已有save/conflict/delayedAck均true，WebView2 156.0.4314.58，浏览器offline重载。真实保存选择器两次路径选择写UTF8/CRLF中文emoji，副本写入新输入而源文件仍旧字节/源仍dirty，后续普通CtrlS才写源；源标题/路径保持，IPC提交path字段拒绝。`native-release-save-as-copy.png`已视觉检查。
- 原生辅助器调试：cancel已通过后，save查不到1148文件名控件，desktop exit 1；增加有限初始化等待仍失败，诊断只记录owned进程class/ID/parent ID（不采集文件列表文字）。实测保存对话框Edit1001/ComboBox0，与打开1148容器不同，按action分别精确匹配且保持PID/exe/hash/根校验后通过。helper.save只准不存在的单一受控目标，cancel只操作该测试进程Cancel按钮。没有生产测试IPC或虚构保存。
- 下一：T102.c3全部保存的逐项结果/进度、取消后未处理与失败仍dirty；补现有目标覆盖/碰撞和硬链接确认的原生交互（覆盖核心Rust已验、普通CtrlS多硬链接目前仍安全拒绝）。还需磁盘满/强杀、T110事务扫描/预算与恢复/关闭保护，不标T102/G1通过。自审另记F-FILE-002后续回归：choose_files授权注册当前collect会在单项失败时返回整批错误，须保留其余成功授权并逐项反馈，不能只凭Web mock的open阶段单项失败算完整能力。

## T102.c2实施切片记录（历史，2026-11-01）

- T102.c2.e前端快照/绑定已验证：保存状态逻辑移到`document-save-state.ts`，registry保持唯一CM所有权；新增As快照/baseSource和Ack绑定检查，copy不能更新源baseline，mixed按原逐行映射捕获。CodeMirror editability用Compartment更新，另存到可写UTF8后可继续编辑且不清undo/选区。typecheck/lint/TS22 exit 0（新增5项），旧17项保存/queue回归通过。前端接口增加SaveAsRequest/Ack；下一按钮/快捷键/bridge与原生新建保存/取消验收。

- T102.c2.d原生另存入口已编译：save_document_as使用真实保存选择器，目标已存在时先capture revision再额外原生覆盖确认，取消返回CANCELLED并缓存；commit前重验。选择器期间不持有源服务锁，成功才绑定；copy同样选择器但不改源。main仅新增精确allow-save-document-as。clippy exit 0，尚未接前端/运行新Release，不能记OS另存验收通过。下一切片前端capture/As Ack/只读策略，再接按钮与原生受控保存/取消测试。

- T102.c2.c缓存准备：普通保存/另存共用512条结果缓存，变体区分Ack/SaveAsAck，As ticket只留key/hash不复制全文；Native picker前先查回放，取消也缓存。InFlight增加As请求入口，相同ID不同快照/intent拒绝、相同在途BUSY。Rust全套37 passed、fmt/clippy exit 0。保存私有目录resolver仅提升到commands内部可复用；继续原生另存IPC，尚无新Release。

- T102.c2.b：新增ExistingDestination，覆盖确认前捕获真实目标revision；通过独立目标writer复用已测试保存核心，保留实时源绑定直到完整成功。文档registry增加身份/规范路径占用查询，其他打开文档目标BUSY，副本同源拒绝，确认期间外部改动CONFLICT。新建提交也检查已有路径占用。初测9/10，唯一失败为fixture混合斜杠与Windows展示路径逐字比较，已改为Path语义比较并增加revision绑定断言；复验后提交。尚未接选择器/确认IPC，继续c2请求缓存与原生入口。

- T102.c2.a2：新增`PreparedCreation`真实新文件提交；journal expectedRevision可为null以区分新建与原本空文件，旧String记录仍可读。Native MoveFileExW同目录、无REPLACE_EXISTING/COPY_ALLOWED，目标出现报CONFLICT；持久化/字节核验成功才绑定源DocumentId，copy不绑定。保存错误保留原始行动说明并附receipt/stage。Rust全套32、fmt/clippy exit 0；新增内核禁止覆盖正例再验证后提交。未接新另存IPC/UI，Release仍是c1，继续既有目标/碰撞服务。

- T102.c2.a1：新增Rust SaveAsRequest/SaveAsAck（intent默认save-as、copy可选）和不可Deserialize的新目标授权类型；Native保存选择器才可授权，先规范父目录/验证设备保留名、ADS、非法字符、末尾点/空格、绝对路径/UTF16长度。`cargo test --locked --offline --test save_as` 2 passed、fmt/clippy exit 0。授权不创建文件，已存在目标拒绝并保字节。CONTRACTS先同步字段和取消/绑定语义。当前还未接创建核心或IPC，Release仍为c1；继续a2无覆盖提交。

- T102.b2.4/c1已验证：前端`SaveCoordinator`按文档串行，前一个Ack后捕获后续快照/expectedRevision；失败停止已排队写入，IPC结果未知时重试先stat，不清除新输入dirty。App接保存按钮/CtrlS/进度/错误，bridge运行时校验SaveAck/metadata。typecheck/lint/TS单测17、Web7、Rust全套26、fmt/clippy、Release build及真实桌面1项均exit 0（各命令实际分开运行，未声称新一轮check.ps1整链）。
- 当前Release：`src-tauri/target/release/featherpad.exe`，9814016 bytes，SHA256 `278489BBBC0B476DB04DDEA7035653B776BCA3F41C697436B347EF8FB45DFBAA`。`.artifacts/T102/native-release.json`记录chooser/multi/draft/save/conflict/delayedAck均true、WebView2 156.0.4314.58和浏览器offline重载。真实OS选取→原生授权→编辑→CtrlS→UTF8/CRLF中文emoji实际字节和journal正文一致；外部修改后CtrlS拒绝且保留内存和磁盘；伪造保存/损坏请求/未知stat拒绝。
- 原生迟到Ack证据：测试仅利用Tauri现有debug callbacks表延迟交付真实原生返回值，没有伪造IO/结果/grant或生产延迟IPC。实际字节已写入后保持Ack待交付，输入新字后释放原回执，UI仍dirty、磁盘仍是旧快照；下一次CtrlS才写入新字并clean。这不声称是在自然慢磁盘IO期间计时，也不是IME/OS缩放/Win10证据。初次尝试覆盖invoke未生效（框架readonly定义），desktop exit 1；读已锁定Tauri脚本定位后改用debug表，exit 0。截图saved/conflict/late-ack已视觉检查，历史T101/T002证据保留。
- 下一任务仍T102.c2：新建文档首次原生另存、取消保持正文、另存成功再切身份、同目标已打开碰撞保护、保存副本不切源、全部保存逐项进度/取消；补原生硬链接确认（当前IPC安全拒绝，Rust已测显式确认分离）、保存错误保留原始行动说明（当前journal消息可再改善）。还需实际磁盘满/强杀故障、事务启动扫描/容量预算（T110），不能标T102或G1完成。当前无恢复/关闭保护，不用早期版本编辑真实用户文档。

## T102原生保存切片记录（历史，2026-11-01）

- T102.b2.4 IPC编译/原生正负例通过：新增`commands/save.rs`的flat SaveRequest请求适配、save_document/stat_document精确ACL、native InFlight state。借用Request的async命令仅在Tauri适配层外包Result，实际线协议始终ResultEnvelope，真实Release已验证没有额外包装。状态目录默认local app data，环境`FEATHERPAD_USER_DATA_DIR`仅原生配置自定义本地状态目录，不授权用户文件；测试子进程E盘隔离。Rust26/fmt/clippy exit 0，原生Release保存/冲突与未知ID/损坏保存/未知stat拒绝通过；下一提交保存前端队列/UI与证据。

- T102.b2.3：保存缓存/在途登记/原生stat已接FileService；新增2项受控测试，protected_save 12 passed，clippy exit 0。相同请求回放Ack且mtime/journal数量不变，不同payload拒绝；在途相同请求BUSY、不同payload INVALID_INPUT，RAII退出释放。缓存512条，payload流式摘要与字段长度上限；Windows共享冲突映射BUSY。下一b2.4接最小ACL的save_document/stat_document和界面；还未重建Release。

- T102.b2.2已实现原生保存核心（尚未IPC/UI）：新增`save.rs`分prepare/commit、`save_journal.rs`原件/正文blob与不可变阶段记录、`windows_file.rs`ReplaceFileW/硬链接数/目录guard/按已验证句柄清备份。Rust全套24 passed（新增10个真实Windows磁盘保存场景）、fmt/clippy exit 0。覆盖CRLF中文emoji实际写入并重开同DocumentId，阶段间外改、同长度/同mtime改字节、只读/伪造ID/旧revision、硬链接确认与别名分离、真实共享锁定、日志目录不可用、临时文件被改和替换前记录失败，原件及快照正确。
- 目录guard初次使用只读共享导致ReplaceFileW失败，测试exit 101；改为目录FILE_LIST_DIRECTORY+READ_ATTRIBUTES、共享读写但不共享删除，保持父目录名称稳定并兼容子文件替换；补正控测试通过。win-sys FILE_DISPOSITION_INFO.DeleteFile为bool，初次编译exit 101已修复。没有压制测试或放宽断言。当前保存事务blob暂保留，T110接启动扫描/预算；还未接幂等、IPC、硬链接原生确认、UI/另存/副本/全部保存和实际磁盘满/强杀，不标T102完成。下一b2.3缓存/在途请求，再b2.4 IPC/既有文件CtrlS原生验证。

- T102.b2.1：拆出`services/documents.rs`（身份索引与DocumentLease）和`snapshot.rs`（受控有界读取/revision），读取侧复用同一算法，grant已打开句柄路径查询保持crate内部。Rust14与fmt/clippy exit 0；尚无保存IPC。下一切片接阶段清单/备份/替换，再重绑身份，避免保存后同一路径另开重复文档。

- T102.b1严格编码已验证：新增Rust `services/encode.rs`、SaveRequest/SaveAck models（deny未知字段）、TextFormat改owned字符串与读取侧转换；wire不变。Rust测试14 passed（原生磁盘10+纯编码/schema4）、fmt/clippy均exit 0。UTF8/UTF16、BOM、逐行混合换行字节往返及不一致/缺失/过期映射拒绝。没有新增依赖，没有写盘或保存IPC；Release仍是T101。源码提交后继续T102.b2，不重建现有工程。
- 下一步具体风险已核查微软官方ReplaceFileW/FlushFileBuffers：1176/1177部分失败可能移动原件，不能失败后盲删tmp；先持久化阶段清单并指定同卷backup，成功校验后清理。WRITE_THROUGH标志不受支持；sync_all不等于断电零丢失。替换后更新file ID索引/租约，明确硬链接别名分离行为。保存正文临时文件写前校验实际句柄范围。详见SPEC-file-core新增实施约束；尚无原生保存通过证据。T102.b2完成后再做IPC/串行队列/另存副本全部保存及原生故障闭环。

- T102.a已实现并验证：`SaveRequest/SaveAck`与registry冻结快照/Ack基线更新，typecheck/lint/TS单测13均exit 0。新增4项覆盖保存中继续输入仍dirty、matching Ack clean且undo不清、错配/回放Ack拒绝、无标题/只读不伪造保存目标。当前只有前端内存契约，没有保存IPC/磁盘写入，未重建Release，不宣称能保存。后续继续T102.b原生严格编码、受保护写入和幂等，再接UI/选择器。

- T101.a/b/c通过，`pnpm build`及`powershell.exe -NoProfile -File scripts/check.ps1 -Desktop`均exit 0：TS9/Rust原生10/Web6/真实Release1，含新增路径替换不复用旧ID、受权junction别名同ID。原生选择两份中文/空格/emoji fixture、各自随机UUID、编辑/切换/undo/redo/重开不覆盖dirty/CtrlN均通过，两个原文件hash不变。截图已视觉检查；未用Web mock代替原生。
- 早期Release：`src-tauri/target/release/featherpad.exe`，9552384 bytes，SHA256 `2DEAB6411E52999843CA1D069C3C3C248494F87D52FC1EBC39E133D356850E0A`。`.artifacts/T101/native-release.json`：WebView2 156.0.4314.58，`nativeChooserVerified:true`、`multiOpenAndDraftVerified:true`、`browserOffline:true`（浏览器网络offline重载，非物理断网/目标机验收）。M0历史证据保留T002。
- 文件：registry/editor-state/EditorDocument/App/CSS、原生identity/text/files、受控选择器helper与测试；对应F-FILE-001/002/014/015的本任务部分，详见`docs/acceptance/M1.md`。React仅订阅元数据，CM全文/undo/选区在registry；只读/混合换行/非UTF8目前安全只读。G1未通过，未提供保存或恢复；不要用此版本编辑真实用户文档。
- 下一T102：先读CONTRACTS的SaveRequest/Ack与SPEC保存章节，拆前端快照/迟到Ack、Rust受保护写入与幂等、原生另存/副本/全部保存及故障验证。首次保存取消、完整手动编码/只读试开、恢复、关闭保护仍在后续任务，不漏项。身份句柄释放由T107接入。

## T101启动与G0验收记录（历史，2026-11-01）

- T101.a原生身份/解码切片已验证：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --tests`（8项集成）、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings`均exit 0。修改`services/{identity,text,files}.rs`、lib与open_document测试；覆盖F-FILE-002/014/015：真实硬链接/大小写同ID、等字节不同文件不同ID/revision、中文emoji >260路径、UTF16LE/BE及非法代理项/奇数字节拒绝。API不支持时显式路径退化；身份句柄生命周期待T107关闭接入。尚未重建Release，不能把新Rust行为当现有Release证据。
- 当前继续T101.b：React外registry持有唯一CM缓冲与版本，接入新建/多选/标签切换；T101.c再验证真实Release多选。保存/恢复仍未实现，不能将T101部分或G0当MVP。
- T101.b1缓冲契约切片：新增`features/editor/{documents,editor-state}.ts`及registry行为测试。typecheck/lint/TS单测9均exit 0（新增6项：无标题唯一性/默认格式、重复打开保留正文选区undo、不同身份不按路径合并、只读防绕过、整批过期拒绝、选择不发布React快照且快照无正文）。这是前端内存测试，尚未接UI/未提供保存或恢复，继续b2。

- G0已通过，完整命令`powershell.exe -NoProfile -File scripts/check.ps1 -Desktop` exit 0：TS/lint、TS单测3、Rust原生5、Web4、fmt/clippy、真实Release1均通过。默认桌面测试现在包含真实系统选择器、随机UUID内容回读、原文件hash不变和错误worker manifest拒绝（子命令exit 1，测试断言捕获）。
- 解除T003.d的方法：`scripts/Select-ControlledFixture.ps1`严格校验fixture目录/hash、测试exe/hash、PID和父worker，然后用公开Win32控件消息操作仅属于该测试进程的真实文件对话框；没有生产测试IPC、伪造grant或mock。传统.NET UIA在此环境把1148识别成无ValuePattern的Pane，代理注册亦失败；最终使用原生控件通路完成，不再依赖失效的激活工具。
- 证据`.artifacts/T002/native-release.json`记录`nativeChooserVerified:true`、`browserOffline:true`、WebView2 156.0.4314.58；`native-release-chooser-controls.json`为真实控件回执，`native-release-file.png`已视觉检查。Release hash仍`0D7CB955F251BA836E665BDE0C604B44977D5AE15E21FBF61806D804E0BB0CBD`，产品源码/二进制本轮无需改动。
- 下一步T101，按SPEC-file-core/editor与现有files/grants/bridge/App分原生身份/安全读取、前端registry、多选UI切片；不能把G0壳层或只读视图当M1完成。

## 已解除的M0验证缺口（历史记录）

- 分支`codex/featherpad-v1`；基础工程提交`fe06f82`。T003新增代码已编译、测试和review，完整范围不缩减；尚未开始M1编辑/保存。
- 早期Release：`src-tauri/target/release/featherpad.exe`，9468416 bytes；SHA256 `0D7CB955F251BA836E665BDE0C604B44977D5AE15E21FBF61806D804E0BB0CBD`，pnpm build exit 0。真实WebView2 156.0.4314.58；1420开发服务器停止后，tauri.localhost页面在浏览器offline模式重载通过。不是物理断网/目标机/完整产品验收。
- 最后未通过：Release默认profile下`FEATHERPAD_VERIFY_CHOOSER=1; pnpm test:desktop`；已绑定main父窗口，正确呈现owned模态选择器、主窗口disabled；输入工具仍报`failed to activate captured window`，90s后期望fixture未满足、测试exit 1。此前debug/非隐藏启动同样失败，不能当作产品已通过或继续相同盲试。父窗口归属修复后clippy/build/默认Release smoke再次exit 0。
- 默认`pnpm test:desktop`不选OS文件，Release IPC拒绝路径/亮暗/offline通过；`nativeChooserVerified:false`如实保留。剩余需实际原生正例：系统选择器选fixture→后台注册grant→读真实字节→CodeMirror显示。
- Computer Use的已知限制：窗口/对话框可访问性树正确，但激活失败且截图片源不可靠。后续可在**不混用Computer Use的独立一轮**评估受控Windows UI Automation验收；其指导禁止同轮混用直接PowerShell UI Automation。不得因此增加生产测试后门、伪造grant或回退mock。也可等工具恢复/用户手动选择，尚非整个Goal的停滞条件。
- 原生5项测试捕获并修正空ref尾分隔符、fixture混合斜杠问题；读取只实现普通UTF8（BOM/逐换行映射），其他模式/编码明确拒绝。硬链接身份、大文件、可编辑/保存/恢复等仍在原任务后续完成，不提前记功能通过。
- 检查脚本已创建但T004/T005父任务仍待T003完成后正式验收。下一轮先复查现有代码/产物与这个失败点，不重搭工程。

## 每轮记录模板

```text
日期 / 构建标识：
当前阶段 / 任务ID：
覆盖feature ID：
读取的相关SPEC：
实际改动文件：
完成的用户可观察行为：
运行命令与exit code：
Web mock覆盖：
原生磁盘/WebView2覆盖：
截图/fixture/hash等证据位置：
未通过项与根因：
是否改变接口/范围及文档同步：
下一依赖就绪任务：
```

## 当前已知待验证事项

### T001完成说明（2026-11-01）

- 已创建精确版本前端manifest、TS/ESLint/Vite配置、最小Tauri源码与最小权限，`bundle.useLocalToolsDir=true`；Cargo锁文件生成exit 0（406个包），Rust fmt/clippy/test exit 0（行为测试0个，T003/T004补足）。最终隔离冻结offline安装、前端typecheck/lint/build:web均exit 0。
- 官方npm直连超时（UND_ERR_CONNECT_TIMEOUT）；系统记录的127.0.0.1:12000拒绝连接。核对实际监听的已有127.0.0.1:7890代理后官方npm/crates访问成功，仅为当前命令设置HTTP_PROXY/HTTPS_PROXY，不改系统配置；未切换镜像作为依赖源。
- npm初始元数据在`.artifacts/T001/npm-metadata.json`。最终Vite7.3.7/React19.3.1/TS5.9.3/Tauri CLI+API2.12.4/Vitest4.1.12/ESLint10.14.0，Rust tauri2.12.5/tauri-build2.7.4；以最终锁文件为准。新增缓存均在E盘。
- 首次审计发现旧Vitest/tinypool公告，已移除相关版本；最终audit无critical/high，仅minimatch moderate。详见M0审计处置，不执行强制修复或跨主版本覆盖transitive依赖。
- 下一步T002壳层，再T003最小IPC和授权。G0仍未通过。

Tauri与本机Rust/MSVC的实际链接启动；desktop driver兼容；混合换行保留实现；Windows原子替换元数据与第三方竞态边界；WebView2真PDF输出；真实Windows10目标验证；安装/便携产物与最终性能。这些是实现阶段必须验证的节点，不是允许省略的功能。

## 继续规则

先核对工作区实际状态，保留用户改动。进行中任务先完成或明确拆分，不重建工程。只有验收有证据才能标todo完成；若上下文即将压缩，把最后失败命令、已有产物和下一步写在此处。不要在历史记录里写真实用户正文、密码或绝对敏感路径。
