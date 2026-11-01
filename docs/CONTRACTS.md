# 进程接口与数据契约

状态：跨进程设计与实现契约；已实现范围与实际证据见 [PROGRESS](../tasks/PROGRESS.md)。模块责任见 [能力地图](../CAPABILITY-MAP.md)，功能 ID 见 [功能矩阵](FEATURE-MATRIX.md)。本文件定义跨进程边界；模块内部可以演进，但不得静默改变保存、取消和错误语义。v1 使用单一 schemaVersion=1，不维护平行版本 API。

M0实施决策（T003，2026-11-01）：按既有协议先落地choose_files/choose_folder/open_document，不添加任意路径授权或测试专用IPC。授权仅保存在Rust内存；每次读取同时校验路径组件、canonical目标和已打开句柄的Windows最终路径，阻止junction换向逃逸。首个切片只提供有界UTF8只读查看，其他编码/大文件返回明确错误，完整打开策略/文档身份/保存由T101之后扩展；不得提前标记相应功能完成。AppManifest为这三个命令生成精确ACL，仅main本地窗口获权。

M1/T101实施决策（2026-11-01）：Windows身份使用volume serial+128-bit file ID，打开文档持有共享删除的只读句柄作为身份租约，避免已打开文档期间ID复用；不支持该API时显式提示并退化canonical路径。revision纳入身份、原始字节、大小与mtime，不仅比较内容。UTF16 BOM先严格解码再判断binary，非法代理项/奇数字节拒绝有损读取。前端registry在React之外持有唯一CodeMirror状态和版本，React仅订阅标签/dirty等元数据；重复打开同DocumentId只聚焦，不替换已有缓冲。M1对未实现逐行编辑映射的混合换行保持只读，完整编码/换行编辑仍由T201验收。所有线协议字段不变。

M1/T102.a实施决策（2026-11-01）：保存时才冻结正文字符串与CM Text基线、format/newlineMap/version及固定requestId；每键不做字符串快照。Ack必须匹配捕获版本及当前基准diskRevision，更新已保存Text与磁盘元数据，使用当前Text对已保存Text判dirty，不重建EditorState或清undo。过期/错配Ack拒绝；后续队列同文档串行，等待中的保存须在前一个Ack后重新捕获expectedRevision。普通LF/CRLF映射在保存快照时生成，mixed/孤立CR仍只读，未命名文档交给另存选择器，不伪造已有路径。

M1/T102.b1实施决策（2026-11-01）：Rust SaveRequest与既有camelCase协议一致，拒绝未知字段；TextFormat改为owned字符串以便Deserialize，输出线协议不变。编码器先验证版本、归一化LF、逐换行数量/版本及encoding/BOM配对，支持严格UTF8/UTF16与显式mixed逐行映射，不支持的编码拒绝。此切片只生成字节，不提供IPC或写盘；前端仍将UTF16/mixed设为只读，不能以编码器测试代替T201编辑映射验收。

T102.b2写入实现约定：原件与目标字节先分别flush到应用私有保存事务目录，唯一receipt manifest记录目标、临时文件、同卷backup、摘要和阶段；记录不写日志、不上传。之后才在目标同目录创建唯一临时文件，核对其实际句柄路径后写正文/flush，替换前重验grant、身份和revision。ReplaceFileW始终指定唯一backup并使用flags=0，失败保留候选；成功读回核对字节/身份再Ack、更新身份索引。硬链接多于1需显式确认只替换当前路径，不能静默断开别名；该确认来自原生交互或可信Rust调用，不由任意路径IPC授权。IPC快照UTF8正文硬上限64MiB、编码后硬上限100MiB，超限明确拒绝且保留内存，不改变打开模式的2/20/100MiB阈值。保存事务/恢复清单的启动扫描与预算由T110完成前不得标G1通过。

T102.b2.3–4适配：进程内保存结果缓存512个请求，整个请求流式计算摘要；相同ID/相同载荷回放已知结果（包括失败），不同载荷拒绝。在途请求另有RAII登记，相同载荷BUSY、不同载荷INVALID_INPUT。源文件始终从已打开DocumentId反查Rust grant，不接受保存路径IPC。桌面状态目录默认应用local data，提供原生进程环境`FEATHERPAD_USER_DATA_DIR`绝对路径覆盖，用于受控运行/自定义本地状态目录；它仅改变应用私有事务/恢复目录，不授权读取或保存用户文件路径，不通过IPC/预览内容配置。测试给子进程指定独立E盘fixture状态目录。便携marker、迁移、启动扫描和容量策略仍在M4/T110验收，不因目录覆盖而声称完成。

T102硬链接确认实施决策：普通save_document在原生确认前先查询同一请求的结果缓存；新请求只读检查当前授权目标/revision及硬链接数。多链接时创建不可Deserialize的确认对象，绑定完整请求摘要与canonical目标；原生YesNo说明仅替换所选路径、其他硬链接保留旧内容。等待确认不持有文件服务锁、不创建事务/临时正文；No返回CANCELLED且缓存，同请求回放不重复弹窗。Yes后检查源绑定仍指向捕获路径，重验revision、权限和身份，再走现有同目录保护替换。无确认时继续RequireConfirmation策略，检查后新出现的多链接仍安全拒绝并可重新发起确认。前端不能传hardLinkConfirmed或目标路径，旧Ack不清新输入的规则不变。

原生在途协调同时按DocumentId互斥：相同ID不同payload仍INVALID_INPUT；同一文档的其他requestId（包括SaveAs/Copy）在保存或确认期间返回BUSY，RAII结束后才可再进入。不同文档与只读stat不受该文档的确认等待阻塞。该互斥不替代前端逐文档队列，也不承诺跨进程文件锁。

## 1. 一致规则

T102.c2另存实施决策：SaveAsRequest复用快照字段但不接受目标路径/revision，增加可选intent（默认save-as，另值copy）；目标仅原生选择器授权。返回增加documentId与metadata，便于在成功Ack后更新展示路径/原生FileRef，逻辑DocumentId保持同一缓冲。取消返回CANCELLED，不绑定路径、不清dirty。新目标先规范父目录/验证Windows名称，以禁止覆盖的同卷移动提交，目标在期间出现则CONFLICT。已存在目标先取revision，再由原生明确确认并在提交前重验；其他已打开文档占用的路径/文件ID拒绝，副本目标与源同一物理文件也拒绝。save-as成功才更新源绑定/已保存基线；copy只返回结果，不更新源绑定、dirty或undo。选择器等待期间的输入仍属于更高bufferVersion，旧Ack不清新dirty。分新目标核心、现有目标/碰撞、IPC、前端和原生验收切片完成，不以部分切片标T102通过。

F-FILE-002授权阶段补正：choose_files返回`{grants:FileRef[],failures:{selectionIndex:number,error:AppError}[]}`。selectionIndex是原生选择列表的零基序号，单项路径转换/授权注册失败不能丢弃其他成功grant；取消为两个空列表。全部失败仍返回逐项failure，服务锁/worker等全局故障才是外层失败。失败不回传原始路径/系统错误字符串，UI以所选项序号和安全错误信息反馈。成功项随后open_document失败也逐项反馈，不将Web open阶段mock当作原生授权阶段证据。

- TS 字段 camelCase，Rust serde rename_all="camelCase"；命令使用 snake_case。字节数/版本为 JS safe integer；超出范围拒绝。时间为 ISO 8601 UTC 字符串。
- 普通输入用 discriminated unions，枚举值统一小写短横线；错误码统一 UPPER_SNAKE。ID 为 opaque string，不能由路径自行猜测。
- 所有 invoke 返回 `ResultEnvelope<T>`；异常的传输失败由 TS bridge 统一转成 `IPC_UNAVAILABLE`。事件携带 schemaVersion、operationId 与序号，不与 invoke 错误混用。
- 根授权必须来自原生选择器、显式文件打开、经校验 CLI/系统打开。仅前端传一个绝对路径不构成新授权。后端 registry 保存 canonical target + grant kind。
- Grant 是进程内权限边界，不是网络认证 token；文件内容、Markdown 链接、预览脚本都不能调用应用 IPC。

```ts
export type DocumentId = string & { readonly __documentId: unique symbol };
export type GrantId = string & { readonly __grantId: unique symbol };
export type OperationId = string & { readonly __operationId: unique symbol };
export type DiskRevision = string & { readonly __diskRevision: unique symbol };
export type ResultEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };
export interface AppError {
  code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'OUT_OF_SCOPE' | 'IS_BINARY'
    | 'TOO_LARGE' | 'CONFLICT' | 'ENCODING_REQUIRED' | 'LOSSY_ENCODING'
    | 'DISK_FULL' | 'READ_ONLY' | 'INVALID_INPUT' | 'INVALID_PATTERN'
    | 'CANCELLED' | 'UNSUPPORTED' | 'BUSY' | 'PARTIAL_FAILURE'
    | 'IPC_UNAVAILABLE' | 'INTERNAL';
  message: string;
  retryable: boolean;
  operationId?: OperationId;
  details?: {
    displayPath?: string;
    documentId?: DocumentId;
    retryAfterMs?: number;
    reason?: string; // 提供方SPEC中的域原因，不替代统一code
    stage?: string;
    currentRevision?: DiskRevision;
    expectedRevision?: DiskRevision;
    receiptId?: string;
  };
}
```

错误 message 用于显示，不作逻辑匹配；logs 记录错误码、耗时，不记录文档正文。对开发者的 OS 细节只在可控 debug log 中保留，不能泄露全文。

## 2. 文件核心 file-core

```ts
export interface FileRef {
  grantId: GrantId;
  relativePath: string; // 单文件grant可用空字符串；不能有逃逸段
}
export interface FileMetadata {
  displayPath: string;
  sizeBytes: number;
  modifiedAt: string;
  isReadOnly: boolean;
  diskRevision: DiskRevision;
}
export interface TextFormat {
  encoding: string; // 受支持的 canonical label，非任意编码名
  bom: 'none' | 'utf8' | 'utf16le' | 'utf16be';
  lineEnding: 'lf' | 'crlf' | 'mixed';
}
export interface OpenDocumentBase {
  documentId: DocumentId;
  ref: FileRef;
  metadata: FileMetadata;
  format: TextFormat;
  warnings: string[];
}
export interface TextChunk {
  byteStart: number;
  byteEnd: number;
  firstLine: number;
  text: string;
  hasMore: boolean;
}
export type OpenDocument = OpenDocumentBase & (
  | { mode: 'normal' | 'degraded'; content: { kind: 'text'; text: string; newlineMap: NonNullable<SaveRequest['newlineMap']> } }
  | { mode: 'large-readonly'; content: { kind: 'chunked'; handleId: string; initialChunk: TextChunk; totalBytes: number } }
  | { mode: 'head-preview'; content: { kind: 'head'; text: string; previewBytes: number; totalBytes: number; truncated: true } }
);
export interface SaveRequest {
  documentId: DocumentId;
  requestId: string; // 一次保存意图固定；同一重试不能换ID
  documentVersion: number;
  expectedDiskRevision: DiskRevision;
  text: string; // 编辑内核归一化LF；原始换行由newlineMap保留
  format: TextFormat;
  newlineMap?: {
    documentVersion: number;
    endings: ('lf' | 'crlf' | 'cr')[]; // 对应每个归一化换行，顺序和数量必须匹配
  };
}
export interface SaveAck {
  documentVersion: number;
  diskRevision: DiskRevision;
  savedAt: string;
  sizeBytes: number;
}
```

| 命令 | 输入 | 输出 value | 规则 |
|---|---|---|---|
| `choose_files` | `{multiple:boolean}` | `{grants:FileRef[],failures:{selectionIndex:number,error:AppError}[]}` | 系统选择器取消返回两个空列表；单项失败不影响其他成功授权 |
| `choose_folder` | `{}` | `{grant: FileRef|null}` | 明确选中后建立 root grant |
| `open_document` | `{ref,encodingOverride?,mode?}` | `OpenDocument` | 先大小/二进制检查；同一文件复用 DocumentId |
| `save_document` | `SaveRequest` | `SaveAck` | 同一文档串行，冲突不覆盖；超时结果可能未知 |
| `read_document_chunk` | `{documentId,handleId,expectedDiskRevision,byteOffset,maxBytes}` | `TextChunk` | maxBytes默认64KiB最大1MiB；编码边界对齐、行位置正确，磁盘变化返回CONFLICT，绝不把片段作为可保存全文 |
| `save_document_as` | `{documentId,requestId,documentVersion,text,format,newlineMap?,intent?:'save-as'|'copy'}` | `{documentId,ref,metadata:FileMetadata,ack:SaveAck}` | 原生保存选择器；取消CANCELLED；覆盖确认绑定目标revision；copy不改源绑定 |
| `stat_document` | `{documentId}` | `FileMetadata` | 核对未知保存结果或磁盘变化 |
| `reopen_with_encoding` | `{documentId,encoding,discardVersion?}` | `OpenDocument` | dirty先由UI明确保存/放弃；不得隐式丢弃 |
| `release_document` | `{documentId}` | `{released:boolean}` | 仅释放资源，不删除文件/恢复快照 |

**保存幂等：** requestId 由调用者捕获保存版本时生成。Rust 记录 `(DocumentId, requestId, payloadHash, state/result)`；重复同 payload 已成功则回放 Ack，同 ID 不同 payload 报 INVALID_INPUT；处理中报 BUSY。常规运行内缓存可有界，但退出前未知结果需要 diskRevision 与恢复清单重新判定，不能假装内存幂等缓存提供跨崩溃保证。即使缓存过期，旧 expectedDiskRevision 通常会造成 CONFLICT 而不是重复写；调用者先 stat，不无脑换ID重试。

混合换行：文档模型必须保留原始行结束元数据，未修改行不应在无提示下全量 LF 化。normal/degraded 的 content 还必须返回与 SaveRequest 相同结构的 newlineMap（初次documentVersion=0）；按原始换行建立映射。保存/另存/恢复快照中，存在mixed或孤立CR时必须提供newlineMap，版本需等于请求documentVersion，条数需等于归一化文本换行数；不匹配拒绝INVALID_INPUT，不猜测。用户显式统一转换才移除混合策略。M1 若未实现混合保留，应只读并解释，M2 完成前不能把该项标完成。

新文档无磁盘 revision，保存必须走 `save_document_as`。编码转换、BOM/换行转换属于一次可撤销文档变更/显式保存操作，不在打开时静默写入。

## 3. 工作区 workspace

```ts
export interface DirectoryEntry {
  id: string;
  ref: FileRef;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'junction';
  isHidden: boolean;
  isReadOnly: boolean;
}
export interface Page<T> { items: T[]; nextCursor: string | null; }
```

| 命令 | 输入 | 输出 value |
|---|---|---|
| `list_directory` | `{ref,cursor?,limit?:number}` | `Page<DirectoryEntry>` |
| `create_entry` | `{parent:FileRef,name,kind:'file'|'directory',requestId}` | `DirectoryEntry` |
| `rename_entry` | `{ref,newName,expectedRevision?,requestId}` | `{ref:FileRef}` |
| `trash_entry` | `{ref,expectedRevision?,requestId}` | `{trashed:boolean,receiptId:string}` |
| `start_watch` | `{refs:FileRef[]}` | `{watchId:string}` |
| `stop_watch` | `{watchId}` | `{stopped:boolean}` |

limit 默认 200、最大 1000；cursor 不可猜测，目录变更导致失效返回可重载错误，不重复无限分页。名称校验 Windows reserved device names、空白尾点、路径分隔符和空名称，碰撞默认拒绝，不自动覆盖。多选变更返回逐项结果，不宣称原子性。

**变更命令不可盲目重试。** create/rename/trash 用 requestId 在运行进程中去重、校验 payload；超时先查询目录/receipt。进程崩溃后不提供 exactly-once 保证，UI 先重扫状态。回收站 receipt 是审计标识，不承诺所有系统配置均支持程序化还原；引导用户系统回收站恢复。reparse point 每次解析后验证授权边界，不默认递归跟随。

watch 事件：`filesystem_changed {watchId, sequence, entries:[{ref,kind,diskRevision?}],overflow:boolean}`。去抖、合并、自写标记仅做优化；overflow 和窗口重新聚焦后 stat 兜底，不能只依赖事件判断源文件安全。

## 4. 搜索与批量替换 search-tools

```ts
export interface SearchQuery {
  roots: FileRef[];
  pattern: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  maxResults: number; // 默认10000、硬上限10000，可调低；并受50MiB结果预算限制
  respectIgnore: boolean;
}
export interface SearchHitBase {
  hitId: string;
  ref: FileRef; // 目录搜索只覆盖已命名且在授权根内的文档；无标题用文件内查找
  line: number; // 1-based
  column: number; // Unicode scalar 1-based，UI转换到UTF16
  preview: string; // 截断的文本，作为纯文本显示
  matchByteStart: number;
  matchByteEnd: number;
}
export type SearchHit = SearchHitBase & (
  | { source: 'disk'; diskRevision: DiskRevision }
  | { source: 'buffer'; documentId: DocumentId; documentVersion: number; baseDiskRevision?: DiskRevision }
);
```

- `start_search {query,operationId}` → `{accepted:true}`，事件 `search_batch {operationId,sequence,hits}`，`search_finished {operationId,sequence,status:'complete'|'cancelled'|'truncated'|'failed',count,error?}`。
- `cancel_operation {operationId}` → `{accepted:boolean}`。取消幂等，取消后 UI 不接收迟到结果；服务必须结束并释放资源，不能只隐藏加载状态。
- `plan_replace {operationId,query,replacement,selectedHitIds}` → `{planId,files:[{ref,diskRevision,matchCount}],totalChanges,expiresAt}`。基于已知版本构建预览，不能把未编辑文档的实时内容与磁盘扫描结果混写。
- `apply_replace {planId,confirmationId}` → `{operationId,accepted:true}`。明确确认后执行；再次校验每文件 revision、编码和权限，dirty open buffers 默认排除并展示原因，不能覆盖未保存编辑。
- `replace_progress` / `replace_finished` 返回逐文件 changed/skipped/failed/conflicted，包含可恢复记录。替换计划短期有效且绑定查询/范围/版本；过期重新预览。confirmationId 运行内去重，同一计划不重复执行。
- `rollback_replace {receiptId,selectedFiles}` 按替换后 revision 校验；文件后续被改则跳过并提示，不覆盖新工作。恢复记录可设置体积/保留期限并给出 UI 说明，不宣称无限撤销。

同一已打开dirty文件优先返回source=buffer命中并标明未保存来源，不再混入旧磁盘命中；buffer偏移基于该快照UTF8字节，磁盘命中偏移基于原编码字节，点击定位统一转换到UTF16。点击前核对documentVersion/diskRevision，过期则重新搜索。无标题不自动加入目录范围。plan_replace仅接受source=disk的命中；buffer命中逐项标为未保存且不可选，用户先保存再重建预览，不把buffer偏移应用到磁盘。

正则产品语法统一采用 Rust regex 子集：不支持 look-around/backreference。替换支持 `$0`/`$1` 等捕获和 `$$` 字面量，细节在测试固定。文件内匹配可调用同规范 Worker 或兼容实现；不允许文件内JS正则“成功”而文件夹搜索同式无提示失败。结果默认忽略二进制、隐藏/ignore排除、大于阈值文件，显示跳过统计和范围入口。

## 5. 格式化、对比和 Markdown

这些能力优先在 Web Worker 中处理文本，不获得任意文件授权。

```ts
export interface TextJobRequest {
  jobId: string;
  documentId: DocumentId;
  documentVersion: number;
  kind: 'format' | 'markdown' | 'diff';
  text: string;
  options: Record<string, string | number | boolean>;
}
export interface TextJobResult {
  jobId: string;
  documentVersion: number;
  text?: string;
  diagnostics?: { line: number; column: number; message: string }[];
}
```

取消/超时通过终止对应 Worker 或显式 cancel。文档已变化则不应用迟到结果。格式化结果作为单次 undo transaction；不是成功保存。Markdown HTML 清洗在 renderer 的最后边界执行，Worker 返回不是可信 HTML。预览本地图片只通过受限 asset resolver；不能把裸任意路径组成可读取URL。HTML导出重新清洗、资源内嵌且超限提供占位/取消；PDF通过无IPC/无网络的隔离文档，使用Windows WebView2 PrintToPdf/PrintToPdfStream适配器生成真正本地PDF并验证写出；仅弹系统打印框不算完成。具体输出需M3原生验证。

## 6. 桌面与恢复 desktop

| 命令 | 输入 | 输出 value |
|---|---|---|
| `load_settings` | `{}` | `{schemaVersion,version,settings}` |
| `save_settings` | `{expectedVersion,settings}` | `{version}` |
| `write_recovery_snapshot` | `{documentId,documentVersion,baseDiskRevision?,text,format,newlineMap?}` | `{durableVersion,writtenAt}` |
| `list_recovery_entries` | `{}` | `{entries:RecoveryEntry[]}` |
| `resolve_recovery_entry` | `{entryId,action:'restore'|'discard'|'inspect'}` | `{resolved:boolean}` |
| `open_external_link` | `{url,userGestureId}` | `{opened:boolean}` |
| `set_file_associations` | `{extensions:string[],enabled:boolean,explicitConsentId}` | `{applied:string[],failed:string[]}` |

settings 的 schemaVersion 是格式版本，version 是每次成功更新递增的内容修订号；首次load必须返回二者。保存、导入、重置均携带expectedVersion，冲突返回CONFLICT和当前版本供重读，不静默覆盖。

快照通过原子JSON清单+独立内容文件持久化，返回 durableVersion 表示该版本实际写入；失败显示“恢复副本未更新”。恢复打开后仍是 dirty buffer，不能覆盖源文件。`restore` 操作只恢复内存；写回源文件仍走 save expectedDiskRevision。恢复条目缺失/损坏逐条隔离，不拖垮启动。

打开外链只允许 http/https/mailto，必须来自明确用户动作；未知 protocol/file/command 拒绝。不注册可任意执行命令的链接协议。文件关联由操作系统支持方式处理，不能绕过 Windows 默认应用限制，不能修改与本项目无关关联。

## 7. 接口测试要求

1. 保存 N 期间继续输入到 N+1，Ack(N) 不清理 dirty。
2. 外部修改、编码不可表示、磁盘满、只读、replace失败都保留可恢复内容。
3. 同 requestId 同 payload 回放，异 payload 拒绝，处理中 BUSY；传输超时后 stat 消歧。
4. grant 路径 `..`、junction逃逸、大小写/Unicode/长路径、未知 grant、失效 cursor 明确失败。
5. 搜索取消、迟到事件、截断、正则错误和 UTF16/Unicode 定位正确；跨文件替换脏buffer跳过且可撤销不覆盖新改动。
6. 应用重启、损坏清单、多窗口并发写会话不丢未保存草稿。
7. file-core 的磁盘行为必须在 Windows 原生集成测试中验证；Web mock 只能验证调用和UI。
