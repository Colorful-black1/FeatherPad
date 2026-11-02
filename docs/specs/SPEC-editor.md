# SPEC-editor：编辑、文档视图与导航

> 模块 `editor`；业务依赖仅 `file-core`。状态：M1/T106已实现并验收F-EDIT-001/002/003/008/018，T107已验收单组F-EDIT-013及F-FILE-018标签关闭，T109已验收F-EDIT-017命令/快捷键；无声明的其余编辑能力仍待实现/验证。不得依赖workspace/markdown/search-tools/desktop；这些能力通过扩展/命令注入接入。

## Objective、技术与追踪

以CodeMirror6提供快速可靠的文本编辑和轻量查看，维持一个文档多视图的一致性。拥有 F-EDIT-001–020，验收索引见 [矩阵](../FEATURE-MATRIX.md)。M1：001–003/008/012/013/017/018；M2：004–007/009–011/014–016；M3：019/020。文件保存/编码/冲突契约见 [file-core](SPEC-file-core.md)。

前端 React+TypeScript 管理文档/视图；CodeMirror6事务是唯一正文修改入口。每次键入、光标移动、选择、普通undo不调用Rust；磁盘读取、保存、恢复快照、图片资源访问才经file-core IPC。高亮/补全采用本地模块，按语言懒加载，无网络/LSP。

T106实际纵切使用`documents.ts`作为唯一document registry，CodeMirror `EditorState`持有正文、selection和undo，React只订阅元数据与派生指标。公共编辑键、`indentWithTab`、CtrlY/CtrlShiftZ、括号匹配、自动配对和语言各自通过Compartment重配；2/4/8空格Tab宽度与语言/括号设置在文档切换时保留。语言解析支持F-EDIT-018必需列表、未知扩展名纯文本回退、手动选择及另存新扩展名后的自动重判；动态import失败保留纯文本可编辑能力。过期transaction、只读修改和缺失文档仍由registry拒绝。

## Feature-ID 追踪清单

M1：F-EDIT-001、F-EDIT-002、F-EDIT-003、F-EDIT-008、F-EDIT-012、F-EDIT-013、F-EDIT-017、F-EDIT-018。

M2：F-EDIT-004、F-EDIT-005、F-EDIT-006、F-EDIT-007、F-EDIT-009、F-EDIT-010、F-EDIT-011、F-EDIT-014、F-EDIT-015、F-EDIT-016。

M3：F-EDIT-019、F-EDIT-020。每项联合矩阵和下述交互/错误/测试验收。

## 提供方契约与状态

跨进程线协议唯一来源是 [CONTRACTS](../CONTRACTS.md)；本文camelCase API/类型是前端模块内部契约，不形成另一套invoke协议。域错误名作为`details.reason`：STALE_BUFFER→CONFLICT，INVALID_RANGE→INVALID_INPUT；只读使用规范READ_ONLY。跨边界使用规范ResultEnvelope/AppError及grant授权。

```ts
type DocumentState = {
  documentId: string; bufferVersion: number; savedBufferVersion: number;
  diskRevision: string | null; isDirty: boolean;
  access: 'editable' | 'readOnly' | 'degraded' | 'previewOnly';
  languageId: string; encoding: string; eolIntent: 'preserve' | 'lf' | 'crlf';
};
type EditorViewState = {
  viewId: string; documentId: string; groupId: 'primary' | 'secondary';
  selection: { anchor: number; head: number }[];
  scrollAnchor: number; isPreview: boolean;
};
type EditRequest = {
  documentId: string; expectedBufferVersion: number;
  changes: { from: number; to: number; insert: string }[];
  origin: 'user' | 'format' | 'replace' | 'markdownTask' | 'eolConvert';
};
```

提供 `getSnapshot(documentId)`、`applyEdits(EditRequest)`、`focusDocument(identity, options)`、`openReadOnlySnapshot(snapshot)`、`registerCommand(command)`、`registerViewExtension(extension)`、`subscribeDocumentChanges(listener)`、`getOpenDocuments()`。版本过期返回 `STALE_BUFFER`；readOnly返回 `READ_ONLY`；位置越界 `INVALID_RANGE`；继承file-core Result/AppError的统一错误形状。批量更改按原快照坐标、逆序应用，重叠区间拒绝或在调用方先合并，不猜测。

扩展仅获得必要快照/编辑入口/视图槽位，不绕过版本验证直接操作CM内部DOM。Markdown注册模式和渲染器，search-tools注册查找/格式命令，desktop注入设置与会话适配器；editor不了解提供者模块。文件快速导航由注入的候选列表提供，不把workspace放进依赖。

文档共享text、undo、编码/换行和diskRevision；视图独立选择、滚动、折叠与焦点。两个视图更改必须映射选择位置并广播同一事务；不能两份本地text互相覆盖。保存快照的bufferVersion与返回值对应，保存中再输入仍dirty。

## 基础编辑与效率操作

F-EDIT-001/002/003：标准选择、剪切复制粘贴/全选、undo/redo（CtrlZ/CtrlY及CtrlShiftZ可配置）、按字/行移动/选择，选择扩大收缩。保存不清undo；重载外部文件建立可解释的新基线，重载前先保护dirty。Windows中文IME组合期间不触发补全接受、格式化或多次事务；surrogate/组合字符不拆坏。行列显示从1开始；视觉列考虑tabSize，状态栏区分字符数与选择数量，不误把UTF16 code unit称字节。

Tab/ShiftTab缩进/反缩进，Tab插入模式与2/4/8宽度可配置；多行处理一次事务。空格与Tab转换只由显式工具执行，不因打开文件而重写。F-EDIT-004行/块注释用语言元数据，未知语言禁用并说明，选择跨语法边界不保证语义分析。

F-EDIT-005/006多光标：Alt单击增删光标，CtrlD选下一个匹配，CtrlShiftL选中全部匹配，Escape回主光标；矩形选择AltShift拖动/方向键扩展。列坐标按tabSize和等宽显示列；Tab中间按显示列选中相邻可用边界，不写入隐藏填充，短行选到行尾；自动换行的视觉行不创建物理行，状态明确。多光标替换冲突区间先合并/去重，一次undo。

F-EDIT-007行移动/复制/删除/上下插空行：相邻选区合并，同一物理行只处理一次，文首/末尾/无末尾换行可预测；跨列/多光标保持映射。F-EDIT-008括号匹配/跳转、成对括号/引号插入删除可独立关闭；在注释/字符串按本地语法能力处理，不声称语义准确。

F-EDIT-009仅当前文档词汇、固定语言关键词和括号补全，不读取系统文件/工程索引，不提供LSP/远程调用。默认最少2字符，候选上限100，CtrlSpace手动触发，Enter/Tab接受，Escape取消，IME composition不抢键。

F-EDIT-010空格/Tab/行尾标记当前行/全部/关闭；仅展示不改变文本。F-EDIT-011本地语法树或缩进折叠、全部折叠/展开；语法错可降级缩进，纯文本明确能力，超大/长行降级关闭折叠。

## 视图、标签与导航

F-EDIT-012字体/字号（默认14px，8–40px）、Ctrl滚轮/快捷键缩放、行号/当前行高亮/自动换行开关。字号变化不改系统缩放。小地图可选，默认关；若没有实现，设置显示未提供而不是空白承诺。≤2MiB正常；>2且<20MiB纯文本降级编辑，关闭高亮/自动补全/折叠/小地图/实时Markdown；≥20MiB只读分块；>100MiB仅显式前1MiB预览。长行>100,000字符同样降级。降级条列出禁用功能，禁止截断后保存。

T114.a键盘焦点决策（2026-11-02）：Ctrl+M切换CodeMirror的Tab移动焦点模式，编辑器底部显示当前模式及Esc后Tab临时离开的提示，并在切换时发出简短读屏公告。模式存于编辑器状态，切换标签或重建view不重置；不写入正文、bufferVersion、dirty或undo，也不承诺退出重启后恢复此临时模式。只读编辑器始终允许Tab离开。当前M1键盘/读屏样本及Windows系统缩放/高对比已于T114整项验收，范围和证据见PROGRESS。

T114.b1字号决策（2026-11-02）：统一命令提供Ctrl+=/Ctrl++放大、Ctrl+-缩小、Ctrl+0恢复14px，编辑区Ctrl滚轮复用同一字号动作，范围8–40px。只调整编辑字体，不改变系统/页面缩放、正文或undo。立即显示的字号通过既有设置队列持久化，在途输入合并为最新字号；保留未知字段、最近记录和设置预览，冲突不盲重试覆盖，失败提示仅本次生效。计划关闭先等待已提交字号写入结束，再执行原有恢复/会话退出流程。该切片不新增IPC或路径授权，相关真实Release及125/150/200%系统缩放已于T114整项验收，证据见PROGRESS。

F-EDIT-013每组至多1个预览标签，单击树/搜索结果复用；双击/输入/固定命令转为固定。dirty永不被新预览覆盖。非正文视图（图片/diff/read）有明确图标和只读状态；同名文件标签显示上级路径。关闭最后标签回欢迎/空状态，不退出应用。

T107单组标签决策（2026-11-02）：打开/关闭结构操作串行；新预览先将旧预览固定，再只尝试关闭仍干净且版本未变的旧缓冲，失败保留并提示。已打开文档再次单击只激活，不把固定标签降为预览。固定状态以schema1、本地最多10,000个原生displayPath偏好保存（每路径≤32,767字符，总JSON≤4MiB），不存正文/grant、不凭偏好自动读文件；损坏或存储失败明确提示，内存标签不丢失。明确关闭后移除该路径偏好。T110负责完整会话/根/文档恢复，T207再扩展为每组独立标签状态；偏好不参与文档身份判定。

F-EDIT-014标签拖排/跨组移动，关闭当前/其他/右侧/全部/已保存；多项dirty按列表决策，取消停止未关闭项，已关闭项记录可重开。最近关闭队列默认20个，含位置/固定/组，不保存被明确放弃的正文；重开dirty仅依已授权恢复草稿，不复活明确放弃内容。

F-EDIT-015至多双分栏，水平/垂直可切，组内标签独立。将文档移到另一组或在另一组打开共享视图；同一文档共享buffer/undo，选择和滚动独立。关闭一组将固定/dirty视图合并另一组并去重，不关闭文档；resize遵循UI最小宽度，小窗口可暂折叠第二组但保持状态。

F-EDIT-016 CtrlP快速文件（打开文档+注入工作区候选），CtrlG行:列，AltLeft/Right前进后退；记录显式跳转，不把每次按键塞进历史，最多100位置。面包屑显示路径/当前语法区，可选本地outline（Markdown/JSON/支持语法），无LSP跨工程符号承诺。文件缺失显示定位/重新打开/移除历史。行列越界clamp并提示，不崩溃。

F-EDIT-017 CtrlShiftP命令面板，命令有稳定id、中文名称/关键词、when启用条件、当前快捷键；禁用项说明原因。面板开启保存返回焦点，关闭回原视图。快捷键冲突由desktop设置服务检测；命令执行仍校验版本/可写状态，不能只靠按钮禁用。菜单/上下文菜单/快捷键调用同一命令。

T109决策（2026-11-02）：共享command registry接收显式上下文，不依赖业务单例；定义稳定id/名称/关键词/默认绑定/禁用原因/执行函数，执行前重验启用态，在途同命令拒绝重复。按钮、面板及应用快捷键使用同一入口；模态/IME组合和已处理按键不分发背景命令。M1提供应用内单组合键重映射、冲突/系统及原生文本编辑保留键拒绝与恢复默认；schema1本地偏好只保存commandId/组合键（≤256项/64KiB），坏数据或写失败可见，不执行配置内容。T112整合版本化原生设置，T214继续完整映射导入导出/全局唤起。CtrlP候选由composition层注入已打开文档和已加载的受授权树文件，显示此范围，不自行遍历磁盘；完整文件导航/历史仍由T210继续。面板使用原生dialog与combobox/listbox，执行时先关面板、按命令恢复焦点，不在空结果上复用旧选项。

F-EDIT-018本地高亮模式至少：纯文本、Markdown、JSON/JSONC、XML、HTML、CSS、JavaScript/TypeScript、SQL、YAML、Java、Rust、Python、Shell、TOML/INI、日志纯文本。按扩展名/用户选择，未知回退纯文本；手选保留于文档会话。Java只高亮/括号/注释，不提供formatter/LSP；“支持语言”不可暗示运行/调试。

## Diff 与图片

F-EDIT-019选择两个磁盘文件或打开缓冲建立只读快照，左右标题标路径/来源/时间，差异行块/下一处上一处、可切忽略空白。diff不自动合并；如需采纳片段必须作为明确的目标缓冲编辑并版本验证，本v1不承诺三方合并。磁盘冲突视图使用F-FILE-016的新磁盘快照，旧对比不授权覆盖新revision。超过2MiB提示按需行diff，20MiB以上仅限量比较/拒绝全量，不挂主线程；相同文件显示无差异。

F-EDIT-020 PNG/JPEG/GIF/WebP/SVG只读查看，适应窗口/原尺寸/缩放（10%–800%）、尺寸/大小，GIF动效可暂停；损坏显示错误并可重新打开。默认文件>20MiB或像素>40百万拒绝完整解码，不尝试爆内存；先读头检查，解码再复核。SVG通过清理和隔离渲染禁脚本/事件/foreignObject/外链/嵌入外部字体，不给Tauri IPC权限，不当可交互HTML加载。图片文本编辑需明确“作为文本打开”，SVG源代码编辑不复用不安全预览。

F-EDIT-020 还拥有HTML文件的安全静态预览：源码/预览切换使用当前缓冲快照，预览不改正文；渲染前清理脚本、事件、表单、危险协议和外部样式，使用无IPC/无脚本/无网络的隔离内容容器。仅通过file-core授权的本地资源可加载；跨根需新授权，远程资源显示占位。页面链接和表单不能导航应用壳或执行代码，禁用动态网页行为并显示“静态预览”。HTML >2MiB时需显式按需预览且可取消，≥20MiB不提供完整预览；错误可回源码。隔离工具通过低层展示/资源契约复用，editor不反向依赖markdown。

## Acceptance、error-state 与测试策略

- 001–003：中文IME、emoji、多行粘贴、mixed EOL、undo至保存前/后；每键无Rust IPC；保存中输入保留dirty。
- 004–011：未知语言注释禁用、多光标交叠/短行矩形/Tab/宽字、文末移动复制、括号组合输入、补全取消、折叠后编辑；每批次一次undo。
- 012/018：字号/换行/语言切换持久化，2/20/100MiB与长行降级条准确，不暗示Java格式化。
- 013–015：预览替换时dirty自动固定，关闭其他中取消、重开、跨组拖动同文档同步undo/独立光标；组关闭正文不丢。
- 016/017：快速文件候选异步取消、越界跳转、缺失历史、命令禁用与焦点恢复；所有核心操作可键盘完成。
- 019：两缓冲差异、文件后续变化、纯空白、超大文件取消；比较不写盘。
- 020：损坏图、20MiB/40MP边界、GIF暂停、SVG脚本/远程URL payload；HTML脚本/表单/跳转/远程图片/越界资源均被阻止，源码预览切换哈希不变；无网络和IPC执行。

推荐结构 `src/features/editor/{documents,views,commands,extensions}/`、`tests/unit/editor/`、`tests/integration/editor/`、`tests/e2e/editor/`，只约定未创建。风格：命令数据与React视图分离；以显式documentId/viewId区分，不使用活动标签全局变量推断编辑目标；事务带origin，禁止直接改DOM当正文。单元测试reducer/版本/区间映射，集成用真实CodeMirror验证组合事务和扩展，e2e在Windows WebView2验证IME/拖放/快捷键/焦点；像素截图只能补充行为测试。

`pnpm test:e2e`仅覆盖Web/mock bridge；Windows真实Tauri/WebView2的编辑和IME已接入`pnpm test:desktop`，仍未覆盖的焦点/图片隔离不能由Web mock代替。M0已建立`pnpm test:unit`、`pnpm test:integration`、`pnpm test:e2e`、`pnpm lint`、`pnpm typecheck`、`pnpm build`和Rust fmt/clippy/test；T106实际通过typecheck/lint、63项TS单测、Rust 66项加1个显式ignored基准、22项Web E2E、Release构建及真实桌面1项。CDP composition记录只证明composition事务；另以Windows Computer Use操作真实微软拼音候选窗，提交“好”后核验正文/状态栏，证据见M1验收。

## Boundaries 与未决风险

Always：事务版本检查、可撤销变更、dirty/只读准确、扩展注入保持单向依赖。Ask first（后续实施变更）：引入LSP/网络候选/第三分栏、改撤销与恢复保证、提高大文件能力阈值。Never：每键调用Rust、共享文件两份独立正文、图片脚本执行、保存成功清除后续输入。

T106已验：单视图CodeMirror事务/undo、选区状态、Tab多行缩进、括号开关、语言高亮/手动选择、系统剪贴板、WebView2 composition和Windows微软拼音候选窗。仍待验：多视图共享undo、IME与多光标组合、列选择宽字符、分块大文件搜索/滚动、diff worker取消和WebView2图片/HTML隔离。T108文件内搜索替换、T109命令入口及T114视图设置与当前M1无障碍已通过各自相关真实验收，证据见PROGRESS。性能数据必须实测，不能从框架选择推导。
