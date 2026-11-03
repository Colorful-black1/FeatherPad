# SPEC-markdown：安全 Markdown 阅读与导出

> 模块 `markdown`；业务依赖仅 `editor`、`file-core`。状态：2026-11-03用户确认开始M3，T301实现中，G3待验。拥有 F-MD-001–011，全部首次在M3验收；完整索引见 [矩阵](../FEATURE-MATRIX.md)。

实施决策（T301）：锁定Marked18.1.3（MIT）和DOMPurify3.4.17（Apache-2.0或MPL-2.0），已核对包元数据、首次禁脚本安装。150ms合并后才从CodeMirror复制快照到专用Worker，2秒超时终止Worker；结果绑定documentId/bufferVersion/requestId。宿主执行显式标签白名单清洗后，放入无任何sandbox权限的srcdoc iframe，内层CSP禁脚本/联网/表单/插件，绝不授予same-origin、Tauri IPC或顶层导航。T301中的URL和图片只显示安全占位，真实授权资源与用户点击动作留T303。三模式在应用组合层连接editor，editor不反向导入markdown。

原生边界补正：真实Release证实Wry0.57.1在Windows忽略`for_main_frame_only`。工程复用本机已锁定的Wry源码至`src-tauri/vendor/wry`，仅在Windows对标记为main-frame-only的初始化脚本添加顶层窗口判断，显式all-frame脚本保持原行为。许可证与补丁说明一并保留；不升级工具链、不修改共享Cargo缓存。真实测试必须继续断言子frame无Tauri桥，不能仅靠HTML清洗或Web mock证明此边界。

## Objective 与技术边界

让用户在一个正文模型上进行源码编辑、舒适阅读和双视图预览，并离线导出可分享的HTML/PDF。Markdown是editor扩展，editor不反向依赖本模块；使用editor快照/版本化applyEdits和file-core资源/导出写入。采用本地GFM解析器、代码高亮器、HTML sanitizer和隔离渲染；具体库实施前验证许可证/大小/安全维护，禁止依赖CDN。

建议结构 `src/features/markdown/{parser,render,outline,export}/`、`src-tauri/src/services/markdown_export/`（Windows PDF/资源适配器）、`tests/unit/markdown/`、`tests/integration/markdown/`、`tests/e2e/markdown/`。当前未创建工程。命令/DTO camelCase、类型PascalCase，Rust snake_case；解析结果是数据，不能把未经清理的HTML直接dangerouslySetInnerHTML。

## Feature-ID 追踪清单

M3：F-MD-001、F-MD-002、F-MD-003、F-MD-004、F-MD-005、F-MD-006、F-MD-007、F-MD-008、F-MD-009、F-MD-010、F-MD-011。每项联合矩阵和下述交互/error-state/test strategy验收，PDF不是可选功能。

## 提供方契约与状态

跨进程线协议唯一来源是 [CONTRACTS](../CONTRACTS.md)，本文camelCase API/类型是模块内部语义示例。所有跨边界路径使用grant/FileRef而非未经授权的裸路径。域错误名作为`details.reason`：STALE_RENDER→CONFLICT、BLOCKED_RESOURCE→OUT_OF_SCOPE、EXPORT_FAILED→INTERNAL（或DISK_FULL等具体规范code）、PDF_BACKEND_UNAVAILABLE→UNSUPPORTED。

```ts
type MarkdownMode = 'source' | 'read' | 'split';
type RenderRequest = {
  requestId: string; documentId: string; bufferVersion: number;
  source: string; resourceScopeId: string;
};
type RenderResult = {
  requestId: string; bufferVersion: number; sanitizedHtml: string;
  headings: { level: number; text: string; anchor: string; from: number }[];
  sourceMap: { from: number; to: number; nodeId: string }[];
  blockedResources: { url: string; reason: string }[];
};
type ExportOptions = {
  format: 'html' | 'pdf'; documentId: string; expectedBufferVersion: number;
  targetPath: string; paper: 'a4' | 'letter'; landscape: boolean;
  marginsMm: { top: number; right: number; bottom: number; left: number };
};
```

注册 `setMode(documentId,mode)`、`render(RenderRequest)`、`resolveResource(scopeId,url)`、`exportDocument(ExportOptions)`、`cancel(requestId)`；统一Result/AppError并附 `STALE_RENDER`、`BLOCKED_RESOURCE`、`EXPORT_FAILED`、`PDF_BACKEND_UNAVAILABLE`。输出错误不含正文。模式属于视图状态（同文档可一组源码一组阅读），正文共享；渲染/导出必须冻结具体bufferVersion，异步旧结果丢弃。导出读取dirty当前缓冲，不要求先保存，但相对资源路径不明的无标题文档须先选资源基目录或导出缺图占位，不能猜cwd。

## 三模式与结构（F-MD-001/002/003/005/008/011）

默认source；read隐藏源码但保留原文和编辑位置；split展示源码/预览且可拖分隔线，窗口窄时明确切换单视图而非重复嵌套双分栏。切换模式不格式化、不保存。Markdown标准遵循CommonMark基础+GFM表格/任务列表/删除线/自动链接；明确测试标题、嵌套列表、引用、转义、代码块和表格边界。不默认支持脚本、Mermaid执行、数学远程渲染或任意插件。

围栏代码只进行本地语法高亮，未知语言纯文本；代码中的HTML必须转义。代码复制由用户动作写入剪贴板，给可读状态，不触发执行。

目录大纲H1–H6按文档顺序，重复标题anchor使用规范化slug加递增后缀，空标题有稳定回退；同一bufferVersion的目录/源码/渲染共享映射。点击大纲定位预览及源码；可折叠层级/筛选标题，但不更改正文。源区间变化后生成新映射，不沿用旧绝对offset。

split同步滚动可关闭，默认按首个可见sourceMap块定位，图片加载后重新计算布局；避免两端scroll事件反馈循环。去抖渲染默认150ms，worker/requestId可取消；新版本优先，旧版本不能闪回。>2MiB或长行降级停止实时渲染，提供明确提示和可取消的一次性预览（仍遵守大小/资源预算）；≥20MiB不完整渲染，限量预览不能导出假完整文档。单次渲染CPU预算2秒/生成节点上限50,000，超限提示缩小内容，禁止主线程长锁。

read/split任务勾选通过sourceMap映射原始`[ ]`/`[x]`标记，提交expectedBufferVersion的单次事务；成功后dirty且一次undo。重复同文任务必须按位置区分。只读、过期映射、无法定位时checkbox禁用或重新渲染，不做文本全局替换猜位置。

## 资源、链接与安全HTML（F-MD-004/006/007）

相对图片基于命名文档所在目录，不以进程cwd或任意工作区根猜路径。支持中文、空格、百分号编码、`#fragment`；URL只解码一次并拒绝NUL/路径穿越，canonical目标必须在授权的文档目录或已授权工作区根。越界图片/本地链接给“授权目录/取消”，不可悄悄加载。无标题文档没有基目录时显示占位和选择入口。

本地资源不暴露任意`file://`读取；由受限asset handler校验scope/token与MIME返回，不能携带Tauri命令权限。图片PNG/JPG/GIF/WebP/SVG遵循editor图片20MiB/40MP安全上限；SVG独立清理且隔离。远程http/https图片默认阻止并显示原因，本v1不自动抓取/缓存；用户可在浏览器显式查看原URL，正文预览/导出仍不进行网络请求。data URL只接受受限图片MIME、尺寸和总预算，不接受HTML/SVG脚本载荷。

内部锚点定位当前渲染，本地Markdown链接由应用编排打开；其他本地文件经用户动作调用既有打开流程。外部http/https/mailto仅用户点击后协议白名单交系统浏览器；`javascript:`、`vbscript:`、shell/自定义协议、网络UNC自动跳转拒绝。相对链接出授权根也需授权。预览不能模拟链接点击自动外开。

raw HTML默认禁用并按纯文本转义；用户可在设置显式启用清洗后的受限HTML，启用后允许受限结构标签（段落、标题、表格、details/summary等），属性限class、title、受限href/src、aria与尺寸；清理script、style任意外链、事件属性、iframe/object/embed、form、base/meta refresh、foreignObject、危险CSS URL。解析后sanitize，URL规范化后二次校验；CSP禁脚本/联网/插件，隔离iframe没有same-origin和top-navigation权限。内容展示层不持有IPC桥；清理失败显示纯文本而不是“尽量渲染”。主题CSS由应用控制，不能让文档读取本地样式资源。

## HTML/PDF导出（F-MD-009/010）

导出使用同一清理后的AST/资源授权，选择目标路径与覆盖确认；导出dirty缓冲时显示“当前未保存内容”及version。导出期间源变更不混入既有作业，可选择取消重做；最终说明导出的是哪个快照。写目标通过file-core安全临时写/替换，取消/失败不保留伪完整目标，已存在目标不损坏。

HTML：生成独立UTF8 HTML，内置受控CSS、目录anchor、可嵌入本地允许资源，不输出任何Tauri桥和本机绝对路径。单资源≤20MiB，总嵌入≤50MiB；缺失/越权/超限资源列出并允许“带占位继续/取消”，不能导出后静默失图。离线打开不请求网络；含远程图仍占位，外部链接保留安全URL供用户点击。

PDF：必须实现真正本地生成PDF到所选路径，不能仅调用浏览器打印对话框并要求用户自行选打印机。Windows优先验证WebView2 PrintToPdf/PrintToPdfStream的Tauri可调用适配器；清理内容在无IPC、无网络的专用渲染面板加载，等本地图像/字体就绪后输出。接口/运行时不支持则返回PDF_BACKEND_UNAVAILABLE和离线修复指引，不能假报成功；M3/M5需把能力验证完成，否则v1未完成。

提供A4/Letter、横纵、毫米页边距（默认15mm，0–50合法），主题默认纸面浅色、中文本地字体回退、链接可点击；避免标题孤行、代码块/表格横向裁切，超宽内容缩放或换行，分页允许跨页长表/代码块但须可读。成功校验PDF头/非零页数与写入结果，覆盖目标前仍核对revision；不能保证跨机字体像素完全一致。

## Acceptance、error-state 与测试策略

- 001–003：同文档切三模式，GFM固定夹具、嵌套结构/未知代码语言，正文哈希不变；离线高亮可用。
- 004/006/007：中文空格相对图、缺图、无标题、`../`越界、symlink越权、恶意协议/双重编码/data URL/SVG/HTML事件；请求网络与IPC次数应为零。
- 005/008/011：重复标题/重复任务、滚动图片重排、渲染旧结果竞态、只读勾选、源变更后点击任务；准确位置修改且一次undo，旧映射拒绝。
- 009：独立HTML离线重新打开、CSS/图片内嵌、绝对路径不泄漏、缺图继续/取消、目标覆盖/磁盘满。
- 010：Windows10/11 WebView2离线生成真实PDF，中文字体/长表格/代码块/分页/方向/边距检查；后端缺失、取消、锁定目标均准确报错，不生成零页伪文件。

单元验证GFM AST/slug/sourceMap/sanitizer/URL规范化；集成验证真实隔离内容+CSP+asset scope和PDF后端；e2e验证三模式/任务撤销/同步滚动/选择路径导出。安全测试断言无网络、无IPC、无任意文件读取，不只比HTML字符串。导出用固定文档进行语义文本提取+页数/页面人工检查，避免字体差异造成脆弱像素测试。

`pnpm test:e2e`仅覆盖Web/mock bridge；真实离线HTML/PDF写出和WebView2安全通过待建立的 `pnpm test:desktop -- markdown` 与Rust适配器测试，不以mock/打印框代替。命令约定（未搭建、未执行）：`pnpm test:unit -- markdown`、`pnpm test:integration -- markdown`、`pnpm test:e2e -- markdown`、`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`；Rust适配器 `cargo test --manifest-path src-tauri/Cargo.toml markdown_export`，通用 `cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。

## Boundaries 与未决风险

Always：清理和隔离双重防护、资源scope检查、版本化映射、离线真实导出。Ask first（后续实施变更）：允许远程资源、扩大HTML allowlist、改变PDF后端/资源授权或加入执行型图表。Never：直接渲染未清理HTML、给内容IPC权限、自动网络图片、将打印对话框当PDF完成。

待验证：Tauri2与WebView2 PDF API接入、最低runtime版本、中文字体/分页质量、sanitizer对SVG/CSS/编码绕过、源映射稳定性。PDF后端是M3前置技术验证，不是可延期的可选能力。
