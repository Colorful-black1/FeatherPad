# 当前进度与交接

## 目前状态

- 产品名称：**轻羽 FeatherPad**。
- 当前交付：完整产品方案、86项功能矩阵、模块规格、UI规范与离线交互原型、技术/本机环境文档、M0–M5实现计划、57个开发任务、agent执行入口。
- 产品代码：**M0/G0及M1/T101通过，T102进行中**。真实Release已有文件CtrlS受保护保存、冲突拒绝、迟到Ack保留新输入已验证；另存/副本/全部保存、恢复等仍未完成，G1未通过，更不是完整v1。
- 下一项：**T102 安全保存闭环**；M1通过后继续M2–M5。
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

## 当前恢复点（2026-11-01 14:42，Asia/Shanghai）

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
