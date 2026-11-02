# SPEC-file-core：文件安全与持久化

> 模块 `file-core`；业务依赖：无。状态：待实现、待验证，未声称用户已批准。提供方契约适用于 workspace/editor/markdown/search-tools/desktop；规格先于实现。

## Objective 与追踪

让任何调用方以一致方式识别、读取、保存和恢复本地文件，不静默覆盖外部修改、不将失败当成功。拥有 F-FILE-001–018，逐项验收见 [矩阵](../FEATURE-MATRIX.md)；全局阈值见 [PRODUCT](../PRODUCT.md)。M1：001–005、008–011、013–015、017–018；M2：006–007、012、016。为下游的搜索替换/导出提供原语，不依赖其业务。

## Feature-ID 追踪清单

M1：F-FILE-001、F-FILE-002、F-FILE-003、F-FILE-004、F-FILE-005、F-FILE-008、F-FILE-009、F-FILE-010、F-FILE-011、F-FILE-013、F-FILE-014、F-FILE-015、F-FILE-017、F-FILE-018。

M2：F-FILE-006、F-FILE-007、F-FILE-012、F-FILE-016。

每个ID的交互/错误/测试以下述章节与矩阵联合验收。域错误映射：ACCESS_DENIED→PERMISSION_DENIED，INVALID_PATH→INVALID_INPUT，UNSUPPORTED_ENCODING→ENCODING_REQUIRED或UNSUPPORTED，LOSSY_CONVERSION→LOSSY_ENCODING，BINARY→IS_BINARY，LOCKED→BUSY，TRASH_UNAVAILABLE→UNSUPPORTED，IO_ERROR/RECOVERY_UNAVAILABLE→INTERNAL（若可判断磁盘满/无权限则使用对应规范code）；具体域名保留在details.reason。

## 边界契约与数据

Rust 是磁盘事实提供方；前端持有文本缓冲与 dirty 状态。边界采用命令返回 `Result<T, AppError>`，不混用抛异常/null/字符串。可持久化 DTO 使用 camelCase 字段与显式版本，Rust内部snake_case映射。IDs是opaque branded string，revision不可由前端伪造。

```ts
// AppError 直接复用 CONTRACTS 的共享类型，不在此重复定义错误枚举。
type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
type SaveInput = {
  operationId: string;
  documentId: string;
  bufferVersion: number;
  expectedRevision: string | null; // null 仅允许新建且目标不存在
  textSnapshot: string;
  encoding: string;
  eolIntent: 'preserve' | 'lf' | 'crlf';
  newlineMapVersion: number;
};
type SaveResult = {
  operationId: string; documentId: string; bufferVersion: number;
  revision: string; byteLength: number; persistedAt: string;
};
```

正式跨进程线协议以 [CONTRACTS](../CONTRACTS.md) 的 `ResultEnvelope`、`AppError.code`、snake_case命令、grant/FileRef和DTO为唯一来源；本文camelCase方法与快照类型是模块内部语义示例，桥接需显式映射，不新增第二套invoke协议。下述域错误名是 `details.reason`，不能直接扩大线协议 `error.code`。语义固定：

| 原语 | 输入 | 输出/约束 |
|---|---|---|
| `openDocument` | path、可选encoding、openMode | identity、revision、text、encoding/BOM、newlineMap、size、readOnly/degraded原因；只读大文件返回chunk handle而非全量文本 |
| `readChunk` | handle、byteOffset、maxBytes≤1MiB | 带编码边界调整的正文、实际offset、EOF；不拆UTF16代码单元/多字节序列 |
| `saveDocument` | SaveInput | SaveResult；失败保留dirty；相同operationId+相同载荷同进程重复返回已知结果，载荷不同拒绝 |
| `saveAs`/`saveCopy` | 源快照、目标、目标expectedRevision、覆盖许可 | 新身份与revision；复制不切源身份；权限/只读文件不悄悄改属性 |
| `getDiskSnapshot` | documentId | 新revision+磁盘只读快照，供diff与覆盖确认 |
| `createEntry`/`renameEntry` | 父路径/名称、expected identity | 不覆盖创建、已存在错误；返回新路径/identity映射 |
| `trashEntries` | identities、operationId | 每项结果与可恢复位置说明；无永久删除回退 |
| `persistRecovery`/`restoreRecovery` | 版本化快照/manifest | 持久化确认或恢复候选，校验和、schemaVersion、时间、源revision |
| `watchFile` | identity、subscriptionId | revision变化/删除/不可达事件；事件只是提示，保存仍重新读盘复核 |

所有命令入口校验绝对路径/长度/操作范围/枚举值/载荷上限；返回错误提供可行动说明，日志默认不含正文。`cancel(operationId)`只对尚未开始写或可中断读取生效，替换临界区不可中断，返回最终状态；取消响应不假定磁盘未写。operationId不是永久exactly-once保证，崩溃后的未知结果必须重读revision/恢复清单判定，不能无条件重试。

## 文件身份、路径与读取（F-FILE-001/002/013/014/015）

新建先分配documentId和“无标题 N”，无真实路径。读取优先取得Windows volume/file ID并保留用户展示路径；同一进程通过canonical path和file ID去重大小写别名、符号链接/硬链接。同一文件被替换导致file ID变化须建立新revision和冲突，不把旧句柄当当前路径。无法取得稳定ID时以规范路径退化并标记，保存每次重验。

支持中文、emoji、空格、UNC、超过260字符的Windows长路径；后端使用宽字符/长路径API，不盲目截断或统一小写展示。路径解析区分现存目标和新目标（后者规范父目录），拒绝保留设备名、尾点/尾空格歧义、NUL、非法分隔符。路径访问须来自用户打开/文件夹授权/系统启动参数，经权限表验证；授权工作区不等于允许任意相邻目录。符号链接实际目标在授权外时先请求授权或拒绝，不能只校验字面路径。替换前再次核对目标身份以减小链接换向风险。

文件大小阈值：≤2MiB正常；>2且<20MiB降级；≥20且≤100MiB只读分块；>100MiB拒绝全开，可明确选择前1MiB只读预览。阈值依原始字节，读取过程中继续增长应中止/降级，不能只在stat时检查。降级能力由editor显示，不可伪装完整编辑。单行超过100,000字符也触发长行降级提示。二进制识别先处理BOM/指定编码，不能把UTF16的NUL视为二进制；试文本不等于可写，手动“仍按文本”先只读。

T103实施顺序：先接通完整<20MiB文本的原始字节策略与Unicode长行降级，保留normal/degraded既有DTO和完整正文保存；实际读取有20MiB排他上界并复核读取后大小，不能因初次stat偏小绕过。随后扩展chunked/head两个已定义的联合类型及受限只读UI、显式预览选择，验收20/100MiB实际文件与保存拒绝。首切片不将T103或F-FILE-013整体打勾；M1混合/UTF16只读策略仍由T201补全，不能因为大小降级静默改变编码策略。

## 编码与换行（F-FILE-006/007）

BOM识别UTF8/UTF16LE/BE，无码先严格UTF8，失败给候选不自动猜成功。支持GB18030、GBK、Shift_JIS、Big5、Windows-1252手选，状态栏显示encoding与BOM。UTF16无BOM仅在用户选定/可靠启发提示后使用，不宣称可唯一识别。

“以编码重开”重新解释磁盘字节；dirty先保存/放弃/取消。“以编码保存”改变目标编码，按完整快照预检查可表示性；不可表示字符列出位置/数量，提供取消/换UTF8/明确接受替换，默认取消。有损确认绑定bufferVersion/encoding，输入再变更需重验。无损解码/编码失败都保留原字节和原缓冲，不默认插入U+FFFD再悄悄保存。

前端CodeMirror可用统一换行的逻辑文本，但必须维护逐换行token映射（LF/CRLF/孤立CR），随事务和undo同步；未改动行的原换行保存字节不变，含混合文件不能只存“多数CRLF”标记。新增行采用主导类型，平手取首个，无换行用用户默认CRLF。显式LF/CRLF转换是可撤销事务；preserve保留孤立CR并提示。映射版本与bufferVersion一起快照，缺失/不一致报错而非猜测。无内容修改的打开-保存往返应字节不变（除明确编码/BOM/换行转换）。

## 保存与故障（F-FILE-003/004/005/008/009/016）

1. 前端冻结文本/编码/换行/版本快照；同一identity的队列串行，跨窗口同样通过后端协调。保存中仍可输入；完成只更新已保存版本基线。
2. 后端重新打开当前路径，校验identity、长度、mtime以及内容摘要组成的expectedRevision。mtime或长度相同也不能跳过摘要；不存在变存在、存在变不存在均冲突。
3. 严格编码到同目录唯一临时文件；写完flush并尽力请求持久化。Windows使用可靠替换API，保留原权限/属性并明确只读处理；禁止先删原文件再rename。
4. 替换前再次校验目标revision/identity；不一致删除可安全清理的临时文件并返回CONFLICT。成功替换后重读revision，再返回成功。与任意第三方进程仍可能有检查-替换窗口，不能保证完全无竞态；受控内部写队列不是操作系统全局锁。
5. 磁盘满/访问拒绝/杀进程/替换失败均有阶段信息。原文件尽量保持不变，dirty不清理；产生孤立临时文件时进入恢复清单，不自动当最终文件。先备份后写也不等于可无条件覆盖。

T102原生适配核查（2026-11-01，已实现）：微软[ReplaceFileW文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)列出1176/1177部分失败状态，未指定backup时原路径可能消失；因此不能把失败统一理解为“原文件没变”并删除临时文件。实现先落盘阶段清单、指定同卷唯一backup、在失败/未知状态保留所有候选并提供恢复信息，成功核验后才清理。该API的WRITE_THROUGH标志不受支持，不能用它宣称落盘；临时正文通过`sync_all`请求flush，仍不承诺设备断电零丢失。最终文件ID属于replacement，成功后更新身份租约/索引，保持本应用DocumentId；原路径的其他硬链接可能仍指向旧对象，已有显式确认与别名分离测试。保存前再验grant/打开句柄/目标revision，临时文件正文写入前也校验实际目标范围，防止路径换向。

最终故障证据（2026-11-01）：真实Tauri Release写入已填满的16MiB WSL2 `tmpfs`时停在`write-temporary`，源文件不变、编辑器保持dirty，恢复manifest/body/original一致；Windows 9P把底层`ENOSPC`报为错误31。Windows NTFS错误112→`DISK_FULL`的映射和专用“磁盘空间不足”文案由Rust单测覆盖。该组合不冒称物理NTFS小卷或断电演练，T110仍负责启动扫描、恢复与热退出。

新建目标使用不存在前置条件，已存在要求用户明确覆盖并绑定当前revision。另存为成功才切换文档身份、更新视图；保存副本不切身份。全部保存逐文档执行，有总体进度、逐项成功/失败和取消后未处理列表；不保证跨文件原子性。

T102.c3全部保存实施决策：开始时固定dirty文档的ID与顺序，不预先复制全部正文；每项通过既有同文档队列，在真正执行时冻结快照并核对revision。单项失败保留dirty并继续其余独立文档，不能隐去失败；路径选择CANCELLED或用户“停止后续保存”停止后续项，当前在途写入等待真实结果，不宣称撤销已写入内容。轮到某项时已撤销为clean则跳过。显示逐项保存版本、失败/取消/未处理及总体进度；保存成功后有新输入仍标未保存，开始后新增的dirty文档留待下次，不宣称全局全部clean。不新增批量写入IPC。

外部变更：clean且无正在保存快照可自动重载并提示；dirty不更改正文，提供“比较磁盘/重新载入/另存为/覆盖”。覆盖确认绑定最新磁盘revision，比较后再次变更必须重新确认；重载前保护草稿。外部删除显示缺失，保存可重新创建但必须明确确认；外部重命名可依据identity跟随并提示，无权限/离线状态区别于删除。

T111按三段实施：a只读磁盘快照/绑定revision接纳新lease和定向Rust行为；b原生监听/聚焦兜底与clean安全重载；c脏冲突比较/保护后重载/另存/明确覆盖及相关真实Release。临时读取不修改文档注册表；外部原子替换接纳后仍保持原DocumentId，重复identity拒绝而不合并正文。无法安全跟随的外部改名按缺失保正文，不自动搜索父目录或扩权。小切片不提前标T111/F-FILE-008通过。

## 草稿、恢复与关闭（F-FILE-010/011/012/018）

恢复存储是本地用户私有目录，便携位置由desktop提供。快照包括schemaVersion、documentId、原路径、源revision、bufferVersion、encoding/BOM、newlineMap、text与校验和，不持久化全量undo。内容快照先写临时文件并flush/rename，再更新manifest；保留上一份完整manifest。debounce1秒，持续输入最长5秒调度；“已恢复保护”仅在确认成功后显示。

默认每文档10份冗余快照、未认领草稿30天仅提示清理且不得自动删除唯一未保存副本、总256MiB预算。清理可删除旧冗余副本，不能删除当前dirty唯一完整副本；达到上限提示并暂停“安全退出成功”承诺。恢复需校验长度/摘要/schema，损坏隔离可人工取回；不自动删除全部数据。恢复命名文档时比较当前磁盘，改变则以恢复副本打开并提供diff，不覆盖磁盘。显式放弃/关闭且不保存需写入tombstone并删除待恢复指针，防下次复活。

自动保存默认关闭，开启后空闲1500ms尝试已命名/可写/无冲突文档；禁保存只读/限量预览，不为无标题选路径。保存失败停止重复刷错并提示，后续显式重试。恢复快照与自动保存独立，关闭自动保存不关闭恢复保护。

普通关闭脏文档：保存/不保存/取消；保存失败/另存取消等于取消关闭。热退出由desktop编排，但只有全部dirty最新快照与manifest成功持久化才返回可退出；失败给重试/另存/明确放弃。崩溃/断电可能丢失最后未落盘输入，存储损坏也无零丢失保证。

T107关闭编排约束（2026-11-02，UI待接）：放弃按documentId/throughVersion先写不可变tombstone，再清理对应快照；清理失败或传输未知时标记可能已经生效，不能继续显示旧版本“已恢复保护”。保留缓冲/标签/lease，用户继续保留时提升内存version形成新的恢复代次，正文、undo和磁盘保存基线保持不变；旧版本继续被屏蔽。只有后续新快照真实持久化成功才能重新显示已保护。不能因错误回执清dirty或释放文档。

资源释放回执未知时，原生lease可能已释放，不能继续按旧绑定编辑/保存。完整缓冲保留为只读、未绑定副本，显示重试关闭/另存为；成功另存才重建可编辑绑定。片段保留已读内容并暂停分页，只允许重试关闭后重新打开；不把未知回执当成功，也不删除内存正文。

## 文件操作（F-FILE-017）

新建文件/目录以排他方式执行；rename拒绝碰撞，大小写仅变更采用Windows可靠两步处理并有中间恢复，更新映射事件。删除只调用Windows回收站能力，逐项结果；UNC/移动盘/系统策略不支持回收站时返回TRASH_UNAVAILABLE，不自动永久删除。dirty文件的保存/放弃决策由上层先完成，file-core只接收明确授权，不能自行读取editor状态。多项操作可部分成功，结果逐项列出。

T105.b1原生适配决策（2026-11-01）：复用锁文件和E盘缓存中已有的Microsoft `windows`/`windows-core` 0.62.2（MIT/Apache-2.0、无build script），启用COM/Shell绑定。原生回收在专用STA线程使用IFileOperation，固定FOFX_RECYCLEONDELETE/FOFX_EARLYFAILURE/FOF_NO_CONNECTED_ELEMENTS/FOFX_NOCOPYHOOKS及无系统确认/错误弹窗；父路径链保持锁定，入口和PreDeleteItem再次复核目标路径、非reparse、identity与expectedRevision。PreDeleteItem发现没有TSF_DELETE_RECYCLE_IF_POSSIBLE就返回失败，禁止系统降级为永久删除；PostDeleteItem必须返回成功且有回收站新项，再检查源路径消失，才返回receipt。未确认/失败不清缓冲、不伪报成功。参考微软[操作标志](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags)、[删除前回调](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-predeleteitem)和[删除后回调](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-postdeleteitem)。b1已用真实Shell验证回收/还原、锁定失败和永久删除否决，尚不开放生产删除IPC；b2继续grant/requestId/dirty快照与UI纵向切片。Shell不接受canonicalize产生的扩展路径前缀，传入Shell前仅转换路径表示；所有身份与边界复核仍使用canonical路径。

## Acceptance 与 error-state

- F-FILE-001–005/018：无标题输入、取消另存、保存中继续输入、全部保存中第三项失败；原文和dirty状态正确，取消不关闭。
- F-FILE-006/007：每种编码包含中文/日文/特殊字节夹具，混合LF/CRLF/孤立CR逐字节往返；不可表示emoji必须确认。有损后再输入撤销旧许可。
- F-FILE-008/009/016：外部同长度同mtime改写可检测；对比后再改写、锁定文件、只读、真实满盘、替换前/提交后强制中断均不误报成功。
- F-FILE-010–012：输入后成功快照、kill再启恢复；损坏最新快照回退上一份；热退出存储失败阻止退出；明确放弃不复活。
- F-FILE-013–015：2MiB/20MiB/100MiB各上下1字节，增长中文长行、UTF16、真实二进制、中文长路径/UNC/链接别名。跨授权边界拒绝且可解释。
- F-FILE-017：已有目标、保留名、回收站不可用、dirty资源被外删；所有项最终状态可诊断，没有永久删除回退。

## 技术、结构、风格与测试策略

技术：Rust文件服务/Tauri2 IPC + TypeScript DTO；具体编码库/Windows替换与回收站适配器实施前做许可证与能力验证。建议目录 `src/bridge/file-core/`（DTO/前端桥接）、`src-tauri/src/services/file_core/`（服务/适配器）、`tests/unit/file-core/`、`tests/integration/file-core/`、`tests/e2e/file-core/`；此处仅约定，尚未创建。

风格示例见SaveInput：显式版本、discriminated union，不返回无法区分的false；函数camelCase、类型PascalCase，Rust snake_case；UI文案不能当错误分支判断依据。I/O与编码纯转换分离，取消与unknown写入结果显式建模。

`pnpm test:e2e`仅覆盖Web/mock bridge；Windows真实Tauri/WebView2验收使用待建立的 `pnpm test:desktop -- file-core` 和Rust原生测试，mock不能证明磁盘行为。命令约定（待工程搭建，未执行）：`pnpm test:unit -- file-core`、`pnpm test:integration -- file-core`、`pnpm test:e2e -- file-core`、`pnpm test`；Rust `cargo test --manifest-path src-tauri/Cargo.toml file_core`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`；通用 `pnpm lint`、`pnpm typecheck`、`pnpm build`。

单元覆盖编码/换行映射/版本队列/错误映射；集成用临时目录和可注入I/O故障测试写入各阶段、回收站模拟与真实Windows smoke；e2e测试dirty提示、冲突与恢复，不能只验证API返回。高风险写入状态每个转移均需断言数据和磁盘，不以覆盖率数值替代。实际锁定/磁盘满/杀进程/权限/长路径需Windows故障演练。

## Boundaries 与未决风险

Always：入口校验、版本复核、失败保留正文、对损失性动作显式确认。Ask first（后续实施变更）：扩大目录授权、改持久化格式/默认编码、引入删除降级或提高恢复删除权限。Never：静默永久删除、清dirty后再写盘、未检测的有损保存、声称第三方写入绝对无竞态。

待验证风险：Windows替换与杀毒软件锁定、网络盘rename/flush语义、GB18030版本兼容、长路径API支持、混合换行事务映射和恢复写入成本。风险不删功能；实现需验证并在失败时保留可恢复状态。
