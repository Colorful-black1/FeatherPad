# 轻羽 FeatherPad — agent 工作规则

这是专门的编辑器项目，最终根目录 `E:\Codeing\ai-workspace\featherpad`。产品名固定为**轻羽 / FeatherPad**，CLI为`featherpad`。不要访问或修改父工作区其他项目，不要把 DSH 自身 checkout 当成本项目。

## 先读什么

1. [README](README.md)：项目状态和入口。
2. [PROGRESS](tasks/PROGRESS.md)：已经做到哪里，真实验证证据。
3. [任务清单](tasks/todo.md)：第一个依赖满足的未完成任务；[计划](tasks/plan.md) 给阶段关卡。
4. 按feature ID只读 [功能矩阵](docs/FEATURE-MATRIX.md)、[能力地图](CAPABILITY-MAP.md) 和相关模块SPEC；跨进程先读 [CONTRACTS](docs/CONTRACTS.md)。UI参考 [UI-DESIGN](design/UI-DESIGN.md)。

当前**M0/G0–M3/G3已通过，M4/G4已通过（2026-11-04）；M5/T501等待用户确认**。M1的T101–T115、M2的T201–T216和M3的T301–T311均已实现并完成各自统一验收，最终Release、真实/mock边界和证据见[M1验收](docs/acceptance/M1.md)、[M2验收](docs/acceptance/M2.md)、[M3验收](docs/acceptance/M3.md)与[M4验收](docs/acceptance/M4.md)。M4的T401–T405也已完成；提交后停止，不自动进入M5。按用户要求，每完成一个M阶段必须停止并等待确认，未确认前不得开始下一阶段。HTML原型不是CodeMirror/Tauri应用，演示保存不写源文件；完整v1必须推进M0–M5全部86项必需功能。

## 固定技术与环境

Tauri2 / Rust / React19 / TypeScript5 / Vite7 / CodeMirror6 / CSS variables；精确补丁版本由M0核对并锁定。已有 Node22.13.0、pnpm10.32.1、Rust1.99.1、MSVC、Windows SDK、WebView2，先复查 [ENVIRONMENT](docs/ENVIRONMENT.md)，再使用：

```powershell
powershell.exe -NoProfile -File .\scripts\Probe-Environment.ps1
. .\scripts\Enter-Dev.ps1
```

**先查`E:\Codeing`和默认目录，优先复用；确实缺失时所有新工具/SDK/浏览器/安装包/缓存只能在`E:\Codeing`下，默认`E:\Codeing\featherpad-dev`。** 不修改系统PATH、不切全局nvm、不自动升级工具链。不能遵守指定目录的安装要停止并报告，不能静默例外。

M0已建立的命令（bench:app仍待性能阶段创建）：`pnpm dev` / `pnpm dev:web` / `pnpm typecheck` / `pnpm lint` / `pnpm test:unit` / `pnpm test:integration` / `pnpm test:e2e` / `pnpm test:desktop` / `pnpm build` / `pnpm bench:app`；Rust：`cargo fmt --manifest-path src-tauri/Cargo.toml --check`，`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`，`cargo test --manifest-path src-tauri/Cargo.toml`。

## 每轮怎么做

读当前状态 → 选一个依赖就绪的小任务 → 读将改文件/已有同类实现 → 实现真实纵向切片 → 定向检查并修失败 → 简记证据 → 继续下一任务。变更通常≤5个生产文件，过大先拆；不要为了机械数量把行为测试拆碎。上下文恢复从PROGRESS继续，不重建已完成工程。

### 以M为验收单元（2026-11-03用户修订）

**一个M是大任务，M内各T是它的实现步骤；验收只在M结束时做一次。**

- T完成时只做最小自检：受影响模块能编译/通过类型检查，加至少一个能证明新行为确实工作的定向用例。失败必须修完再继续，不能带红测试往下堆。
- **不再每个T运行**全量`typecheck/lint/test/test:e2e`、Release构建、`test:desktop:all`、大文件/满盘/强杀/性能专项，也不逐任务写验收文档和截图。
- 例外：保存、删除/回收站、恢复/热退出、编码与换行转换、跨文件替换、预览与HTML安全清洗，实现完成时额外跑**一条**真实路径冒烟（真实文件保存/删除/恢复并核对字节，5–10分钟）。不做故障矩阵，完整故障仍留M验收。
- M内全部T为`[x]`后，按 [todo](tasks/todo.md) 的“M统一验收清单”一次性执行：全量静态与单元、Web回归、Release构建与`test:desktop:all`、阶段专项、矩阵证据汇总、`validate-docs`。通过才把关卡打勾并进入下一阶段。
- 同一代码/构建已有有效证据直接复用，仅相关改动、失败或未解决问题触发扩大复测。
- `[x]`只表示实现完成，不代表功能已验收；功能验收只在M关卡通过后记录。不删除测试，不降低断言/性能门槛，不把待验标通过；现有测试产物仍只列清理清单。

不要因为阶段边界、同等组件选择或普通可逆修复反复请求确认。每完成一个M阶段必须停止并等待用户确认，确认后再推进下一阶段。数据模型、模块接口、安全边界变更先记录决策并同步规格；用户明确范围内的合理实现无需逐项审批。存在真正缺失授权/外部发布/无法满足安装目录限制时说明具体原因。

## 必须遵守

- 单一事实源：矩阵ID与SPEC；变更范围同步计划和验收。用户新要求优先于旧方案。
- TS strict、命名导出、2空格；Rust cargo fmt；不用any隐藏契约问题。CodeMirror管理高频编辑，React不持有全文逐键状态，每键不上Rust。
- 同一文件同一DocumentId，内存version与磁盘revision分离；保存按文档串行，Ack旧版不清理新版dirty。
- 编码/换行不静默损坏，外部冲突不自动覆盖，回收站失败不永久删除；限量预览不能保存。
- 未保存内容要真实恢复快照；热退出等落盘，失败可见。强杀/断电最近输入不做零丢失承诺。
- Markdown/HTML/SVG不执行脚本，不自动访问远程资源或任意本地路径；Tauri最小capability，IPC校验grant和输入。
- 依赖首次禁脚本，审查后精确allowlist，提交唯一pnpm lock与Cargo.lock。禁止自动强制audit修复。
- 测试仅使用受控fixtures；删除/移动前验证绝对目标。日志不记录用户正文与敏感路径。
- UI保持内容优先、暖灰苔绿、紧凑可读；全键盘和200%缩放可用。原型只是参考，生产不复制textarea假编辑器。

## 禁止

- 未运行就写通过；把Web mock、截图或打印框当原生读写/PDF完成。
- 把MVP称完整成品，删除晚期需求，调高性能阈值或删失败测试凑完成。
- 创建空脚本、写死成功数据、生产保留设计演示提示而标功能完成。
- 静默联网、执行用户文件内容、加入终端/LSP/插件市场/云服务/AI聊天扩范围。
- 自动公开发布、上传、发送消息、购买证书；用户要求的是本地可用产品。

## 证据与交接

T完成时在 [PROGRESS](tasks/PROGRESS.md) 简记改动、命令/exit code、结果与留给M的待验点，并更新 [todo](tasks/todo.md) 该T状态。M统一验收通过时一次性写 `docs/acceptance/<M>.md`：功能ID、构建标识与SHA256、Windows/WebView2版本、真实与mock范围、故障与性能、已知问题，并更新关卡状态与 [功能矩阵](docs/FEATURE-MATRIX.md) 对应ID。`[x]`只代表实现完成，验收证据只在M关卡通过后记录。验收策略见 [QUALITY-GATES](docs/QUALITY-GATES.md)。阻塞要写具体缺口与已尝试方法，不以“比较难”作为终止理由。
