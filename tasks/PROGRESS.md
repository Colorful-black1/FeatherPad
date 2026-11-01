# 当前进度与交接

## 目前状态

- 产品名称：**轻羽 FeatherPad**。
- 当前交付：完整产品方案、86项功能矩阵、模块规格、UI规范与离线交互原型、技术/本机环境文档、M0–M5实现计划、57个开发任务、agent执行入口。
- 产品代码：**M0/G0及M1/T101通过，T102待补磁盘满，T103进行中**。真实Release保存/另存/副本/批次/覆盖/硬链接/进程终止及<20MiB正常/降级完整编辑已验证；分块/限量预览、恢复等仍未完成，G1未通过，更不是完整v1。
- 下一项：**T103 大文件模式**；T102真实磁盘满保留权限缺口，M1通过后继续M2–M5。
- 本次交付检查：详见 [DELIVERY-CHECK](../docs/DELIVERY-CHECK.md)，不代表产品关卡G0–G5通过。

## 已核查环境

复用本机Node22.13.0、pnpm10.32.1、Rust1.99.1、VS2022 Build Tools C++、Windows SDK10.0.26100.0、WebView2。未安装新开发工具。严格遵守新增安装与缓存仅在E:\Codeing，入口见 [ENVIRONMENT](../docs/ENVIRONMENT.md)。

## 实施证据（未来逐任务追加）

| 日期 / 任务 | 功能ID | 变更文件 | 命令 / exit code | mock或原生 | 证据 | 结论 / 下一步 |
|---|---|---|---|---|---|---|
| 2026-11-01 / T000 | F-DESK-013 | 环境/原生探针脚本及记录 | Probe-Environment/Verify-NativeToolchain exit 0 | 原生MSVC，非Tauri | `.artifacts/T000/result.json`：编译/运行均0；exe SHA256=11671D0B9073AA77425DF8C9E50FE8BEF00DA1E08E88CA6428D52287ADA53F44 | 已复用所有工具；下一T001 |
| 2026-11-01 / T001.a,b | F-DESK-013 | manifests/双锁、TS/Vite/ESLint、Tauri骨架与图标 | 冻结offline安装、typecheck/lint/build:web、Rust fmt/clippy/test均0；audit exit 1仅开发工具moderate | 编译级原生；当时Rust行为测试0个 | `docs/acceptance/M0.md`、`.artifacts/T001/` | T001通过；minimatch受控lint模式，2026-12-01复核 |
| 2026-11-01 / T002 | app-shell | React Shell/App/token/CSS、Web及原生测试 | typecheck/lint exit 0；Web 2 passed；真实WebView2 debug 1 passed | Web与原生范围分开，未测OS对话框 | .artifacts/T002/及docs/acceptance/M0.md | T002通过；下一T003 |
| 2026-11-01 / T003.a–d（进行中） | F-DESK-013 | Rust models/grants/files/commands、AppManifest ACL、TS contracts/bridge、CodeMirror只读UI、测试与脚本 | typecheck/lint/TS单测3、Rust原生5、Web4、Release smoke1均exit 0；check.ps1 -Desktop exit 0；交互选择器三次超时，后次显式exit 1 | 原生Rust磁盘+junction，真实Release IPC/WebView2，Web mock独立 | docs/acceptance/M0.md；.artifacts/T003；.artifacts/T002/native-release.json | T003未完成OS选取验收，G0不勾选 |

## 当前恢复点（2026-11-01 17:13，Asia/Shanghai）

- T103.a/F-FILE-013完整可编辑降级已接真实纵向切片：`open_policy.rs`集中既定2/20/100MiB阈值，原始字节≤2MiB normal、>2且<20 degraded；≥20仅返回非可编辑策略，分块/显式预览尚待接线。初次stat后实际读取也有20MiB排他上界，读取后按真实snapshot大小重判，不截断后保存；Unicode单行>100,000字符触发degraded。FileService严格解码/二进制保护/换行映射不变；已有normal/degraded DTO不增字段。EditorDocument显示“纯文本 · 降级”与禁用能力提示；M1 UTF16/mixed只读策略保留。
- 真实Rust：2MiB−1/2MiB/2MiB+1/20MiB−1读取完整字节，2MiB+1追加中文emoji后保护保存实际全字节正确；100,000/100,001个emoji长行按Unicode字符准确分类、不截断。纯策略另测20/100MiB±1，未把这些纯判断冒称大文件chunk/预览已实现。旧2MiB+1临时拒绝测试改为显式完整降级正例，≥20MiB完整可编辑拒绝仍保留；产品阈值/性能预算没有改动。
- 本切片全部实际检查：typecheck/lint/TS31、全Web14（新增完整2MiB+1 mock缓冲编辑/SaveRequest）、Rust全套50、fmt --check/clippy --all-targets -D warnings、Release build、真实桌面综合1（52.3秒）均exit0。Web与原生编译分开。原生OS选择受控2MiB+1文件→显示降级/仍可编辑→插中文emoji→CtrlS→整份字节精确匹配，保存/覆盖/硬链接/强杀旧场景一起回归。helper只对新open-degraded角色准许单个恰为2097153 bytes、hash匹配的owned fixture，其余动作保原小文件限制；不添加路径IPC。
- 补200% CSS zoom检查时定向Web1在page.goto 30s超时，尚未进功能/布局断言；trace显示main.tsx 13.8s、Vite env模块13.1s等待。尝试把webServer ready URL改入口模块后全量首批7项仍在goto超时，第二trace显示HTML 26.9s。失败trace分别保留为`.artifacts/T102/degraded-zoom-initial-trace.zip`与`degraded-zoom-entry-probe-trace.zip`。最终Web行为测试改为`pnpm build:web && pnpm exec vite preview --host 127.0.0.1 --port 1420 --strictPort`，使用与Tauri相同的构建前端，去掉开发模块转换链；typecheck/lint及全Web14 exit0（15.9秒），未改30s测试上限、retries=0或worker数。新版200%截图`degraded-web-200.png`已视觉检查，模式/保存按钮/编辑区可见且无横向溢出；不作为原生OS缩放或Release性能结论。
- 当前Release：9961472 bytes，SHA256 `8A18D66E9589CA2EC46FEA65AA5AFA536A1F15F9C561C9B0A3E2895532FF0814`；`.artifacts/T102/native-release.json`的nativeDegradedEditingVerified及原生各项true，`native-release-degraded-editable.png`已视觉检查（测试历史root沿用T102，任务为T103）。Win11/WebView2 156.0.4314.58、浏览器offline重载；不声明目标机性能、IME/OS缩放或Win10。Vite单chunk 523.95kB/gzip168.71kB警告阈值未改，无新依赖/工具。
- 最后文档静态检查（137文件/27 Markdown/141链接/86功能/57任务）与git diff --check均exit0；这些不算产品行为验收。最终通过后仅写入文档与提交，未再改产品/测试行为代码。
- 下一T103.b：接既定large-readonly/chunked与head-preview/head联合类型、受限读取handle和流式revision、边界对齐/旧revision拒绝，再接只读分页UI与>100MiB显式前1MiB选择。需在后端文档lease区分完整只读与片段只读，普通保存及As/Copy都拒绝片段，不能只禁前端按钮；完整只读文件另存行为仍保留。当前≥20MiB仍安全拒绝完整编辑，不能标T103/F-FILE-013完成；动态编辑增长策略与大文件内存/首屏也待核验。T102磁盘满因New-VHD权限缺口仍[~]，不重复同一失败探针；T110恢复/预算/关闭保护待实现，G1及完整v1未通过。保存进程终止切片已提交`da0fe00`。

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
