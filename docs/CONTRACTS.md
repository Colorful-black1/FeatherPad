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
  canonicalIdentity?: string; // Windows FileIdentity 的 SHA256；仅用于前端稳定去重，不是写盘授权
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
| `open_document` | `{ref,encodingOverride?,mode?:normal或head-preview或text-preview,documentId?}` | `OpenDocument` | 常规打开严格识别；显式试开只读；同一文件复用DocumentId，documentId用于会话恢复 |
| `save_document` | `SaveRequest` | `SaveAck` | 同一文档串行，冲突不覆盖；超时结果可能未知 |
| `auto_save_document` | `SaveRequest` | `SaveAck` | T202后台保存只写既有lease；共用版本/事务/请求缓存，不弹另存/硬链接/覆盖确认，需确认或冲突时失败并暂停 |
| `inspect_workspace_root` | `{root:FileRef}` | `{ref,displayName,displayPath,canonicalIdentity}` | 只接受已授权目录根，返回身份摘要与显示路径，不扩大授权 |
| `release_workspace_root` | `{root:FileRef}` | `{renamedDocuments:RenamedDocument[]}` | 撤销该目录grant前，原生将使用此grant的打开文档逐项绑定独立文件grant；保留DocumentId/句柄/编码/分块状态，不删除文件；会话内最多256个移除回执可幂等重取 |
| `read_document_chunk` | `{documentId,handleId,expectedDiskRevision,byteOffset,maxBytes}` | `TextChunk` | maxBytes默认64KiB最大1MiB；编码边界对齐、行位置正确，磁盘变化返回CONFLICT，绝不把片段作为可保存全文 |
| `save_document_as` | `{documentId,requestId,documentVersion,text,format,newlineMap?,intent?:'save-as'|'copy'}` | `{documentId,ref,metadata:FileMetadata,ack:SaveAck}` | 原生保存选择器；取消CANCELLED；覆盖确认绑定目标revision；copy不改源绑定 |
| `stat_document` | `{documentId}` | `FileMetadata` | 核对未知保存结果或磁盘变化 |
| `reopen_with_encoding` | `{documentId,encoding,expectedDiskRevision}` | `OpenDocument` | 按已有grant读取并重验revision；dirty先由UI保存/明确保护后重开，缓冲版本再核对，不隐式丢弃 |
| `check_encoding` | `{text,encoding,documentVersion}` | `{encoding,documentVersion,lossCount,samples:{offset,length}[],replacementText:string|null}` | 无磁盘写入；64MiB上限；位置为UTF16偏移，最多32例；有损时仅生成问号替代候选，须版本绑定确认后形成可撤销变更 |

T201恢复边界（2026-11-03）：恢复正文始终是UTF8逻辑文本，目标编码是意图；GBK等目标暂不能表示的新输入仍必须可恢复。恢复/回收前快照严格校验编码/BOM组合、版本和逐行映射，但不要求正文已能按目标编码落盘；真正保存仍完整严格编码，不使用替代字符。未知编码、错误映射、摘要/配额/授权断言保持不变。

T204授权持久化：schema1授权文件增加可选`revokedGrantIds`（最多4096个UUID，旧文件缺省为空）；撤销与独立文件grant同一次受保护写入，成功后才更新内存根/lease。合并旧会话授权时过滤撤销ID，不能因迟到会话或最近/收藏引用恢复原目录权限。用户重新选择会产生新的grant ID。

T204收藏：`workspaceFavorites`使用schema1、最多100项/32KiB，独立于最近记录与其开关；损坏或超额不覆盖/截断原记录。`load_session.restoreGrantIds`合并最近50项与收藏100项，上限从50调整为150个规范UUID，仅恢复既有身份匹配的持久grant，撤销ID始终被过滤。

M2工作区补充（2026-11-03，G2通过）：`transfer_entry {source,targetParent,mode:'move'|'copy',expectedRevision,requestId}`只接受两个已授权目录树中的非链接项，目标碰撞返回CONFLICT，源revision不符不写入；成功返回新`DirectoryEntry`、受影响打开文档的DocumentId重绑和`sourceRemoved`。跨卷移动先完成并校验目标复制，再仅回收源，不宣称两卷原子；任一步失败都按可见的部分结果报告。`walk_workspace`接受最多16个root grant、include/exclude、respectGitignore、followDirectoryLinks、includeHidden和maxFiles，返回受授权ref、跳过原因/数量、cancelled/truncated；默认不跟随链接，深度64/文件量500,000有界，按canonical identity去重。`cancel_workspace_walk {requestId}`幂等。工作区文件`.featherpad-workspace`仅由已授权file-core读写，schema1存储相对/绝对根、exclude、respectGitignore和followDirectoryLinks，不存正文或新增授权。

T201会话补充：schema1的`SessionView`增加可选`encodingOverride`（限8个受支持canonical label），旧清单缺省仍按BOM/严格UTF8读取。记录来源磁盘的编码而非尚未保存的转换意图；恢复正文的目标格式继续来自校验过的恢复manifest。编码字段不授予文件权限，仍使用既有FileRef/identity/revision恢复流程。
| `release_document` | `{documentId}` | `{released:boolean}` | 仅释放资源，不删除文件/恢复快照 |
| `discard_recovery` | `{documentId,throughVersion}` | `{documentId,throughVersion,discarded:true}` | 显式放弃授权；先持久化标记、再清理对应版本快照，失败不关闭；同文档保存/回收互斥 |

T107.a资源释放决策（2026-11-02）：请求严格只含规范UUID的documentId。释放该文档的文件身份索引、lease、分块标志和全部分块句柄，不撤销可供再次打开的原始grant；同一会话重试已释放ID返回released=false，无原生lease的无标题/缺失缓冲同样是正常结果。重开原文件建立新DocumentId，其他已打开文档及其句柄不受影响。IPC先取得与保存/回收共用的逐文档许可，在途保存返回BUSY且不释放；成功回执后前端才移除对应缓冲。释放不代表放弃，不删除或屏蔽任何恢复副本；显式放弃另行持久化tombstone，失败保留标签。标签交互、脏关闭与放弃链路已通过T107相关Release验收，证据见PROGRESS；启动恢复仍待T110。

T107.b放弃恢复决策（2026-11-02，分切片实施）：显式放弃绑定documentId与throughVersion（JS安全整数），不接受任何存储路径。先在私有recovery内排他写入并flush/读回校验不可变tombstone，再清理该文档不高于该版本的恢复指针/正文；标记、读取及快照写入共用.recovery.lock。相同或更旧的放弃可幂等重试，不降低已放弃版本上界；失败不关闭缓冲。load及迟到的快照写入均必须拒绝已放弃版本，新输入的更高版本仍可获得保护。标记缺失/损坏不能默认等同“可恢复”，不跟随链接、不操作清单中的sourcePath，不删除其他文档。T110启动扫描/恢复认领及save-transactions候选恢复也必须查询这些标记，不复活旧正文；歧义保存的临时/backup证据不能当普通草稿静默删除。T107.b1先验标记与恢复屏蔽，b2补物理清理和受校验IPC，未完成前不开放放弃UI。

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
  revision: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null; }
```

| 命令 | 输入 | 输出 value |
|---|---|---|
| `list_directory` | `{ref,cursor?,limit?:number,showHidden?:boolean}` | `Page<DirectoryEntry>` |
| `create_entry` | `{parent:FileRef,name,kind:'file'|'directory',requestId}` | `DirectoryEntry` |
| `rename_entry` | `{ref,newName,expectedRevision?,requestId}` | `{entry:DirectoryEntry,renamedDocuments:{documentId,ref,displayPath}[]}` |
| `get_trash_impact` | `{ref,expectedRevision}` | `{ref,displayPath,kind,revision,identity,affectedDocuments:{documentId,displayPath,canSnapshot}[]}` |
| `trash_entry` | `{ref,expectedRevision,expectedIdentity,requestId,affectedDocumentIds,snapshots:SaveRequest[]}` | `{trashed:true,receiptId,missingDocumentIds,drafts:{documentId,documentVersion,receiptId}[]}` |
| `start_watch` | `{refs:FileRef[]}` | `{watchId:string}` |
| `stop_watch` | `{watchId}` | `{stopped:boolean}` |

limit 默认 200、最大 1000；cursor 绑定授权根/canonical目录、目录revision、隐藏项过滤和零基偏移，不包含可直接使用的本机路径。目录直接子项变化导致旧cursor返回CONFLICT，重载从首分页开始；不重复无限分页。`showHidden`默认false。列表只枚举当前层，文件夹在前、名称自然排序；读取任一条目失败不返回部分伪成功页。`choose_folder`只返回内存grant和安全的根显示名，不授予任意路径IPC。名称校验 Windows reserved device names、空白尾点、路径分隔符和空名称，碰撞默认拒绝，不自动覆盖。多选变更返回逐项结果，不宣称原子性。
M1/T104实施决策（2026-11-01）：目录打开后只请求根的直接子项，默认200条；展开目录时才请求该层，前端不递归预取。分页cursor由Rust生成，旧的过滤器或目录revision不能复用；页面上的`ref.relativePath`使用授权根内规范化相对路径。隐藏项是显示过滤，不等同于后续搜索ignore规则。失败页显示在原目录行并提供重试，不清空已成功的其他目录缓存。枚举期间Rust以不共享删除的句柄锁住父路径链与目录本身，并复核打开句柄的最终canonical路径，避免检查后目录被换名为越界reparse。
同一进程内重复选择相同canonical目录时复用既有目录grant，使关闭/重开树后已打开文档仍可定位；复用不扩大既有授权范围。目录树刷新`locate`按相对路径逐层加载，当前文件属于另一授权根时明确提示且不扫描其他根。

**变更命令不可盲目重试。** create/rename/trash 用 requestId 在运行进程中去重、校验 payload；超时先查询目录/receipt。进程崩溃后不提供 exactly-once 保证，UI 先重扫状态。回收站 receipt 是审计标识，不承诺所有系统配置均支持程序化还原；引导用户系统回收站恢复。reparse point 每次解析后验证授权边界，不默认递归跟随。

M1/T105.a实施决策（2026-11-01）：`create_entry`只接受目录授权内的目录引用；空名、控制字符、路径分隔符、Windows保留设备名及数字/上标变体、尾点/尾空格、单段超过255个UTF-16单元和最终路径超过32,767单元在任何写入前拒绝。新建文件用`create_new`，目录用排他创建；父路径链及目标目录在操作期间保持不可换名，已存在统一返回`CONFLICT`，绝不覆盖。`DirectoryEntry.revision`绑定目录列举时的名称、类型、完整Windows属性、大小及最后写入FILETIME；仅文件使用原始大小，目录大小固定为0，避免枚举与metadata的目录大小差异。`rename_entry`拒绝空相对路径和链接项，先按当前明确引用重新计算revision并复核，再在锁定的同目录使用不覆盖移动。大小写改名走UUID命名的同目录中间项；第二步失败必须尝试移回原名，中间态不能报成功。

文件改名直接更新已有lease路径；目录改名前先释放其后代文件lease，移动后从新路径逐个重新打开，核对FileIdentity与最终路径，再恢复原DocumentId。重新打开或注册失败会尝试将目录移回原名并重绑旧路径；回卷或重绑失败须明确报告，不返回成功。成功结果返回新`DirectoryEntry`及受影响的`documentId/ref/displayPath`列表，应用端据此更新标签路径但保留原缓冲、undo与dirty；未打开文档不发生内存映射。创建/改名成功后刷新当前目录及直属上级目录的revision。requestId在进程内成功去重并绑定完整payload，同ID异payload拒绝，失败不伪装已提交。

T105.b2草稿实施决策（2026-11-02，已接回收编排）：删除前快照使用本地状态目录的`recovery/<receiptId>/`，独立于保存事务。schemaVersion=1的manifest包含reason=before-trash、documentId、bufferVersion、原始路径与sourceRevision、encoding/BOM、newlineMap、UTF-8归一化正文的字节数/SHA256和创建时间。正文先排他写入`body.bin`并flush，manifest后写并flush，随后读回摘要和schema核验才确认保护成功；缺失/损坏不自动删除唯一副本。单正文64MiB、恢复目录总256MiB预算，持有`.recovery.lock`的OS文件锁后才核算及写入，并发请求不能同时消耗剩余配额；超限拒绝新保护且回收编排必须停止。receipt严格UUID，读取不接受路径；body/manifest及目录链拒绝reparse。该快照不清dirty、不写源文件；T110后续接启动扫描/认领/热退出/冗余清理，并将既有保存事务纳入空间管理，本切片不宣称会话恢复完成。

T105.b2回收编排决策（2026-11-02，已实现）：impact与执行只接受目录grant内的非根、非链接引用和必需expectedRevision。impact另返回真实Windows文件identity的摘要，执行必须提供expectedIdentity；普通元数据相同的路径替换也不能沿用旧确认，原生PreDeleteItem会再次核对该身份。Rust按真实lease路径确定所有受影响文档，包含经独立file grant打开的同路径后代；执行携带完整affectedDocumentIds，且为每份完整缓冲提供快照（clean也保护），分块/限量预览不伪造全文快照。列表变化、重复/额外/缺失快照或快照校验失败均在回收前拒绝。依次落盘并读回所有快照后才释放后代lease并调用原生回收；回收前失败不触及源；原生失败或结果不明保留缓冲/快照并提示检查磁盘状态，若已释放lease则尝试按原引用和FileIdentity重开，不承诺所有系统部分失败都将源留在原路径。成功只返回opaque receipt及缺失文档ID，系统回收路径不穿越IPC。requestId绑定完整payload，在FileService互斥锁内缓存成功和失败结果，未知传输结果只能重用原始请求核对；同ID异payload拒绝，不能对新出现的同名文件重复回收。详细结果缓存256项，回收请求另留会话内摘要tombstone；详细回执过期后拒绝执行旧请求，最多接纳10,000个回收请求，达到上限拒绝新请求，已有请求仍可核对。应用私有状态目录及其祖先/后代不能由该入口回收。

watch 事件：`filesystem_changed {watchId, sequence, entries:[{ref,kind,diskRevision?}],overflow:boolean}`。去抖、合并、自写标记仅做优化；overflow 和窗口重新聚焦后 stat 兜底，不能只依赖事件判断源文件安全。

T111实施决策（2026-11-02，已通过相关验收）：比较使用`get_disk_snapshot {documentId}`返回`OpenDocument`但不改原lease/授权；`reload_document {documentId,expectedDiskRevision}`重新读取并核对绑定的revision后才接纳新lease，保持DocumentId。替换目标已属于另一个已打开identity时拒绝接纳。前端在同文档保存队列内编排，回执到达时再次核对bufferVersion、原绑定和dirty/退出状态，迟到读取不覆盖新输入；显式dirty重载前必须确认最新草稿已落盘。新正文单调推进bufferVersion，不沿用磁盘DTO的初始0版本。外部rename未能安全跟随时显示原路径缺失，保留正文并提供另存/重新核对，不扩大文件grant为父目录授权。watch只传受授权引用，不泄露父目录其他条目；overflow、序列缺口及窗口聚焦触发重新stat。覆盖仍须明确确认并绑定最新磁盘revision，比较后再次修改会拒绝旧确认。

T111覆盖接口`overwrite_document`接受与`save_document`相同的SaveRequest；expectedDiskRevision必须来自最新比较/核对。原生再次核对后显示默认可取消的确认框，确认返回后重新读取同revision并接纳lease，再进入既有完整事务保存/硬链接确认/替换前复核。不是force开关，不绕过权限、只读、配额、grant或保存队列。共用SaveHistory和请求摘要，传输未知只复用同一requestId/快照核对；回执只更新捕获版本，新输入仍dirty。删除后的正文保留引用以便聚焦核对重新出现，普通保存转到原生另存选择器，由用户明确选择重新创建目标。

T111会话授权衔接：未经接纳的外部替换继续不更新持久identity；仅`reload_document`已核对revision、唯一identity、原grant与当前句柄最终路径并接纳新lease后，更新该file grant的持久identity，使已接纳的clean正文可在后续会话重开。比较本身不更新。保存和重载复用同一句柄/授权校验原语，不引入任意路径授权。

G1身份复核（2026-11-02）：已打开路径被外部替换后，再次`open_document`继续返回既有逻辑DocumentId；只读磁盘快照的canonicalIdentity和diskRevision反映新磁盘对象，不替换既有lease或更新持久grant。释放后再次打开才创建新DocumentId。T101旧测试已按T111既有行为补强物理身份与lease断言，不改变生产契约。

G1恢复锁竞争补正：仅私有恢复/保存总预算锁的`WouldBlock`返回`BUSY`且`retryable:true`，此时尚未获得锁或开始该次写入。周期恢复保留未保护提示，并按原1秒调度再次尝试同一最新版本；成功Ack才清除提示/标保护。其他BUSY、满盘、权限、未知IPC结果仍按失败版本停止自动重试，热退出仍须成功落盘或显示失败，不因可重试而自行退出。

G1二进制只读试开决策（2026-11-02已通过相关Release）：`open_document`新增显式`mode:"text-preview"`，沿用既有FileRef授权，不自动试开、不接受任意路径。<20MiB完整读取，≥20MiB仅显示前1MiB并明确截断；均核对全文件revision，读取窗口外的变化也可检测。返回`mode:"text-preview"`及`content.kind:"head"`、`previewBytes/totalBytes/truncated:boolean`，truncated必须等于previewBytes小于totalBytes。BOM优先解释UTF16/UTF8，无BOM按UTF8试读；无效序列以替代字符显示并明确提示，控制字符以可见符号显示，原始字节不改变。该展示不是可保存正文，前后端均禁止保存/覆盖/另存/副本，lease保留只读标志，重载及会话恢复必须保留模式。已有可编辑缓冲只聚焦，不被试开替换。CodeMirror只读显示，超过100,000字符的长行关闭软换行并提示水平滚动，不减少试读范围；证据见PROGRESS，G1整体报告仍待完成。

T111边界：比较仅返回完整<20MiB文本，大文件返回READ_ONLY提示并继续使用受限重载/分页，不返回已释放的临时分块句柄。监听最多4个订阅，每订阅256引用/64父目录；原生64KiB通知缓冲非递归，100ms前端合并后核对所有已打开引用，overflow会核对并重建订阅。停止取消在途原生读取后才释放其缓冲；失败可见，一次成功stat不代表监听已恢复。外部文件名不穿过IPC，实际kind为changed，缺失/权限/离线由stat结果判断。

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

M2搜索与替换实现契约（2026-11-03，G2通过）：`search_workspace {requestId,roots,pattern,isRegex,isCaseSensitive,isWholeWord,include,exclude,respectGitignore,followDirectoryLinks,includeHidden,maxMatches?}`直接返回`{files,skipped,totalMatches,scannedFiles,truncated,cancelled,elapsedMs}`并发送带requestId/sequence的进度事件；`cancel_workspace_search {requestId}`幂等，前端必须以requestId/sequence丢弃迟到结果。最多10,000匹配、1,000匹配/文件、64类跳过原因，单文件>20MiB和二进制默认跳过。`create_replace_plan`不写盘，返回schema1 plan/confirmationToken及逐文件before/after revision、summary、encoding和ready/dirtySkipped/readOnly/conflict/unsupported状态；ready文件必须有短期私有before/after快照引用。`commit_replace_plan {planId,confirmationToken,selected}`再次核对token/revision/授权，逐文件写入并报告succeeded/failed/remaining；journal先持久化。`rollback_replace_batch {batchId}`只在当前revision仍等于该提交结果时恢复，后续编辑冲突进入conflicts并保留新字节。confirmation/batch ID运行内去重，不能把selected路径当授权或宣称跨进程全局原子。

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

取消/超时通过终止对应 Worker 或显式 cancel。文档已变化则不应用迟到结果。格式化结果作为单次 undo transaction；不是成功保存。Markdown HTML 清洗在 renderer 的最后边界执行，Worker 返回不是可信 HTML。T301宿主仅允许同源frame与本地Worker，内容frame采用空sandbox和独立禁脚本/网络CSP；Wry Windows初始化补丁保证仅顶层frame获得Tauri桥。预览本地图片只通过受限 asset resolver；不能把裸任意路径组成可读取URL。HTML导出重新清洗、资源内嵌且超限提供占位/取消；PDF通过无IPC/无网络的隔离文档，使用Windows WebView2 PrintToPdf/PrintToPdfStream适配器生成真正本地PDF并验证写出；仅弹系统打印框不算完成。具体输出需M3原生验证。

## 6. 桌面与恢复 desktop

| 命令 | 输入 | 输出 value |
|---|---|---|
| `load_settings` | `{}` | `{schemaVersion,version,settings}` |
| `save_settings` | `{expectedVersion,settings}` | `{version}` |
| `write_recovery_snapshot` | `{documentId,documentVersion,reason:'periodic'|'hot-exit',baseDiskRevision?,text,format,newlineMap?}` | `{documentId,durableVersion,receiptId,writtenAt}` |
| `list_recovery_entries` | `{}` | `{entries,failures,startupWarnings,storageBytes,saveTransactions}` |
| `load_recovery_entry` | `{receiptId}` | `{entry:RecoveryEntry,text}` |
| `load_save_transaction` | `{receiptId}` | `{receiptId,displayName,text,format,newlineMap}` |
| `save_session` | `{manifest:SessionManifest}` | `{saved:true,persistedAt}` |
| `load_session` | `{restoreGrantIds?:string[]}` | `{session:SessionManifest|null,warning:string|null,restoredGrantIds:string[]}` |
| `clear_session` | `{}` | `{cleared:true}` |
| `resolve_recovery_entry` | `{entryId,action:'restore'|'discard'|'inspect'}` | `{resolved:boolean}` |
| `open_external_link` | `{url,userGestureId}` | `{opened:boolean}` |
| `set_file_associations` | `{extensions:string[],enabled:boolean,explicitConsentId}` | `{applied:string[],failed:string[]}` |

settings 的 schemaVersion 是格式版本，version 是每次成功更新递增的内容修订号；首次load必须返回二者。保存、导入、重置均携带expectedVersion，冲突返回CONFLICT和当前版本供重读，不静默覆盖。

T112实施决策（2026-11-02，已通过相关真实Release）：`load_settings {}`扩展返回`{schemaVersion:1,version,revision:string|null,settings:Record<string,JsonValue>,warning:string|null,recoveryCopies:{id,version}[]}`；`save_settings {expectedVersion,expectedRevision:string|null,settings}`返回`{version,revision}`。revision由file-core磁盘快照产生，防止第三方保持version却改写正文时被覆盖；首次缺失为version0/revision null。私有设置位于状态目录`settings/settings.json`，使用OS锁、受校验临时文件flush、原生不覆盖创建/带唯一备份的替换和写后读回；旧配置保留为可恢复备份。`restore_settings {expectedVersion,expectedRevision,recoveryId}`仅选择私有目录中规范UUID备份，仍递增当前版本并复核revision。损坏JSON隔离留原件并提示，可选择有效旧备份恢复；较新schema/超限/权限错误不默默清空。设置最大64KiB，未知设置键保留，非法已知值由设置合并层诊断并回退，不把配置内容执行为代码。真实Release证据覆盖创建/更新/重启、同版本外部改写拒绝、未知键、本机字体、坏JSON隔离和显式旧副本恢复；Web E2E仍只证明mock UI。

T112应用层按默认 < 用户 < 工作区允许项 < 会话临时选择合并；工作区只读取授权根内`.featherpad/settings.json`（schemaVersion1/settings对象），只接受tabSize/insertSpaces/wordWrap/lineNumbers/highlightActiveLine，其他键保留但不应用并诊断。用户设置页先即时预览，保存才持久化，取消恢复进入预览前效果；导入先校验并展示变更，导出复用既有原生Save As与安全保存副本，不新增任意路径写IPC。缺失本地字体使用固定本地后备并提示，不下载字体。T109快捷键入口保持，完整全局唤起仍T214，历史隐私仍T113/T215，不开放未实现的高风险设置开关。

快照通过原子JSON清单+独立内容文件持久化，返回 durableVersion 表示该版本实际写入；失败显示“恢复副本未更新”。恢复打开后仍是 dirty buffer，不能覆盖源文件。`restore` 操作只恢复内存；写回源文件仍走 save expectedDiskRevision。恢复条目缺失/损坏逐条隔离，不拖垮启动。

T110存储扩展决策（2026-11-02，按切片实施）：复用schema1、UUID receipt不可变正文/manifest、目录链/reparse校验、OS配额锁、256MiB预算和版本化discard tombstone。reason从before-trash扩展为periodic/hot-exit；普通快照允许sourcePath/sourceRevision同时为空以表示无标题/未绑定副本，命名来源则两者同时存在，路径仅由原生lease或既有受校验恢复记录派生，不由写快照IPC接收。存储/读取不访问该sourcePath，不改源文件；正文、格式/换行/版本及校验仍完整验证。a先扩展native存储和定向文件测试，b继续IPC/定时快照，c启动扫描/认领及会话清单，d退出拦截/flush及相关真实Release。完整恢复和热退出未验前T110保持进行中。

T110会话与扫描（2026-11-02，已通过相关真实Release）：会话view使用bufferVersion、成对存在或同时为空的fileRef/diskRevision及normal/head-preview模式；文件/根授权仅由原生既有grant持久化，重启核对文件identity后才恢复授权，load_session返回restoredGrantIds，缺少当前及历史有效授权记录时返回SESSION_INCOMPLETE。重新打开可携带会话DocumentId，仍遵守单文件身份规则。list_recovery_entries返回entries、failures、startupWarnings、storageBytes和saveTransactions；只读扫描保存事务并核对摘要/阶段/同一discard tombstone，坏标记不列候选，歧义临时/备份保留且不静默删除。超过30天仅提示。统一256MiB配额及显式事务读取已实现，完整隐私管理继续由T215实现。

T113最近记录契约（2026-11-02，已通过相关真实Release）：`OpenDocument.canonicalIdentity`为Windows `FileIdentity`的SHA256字符串，用于前端按稳定文件身份去重；它不替代grant、documentId或磁盘revision，也不能作为写盘授权。`load_session`请求可带最多50个规范UUID `restoreGrantIds`，原生只尝试重新打开持久化记录中仍存在且文件身份/根路径仍匹配的grant，返回本次实际恢复的`restoredGrantIds`；未知、越权、格式错误或当前不可用的记录不恢复。最近记录本身存于版本化设置，最多50项/48KiB，不存正文、搜索词或剪贴板；关闭历史只停止新增，既有记录需显式移除/清空。写入成功后前端刷新会话，使对应grant持久化。

M2桌面可靠性契约（2026-11-03，G2通过）：`set_global_shortcut {enabled,shortcut}`仅接受规范、无歧义且未保留的加速键，默认enabled=false；成功返回`{enabled:true}`，系统占用/格式错误显式失败且不改变当前注册，停用或应用退出必须释放。全局动作只显示并聚焦既有主窗口，不执行文件操作。隐私清理沿用版本化设置和恢复存储：最近、收藏和恢复分别请求，不能把关闭最近记录等同清空已有项，也不能删除活动dirty文档唯一恢复副本；损坏/无法校验的恢复证据保留并报告。设置中的最近/收藏只保存稳定标识、显示名和排序元数据，不保存正文、搜索词、剪贴板或遥测。T204把`restoreGrantIds`上限扩至150，T113原文的50只指最近项自身上限。

打开外链只允许 http/https/mailto，必须来自明确用户动作；未知 protocol/file/command 拒绝。不注册可任意执行命令的链接协议。文件关联由操作系统支持方式处理，不能绕过 Windows 默认应用限制，不能修改与本项目无关关联。

T110统一空间预算决策（2026-11-02，已实现）：recovery和save-transactions共享本地数据域的`.snapshot-budget.lock`及256MiB上限；快照/放弃标记先取得共享预算锁，再取既有恢复锁，保存事务从写入前到提交/阶段落盘持有预算锁。保存预留manifest、原始字节、目标字节及所有阶段记录的完整大小；目录枚举有深度/项数界限并拒绝reparse，核算失败即拒绝新写入。不自动删歧义事务、唯一未保存副本或测试产物。各存储的既有独立校验和锁继续生效，锁冲突返回BUSY。

T110事务读取契约（2026-11-02，已实现）：list_recovery_entries增加saveTransactions候选摘要（receiptId/displayName/bufferVersion/bodyBytes）；load_save_transaction仅接受receiptId，不接受源/临时/备份路径。读取时在统一存储锁内重新核对manifest、阶段、body/original摘要及原文档discard版本，已提交/已放弃/坏标记不可认领。正文按清单encoding/BOM严格解码、规范化换行并重新编码逐字节核对；返回原编码/逐行换行意图。仅读取应用私有body，不修改或授权目标源文件；UI以新DocumentId创建dirty未绑定副本，明确展示待写快照状态，只有真实snapshot Ack才称已保护。保留原事务证据，读取失败仍可人工核对。

T110启动版本判定（2026-11-02）：SessionView记录bufferVersion。已成功重新打开的clean会话文档，旧恢复副本版本不高于该clean版本时不自动叠加；快照比会话新时仍须恢复，防止崩溃前最后成功快照被旧clean清单遮蔽。缺源文件时保留可读恢复候选，不由clean清单删除唯一正文。所有版本仍为JS安全整数；未验收的旧实验清单不兼容时隔离保留，不能静默丢正文。

T110缺失源占位（2026-11-02）：缺根/缺文件保留原会话引用并展示重新选择/移除占位，后续会话保存继续保留未解决项目；重新选择仍走原生选择器，移除占位不删除文件或恢复正文。保存会话可保留已在受校验grants.json中存在但当前不可用的授权元数据，不能据此获得当前读写授权；新未知ID仍返回SESSION_INCOMPLETE。恢复时继续重新核对identity。应用自身原子保存成功后，从已验证的保存后句柄更新file grant的持久identity，未经接纳的外部替换不自动更新；T111受校验重载接纳后的授权衔接见该节。

## 7. 接口测试要求

1. 保存 N 期间继续输入到 N+1，Ack(N) 不清理 dirty。
2. 外部修改、编码不可表示、磁盘满、只读、replace失败都保留可恢复内容。
3. 同 requestId 同 payload 回放，异 payload 拒绝，处理中 BUSY；传输超时后 stat 消歧。
4. grant 路径 `..`、junction逃逸、大小写/Unicode/长路径、未知 grant、失效 cursor 明确失败。
5. 搜索取消、迟到事件、截断、正则错误和 UTF16/Unicode 定位正确；跨文件替换脏buffer跳过且可撤销不覆盖新改动。
6. 应用重启、损坏清单、多窗口并发写会话不丢未保存草稿。
7. file-core 的磁盘行为必须在 Windows 原生集成测试中验证；Web mock 只能验证调用和UI。
