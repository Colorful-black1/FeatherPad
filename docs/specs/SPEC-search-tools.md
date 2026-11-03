# SPEC-search-tools：查找、受保护替换与格式工具

> 轻羽 FeatherPad；模块 `search-tools`；业务依赖仅 `editor`、`workspace`、`file-core`。状态：M1 F-SEARCH-001–003与M2 F-SEARCH-004–009已通过G1/G2；M3的T307–T309实现完成，F-SEARCH-010–012统一验收仍待G3。详见 [矩阵](../FEATURE-MATRIX.md)。

## Objective 与提供方契约

跨进程线协议唯一来源是 [CONTRACTS](../CONTRACTS.md)，本文camelCase方法/DTO是模块内部语义示例。域错误名写入`details.reason`：INVALID_REPLACEMENT/PARSE_ERROR/BUDGET_EXCEEDED→INVALID_INPUT，STALE_PLAN/ROLLBACK_CONFLICT→CONFLICT，FORMAT_UNSUPPORTED→UNSUPPORTED；INVALID_PATTERN沿用规范code。所有磁盘路径使用grant/FileRef授权。

把查找结果和批量变更都做成有来源、有版本、有取消和恢复路径的可检查操作。搜索不等于允许写盘；格式化不等于执行代码。编辑操作使用 [editor](SPEC-editor.md) 的expectedBufferVersion，磁盘提交使用 [file-core](SPEC-file-core.md) 的expectedRevision；扫描范围从 [workspace](SPEC-workspace.md) 获取。

```ts
type Query = {
  requestId: string; pattern: string; isRegex: boolean;
  isCaseSensitive: boolean; isWholeWord: boolean;
  include: string[]; exclude: string[];
};
type ReplacementPlan = {
  planId: string; query: Query; replacement: string; createdAt: string;
  files: {
    identity: string; expectedRevision: string; beforeHash: string;
    encoding: string; eolIntent: 'preserve'; matches: number;
    beforeSnapshotRef: string; afterSnapshotRef: string;
    state: 'ready' | 'dirtySkipped' | 'readOnly' | 'conflict' | 'unsupported';
  }[];
};
type BatchOutcome = {
  batchId: string; status: 'completed' | 'partial' | 'cancelled' | 'unknown';
  committed: string[]; skipped: string[]; failed: string[];
  rollbackJournalRef: string;
};
```

提供 `findInBuffer(query,documentId,scope)`、`replaceInBuffer(expectedBufferVersion,edits)`、`searchWorkspace(query,scopeId)`、`createReplacementPlan(query,replacement,selection)`、`commitPlan(planId,confirmationToken)`、`rollbackBatch(batchId)`、`formatDocument(documentId,language,options)`、`transformText(documentId,tool,scope)`、`cancel(requestId)`。结果沿用统一Result/AppError，附 `INVALID_PATTERN`、`INVALID_REPLACEMENT`、`STALE_PLAN`、`BUDGET_EXCEEDED`、`FORMAT_UNSUPPORTED`、`PARSE_ERROR`、`ROLLBACK_CONFLICT`。事件携requestId和generation，旧结果不可污染新会话。

## Feature-ID 追踪清单

M1：F-SEARCH-001、F-SEARCH-002、F-SEARCH-003。

M2：F-SEARCH-004、F-SEARCH-005、F-SEARCH-006、F-SEARCH-007、F-SEARCH-008、F-SEARCH-009。

M3：F-SEARCH-010、F-SEARCH-011、F-SEARCH-012。每项联合矩阵和下述交互/error-state/test strategy验收。

M1实际实现（2026-11-01）：`FindBar`、`search-query`和本地module worker覆盖文件内查找替换；`tests/fixtures/search-semantics.json`由TS与Rust `regex`测试共同读取。当前交集包括字面/Unicode大小写、Unicode `\p`属性、捕获/命名/非捕获组、字符类、重复、多行和零长度前进。两端语义未证明一致的`\b`/`\B`、look-around及回溯引用明确拒绝；该夹具是代表性子集证据，不外推全部Rust regex语法。验收详情见 [M1](../acceptance/M1.md)。

M2实际实现（2026-11-03，G2通过）：多根目录搜索按文件分组返回编码、revision、截断、跳过统计和进度/取消状态，前端按requestId丢弃迟到结果；纯读搜索可合并打开的dirty buffer，替换计划则显式排除dirty/只读/不支持文件。跨文件计划绑定匹配、revision、前后摘要和短期confirmation token，最终确认前零写入；提交先落盘恢复journal，逐文件复核revision，回滚再次校验提交后字节，文件已有后续修改时保留新内容并报告冲突。真实Release覆盖1,888ms扫描10,000文件/104,860,000 bytes、20ms取消及替换/回滚/冲突fence，证据见[M2验收](../acceptance/M2.md)。物理网络盘和大规模故障矩阵仍按后续综合验收执行。

## 文件内搜索（F-SEARCH-001/002/003）

CtrlF面板非模态，Enter/ShiftEnter下一处/上一处，Escape回编辑器并保留查询。支持当前文档和显式选区；高亮/当前位置/总计、到末尾环绕提示；只读文档可查不可替换。选区版本变化时重算范围，不能对旧offset替换。

普通文本搜索为Unicode字符串；大小写不敏感按确定性Unicode case fold，不跟系统区域随机变化。整词采用Unicode字母/数字/下划线边界，中文连续汉字作为词字符序列，UI说明其不等于中文分词。正则采用由共享夹具定义的Rust regex/local worker安全交集：捕获组/命名组/非捕获组/字符类/重复/多行/Unicode属性支持，不支持回溯引用和look-around；`\b`/`\B`因两端Unicode边界语义不一致必须报错并引导“整词”。前端不得用未测试JS RegExp语法偷偷扩大语义。worker每次键入只在本地匹配，不跨Rust；`tests/fixtures/search-semantics.json`维护两端代表用例。

非法语法/不支持语法给定位错误，不当零结果。零长度匹配每次按Unicode scalar前进，EOF只计一次，不进入无限循环。模式长度上限10KiB UTF-8字节，编译/匹配有内存和时间预算；worker可终止，取消目标≤250ms。单文档搜索默认10,000匹配上限并提示。

替换支持字面文本、`$1`/`${name}`捕获、`$$`字面美元符；非法组引用报错。Escapes使用UI明确选项解释换行/Tab，不能无提示把用户字面`\n`改成换行。单个替换后定位下一处；全部替换先显示数量，可查看匹配摘要，一次editor事务一次undo，不自动保存。异步结果若expectedBufferVersion变化重算，不能偷用旧索引。

## 目录搜索（F-SEARCH-004/005/006）

CtrlShiftF选择一个/多个根或文件夹范围；结果按文件分组显示匹配行、行列、截断行片段、编码/来源。点击定位后复核当前位置，磁盘已变更标记过期并建议重搜。展开懒加载，虚拟化长列表。选项包含/排除glob、遵循gitignore、包含隐藏项和跟随链接（默认不跟随），范围授权/循环策略由workspace处理。

普通目录搜索默认优先显示打开的dirty缓冲快照（不写盘），结果显式标“未保存缓冲”；其他文件读取磁盘并保存revision。替换计划则默认排除dirty文件并显示原因；用户必须保存/放弃后重做预览，不能直接把脏缓冲和磁盘混合提交。多窗口dirty归属也须查询统一文档注册表。

默认跳过二进制、≥20MiB、`.git/node_modules/target/dist/build`及gitignore；2–20MiB可流式扫描且允许取消。中文/长路径/多编码解码，未知编码/有损解码不强行生成可替换结果。使用canonical identity去重多根/硬链接；链接循环/越界跳过计数。

单次最多10,000匹配/50MiB结果预算，单行显示片段最多2,000字符，单文件最多1,000匹配（触发提示）；预算用先到者。进度显示已扫文件/跳过原因/已用时，不伪造精确百分比。扫描worker任务限并发避免UI饥饿。取消或新查询立即关闭旧generation投递，底层在块边界检查取消，目标≤250ms停止结果；已完成结果保留并标“已取消，结果不完整”。超时/预算受限为截断而非“全部完成”。参考1万文件100MiB首批≤500ms、总≤5秒是待验证目标。

## 跨文件替换（F-SEARCH-007/008/009）

### 预览

1. 冻结query/替换表达式/选定文件，重新读取每个eligible文件及revision，严格解码。生成before/after快照、逐文件diff、数量、编码和换行元数据。
2. 只读/dirty/限量预览/编码不确定/有损转换/大文件均列为不可提交并显示原因，不静默跳过。编码目标不能表示替换内容默认阻止，用户需先单独转换编码并重做计划。
3. 用户可取消勾选文件。任何query/替换/选择/文档变化都使plan过期；预览不写磁盘。计划默认10分钟有效，过期重做；这里只限制许可，不删除未保存备份。
4. 首次“替换全部”仅打开确认概要（文件数、替换数、跳过数、备份位置、不能保证外部进程全局原子）。第二次明确确认才发一次性confirmationToken，绑定planId/选择与revision摘要。

### 提交

先预检所有ready文件最新revision、dirty所有权、权限、编码；有变化则整体拒绝开始，要求刷新预览。再为所有将改文件写可恢复before快照、after摘要与状态journal并确认落盘；备份失败不开始。

逐文件调用file-core保护保存，写前再次核对expectedRevision；同进程同identity串行，同一batch只提交一次。每次成功更新journal的before/after revision。某项冲突/错误/取消时停止后续，报告已完成/未完成/失败，不能把部分完成提示成全部失败而隐藏效果。替换临界区不可强行取消；返回unknown时重读文件与journal确认，不盲目重复。所有clean已打开文档由保存事件刷新（先检查未新变dirty），dirty窗口阻止批次。

**批次不具备对任意外部进程的全局原子性**。预检与实际保存之间仍可能出现外部写入，单文件检查-替换也有第三方竞态窗口。受控进程队列和乐观revision检查能降低风险，不能承诺所有应用间事务。遇部分完成允许用户选择安全回滚已完成项，不进行掩盖失败的自动覆盖。

### 回滚与崩溃

journal含schemaVersion、batchId、plan摘要、原始字节备份引用/校验和、beforeRevision、afterRevision、每项state（planned/writing/committed/rollbackPending/rolledBack/conflict）。提交前后均可恢复读取，进程崩溃后展示“待核实批次”，根据实际afterHash核对writing项。

回滚每文件先核对当前revision==记录的afterRevision且无dirty所有者，再恢复原始字节（不是重新序列化文本）；当前已被用户/外部修改则标ROLLBACK_CONFLICT，保留备份并提供打开对比/另存，不覆盖。回滚本身同样可能部分完成，必须逐项报告。最近20个批次/30天为清理提示阈值，总256MiB备份预算；存在未核实/回滚冲突/未保存唯一副本不能自动删除。空间不足拒绝新批量提交并让用户管理备份。回滚记录与普通editor undo不同，UI不可混淆。

## 格式化边界（F-SEARCH-010/011）

T307决策：锁定jsonc-parser3.3.1、Prettier3.9.10、@prettier/plugin-xml3.4.2（MIT；XML词法依赖@xml-tools/parser1.0.12为Apache-2.0），禁脚本安装并复查依赖，生产audit无已知漏洞。JSON/JSONC先严格检查错误，再使用format/applyEdits调整token间空白，保留原数字/重复key/注释；仅显式移除尾逗号。Web使用[standalone](https://prettier.io/docs/browser)与随包本地解析器，不读配置/插件；JSX/TSX按扩展初始化并可显式选定，其他模式拒绝JSX。XML依[插件strict策略](https://github.com/prettier/plugin-xml#whitespace)保留mixed-content空白/CDATA/namespace，额外拒绝DTD和自定义实体，不存在网络resolver。HTML内嵌语言不自动重排，CSS预处理器明确不支持。

交互为全文快照→2秒Worker→预览→expectedVersion一次undo应用，取消/解析错/版本变化保留正文；>2MiB需本次确认，≥20MiB拒绝。当前不支持语法选区格式化。输出不改编码/BOM/换行意图，混合换行按原token顺序保留，新增使用原主导类型，界面显式说明，undo连同映射恢复。错误不向日志发送用户代码帧，仅传行列和有界安全消息。格式偏好限本次可见选项，不自动持久化或读取工程设置。

所有格式化基于当前快照，在worker执行、可取消；预检查语法，失败给行列错误且正文不变。完成时expectedBufferVersion不一致提示重试，不覆盖新输入；一次事务一次undo，不自动保存、不改变编码/换行意图。默认全文；选区仅在formatter支持语法片段时启用，否则明确禁用。>2MiB先提示，≥20MiB只读禁用，默认2秒预算可取消。

| 语言 | v1能力 | 必须守住的边界 |
|---|---|---|
| JSON | 严格解析、缩进/换行/尾换行 | 无注释时严格；不排序key、不删除重复key、不改数值精度；非法报错 |
| JSONC | 注释/尾逗号感知的文本formatter | 保留注释和key顺序，不用JSON.parse后stringify冒充；尾逗号策略可配置 |
| XML | 本地纯文本XML格式化 | 禁DTD/外部实体/网络；保留CDATA/namespace，mixed-content内空白可能有意义则保守保留或拒绝重排 |
| HTML | 语法格式化 | 不执行script/style、不拉资源；脚本内语言仅本地支持，未知template保留/提示 |
| CSS | 本地CSS formatter | 保留注释/自定义属性；未知预处理语法（SCSS/Less）不冒称支持 |
| JavaScript/TypeScript | parser驱动、可配置缩进/引号/分号 | JS/TS含JSX/TSX要按扩展明确识别；不执行项目配置/插件、不做类型检查/语义修复 |
| SQL | 通用SQL、SQLite/PostgreSQL/MySQL显式方言的词法排版 | 非语义验证、不保证存储过程/PLSQL/TSQL/任意厂商扩展；不支持方言拒绝或仅明确保守排版 |
| YAML | CST/token保真格式化、缩进/列表/流式结构 | 保留注释、锚点/别名、tag、多文档与block scalar chomp；不解析再dump，不展开别名；无法保真不改 |
| Java | **仅editor高亮，没有语义或通用formatter** | 格式化按钮禁用说明，不调用JS formatter碰运气 |

具体库及SQL方言默认通用，写入设置必须可见。格式化不能执行shell、读取工程formatter脚本、安装插件或联网。许可证/包体/安全维护纳入M3验证；格式不保真必须失败，不以“最佳努力”静默删注释。

T308实现：锁定sql-formatter15.9.0（MIT）与yaml2.9.1（ISC），禁脚本安装、生产audit零已知漏洞；锁变化仅新依赖与Vite可选yaml peer绑定，未升级既有版本。[SQL后端](https://github.com/sql-formatter-org/sql-formatter)只暴露通用/SQLite/PostgreSQL/MySQL四种方言，关键字/标识符/字符串/参数保留，不代参、不连接数据库，显式拒绝过程/函数/触发器/DELIMITER及未选方言的反引号，仍非语义验证。YAML用本地Prettier源感知printer排版前后，独立[yaml CST/AST](https://eemeli.org/yaml/)核对全部注释、映射顺序、原数值字面量、锚点/别名、tag、多文档/指令和块scalar header/chomp及语义值；不转原生对象dump、不展开别名，无法保真拒绝。YAML禁Tab缩进；所有作业沿用T307版本/预算/预览/undo协议。

## 文本工具（F-SEARCH-012）

T309实现：精确主选区优先，否则全文，其他选区不参与且多选时明确提示；不扩展首尾行。预览列出行列范围与变化行位置数，40k字符截断仅限展示，2秒Worker/版本fence后一次undo提交正文与EOL map。排序按Unicode码点（含非BMP），自然排序数字段按长度/字典比较避免数值精度损失，相等稳定；大小写忽略固定Unicode小写规则，无系统locale。去重保首条，空行保留/移除显式可选；移除末尾全部换行、仅空格/Tab尾空白和仅真实行首缩进均在名称/提示中明确。换行token优先随保留行移动，缺失时复用闲置token，再用原insertionEnding，保留原末尾换行意图；选区外文本/token不变。Markdown给空格敏感提示，代理对内部的选区边界拒绝，编码不变、无自动保存。

选区优先，否则全文且显示范围：行字典序排序（默认Unicode codepoint，可选自然排序、升降序、区分大小写）、稳定去重（保留首条）、大小写转换、尾空白清理、补/移除末尾换行、Tab/空格缩进转换（依据tabSize）。先显示变更数量与范围，可预览；一次事务一次undo，不自动保存。空行保留规则显式开关；只排序文本不跨行解析语法，Markdown代码/表格空格敏感时提示，禁止保存时偷偷清尾空白。操作保持原换行token或显式标示重排的换行意图。

## Acceptance、error-state 与测试策略

- 001–003：Unicode/中文边界、大小写、零长度EOF、非法lookaround/回溯、`$1/$$`、selected范围变更；不死循环，readOnly禁替换。
- 004–006：多根/中文长路径/链接循环/多编码/dirty标记、10k上限与50MiB预算、取消新旧query竞态；结果不完整标签准确。
- 007–009：预览零写入、dirty排除、二次确认取消、同mtime变更、备份失败、第二文件冲突、提交中强杀、回滚前再次改写；磁盘与journal逐项状态符合，后续修改不被回滚覆盖。
- 010/011：每种语言有效/无效与保真golden夹具；JSON重复key/数值、JSONC注释、XML实体/mixed-content、SQL方言、YAML锚点/注释/多文档、Java禁用。验证format前后语义/注释约束，不只截图。
- 012：混合EOL、空行、宽字符/Tab、自然排序/大小写、尾换行、敏感Markdown；undo恢复原字节映射，操作不自动保存。

建议结构 `src/features/search-tools/{query,replace,format,transform}/`、`src-tauri/src/services/search_tools/`、`tests/unit/search-tools/`、`tests/integration/search-tools/`、`tests/e2e/search-tools/`。TypeScript camelCase/PascalCase，Rust snake_case；计划不可变，副作用在commit边界，状态journal显式可恢复。单元测试query语义/转换/formatter保真，集成真实临时磁盘与故障注入/并发，e2e验证预览/确认/取消/部分完成/回滚交互；真实Windows锁定/磁盘满/进程终止另有演练。

`pnpm test:e2e`仅覆盖Web/mock bridge；实际CodeMirror和真实Worker的格式预览/应用/undo/异常终止由`tests/e2e/format.spec.ts`、`transforms.spec.ts`覆盖。Windows磁盘搜索/替换/回滚已有`pnpm exec playwright test --config desktop.config.ts --project reliability --project g2-special`和Rust实际文件测试，见[M2报告](../acceptance/M2.md)；M3格式化/转换的证据和边界见[M3报告](../acceptance/M3.md)。统一命令按todo的M验收清单执行，格式化不会自动保存。

## Boundaries 与未决风险

Always：范围/版本可见、预览与写盘分离、备份先落盘、取消/部分完成可诊断。Ask first（后续实施变更）：扩展正则语法/外部formatter插件、改变备份清理或SQL支持方言、放开dirty跨文件提交。Never：无预览二次确认批量写盘、无条件回滚覆盖后续内容、宣称任意进程全局原子、执行文档/项目代码。

现有正则、编码、formatter保真和Worker终止证据分别见M2/M3报告；完整批次重启/崩溃瞬间矩阵和最终包体/性能仍需M5验证。验证不足需阻止危险写入并报告，不减少完整v1功能清单。
