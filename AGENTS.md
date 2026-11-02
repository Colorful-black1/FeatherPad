# 轻羽 FeatherPad — agent 工作规则

这是专门的编辑器项目，最终根目录 `E:\Codeing\ai-workspace\featherpad`。产品名固定为**轻羽 / FeatherPad**，CLI为`featherpad`。不要访问或修改父工作区其他项目，不要把 DSH 自身 checkout 当成本项目。

## 先读什么

1. [README](README.md)：项目状态和入口。
2. [PROGRESS](tasks/PROGRESS.md)：已经做到哪里，真实验证证据。
3. [任务清单](tasks/todo.md)：第一个依赖满足的未完成任务；[计划](tasks/plan.md) 给阶段关卡。
4. 按feature ID只读 [功能矩阵](docs/FEATURE-MATRIX.md)、[能力地图](CAPABILITY-MAP.md) 和相关模块SPEC；跨进程先读 [CONTRACTS](docs/CONTRACTS.md)。UI参考 [UI-DESIGN](design/UI-DESIGN.md)。

当前**M0/G0及M1/T101–T110已通过**。真实Release已验收保存/覆盖/副本/批次/硬链接/进程终止、真实小容量满盘的安全失败与恢复记录、完整<20MiB降级编辑、大文件限量读取、单根懒加载目录树、CodeMirror事务编辑/缩进/括号/语言剪贴板/Windows微软拼音候选窗，以及文件内搜索替换、选区范围、只读保护、捕获组和单次undo。满盘通过受控WSL2 `tmpfs` 实现；WSL 9P把`ENOSPC`映射为Windows错误31，NTFS错误112到`DISK_FULL`映射另有Rust单测，不把它误写成原生NTFS全卷演练。T105新建/重命名/仅回收站删除已验收；T107单预览/固定偏好、关闭保存/放弃/取消、对应恢复副本清理及未知释放结果保副本另存均通过相关真实Release，固定偏好重载不代表启动会话恢复。T109统一命令/快捷键重映射及受授权候选快速打开已通过相关真实Release；T110单组恢复/热退出已通过相关真实Release，下一项T111外部变化。G1及以后尚未完成。HTML原型不是CodeMirror/Tauri应用，演示保存不写源文件。M1不是最终完成，用户要求的完整v1必须推进M0–M5全部86项必需功能。

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

### 分层验收（2026-11-02用户修订）

- 小切片只运行受影响模块的定向检查和行为测试，不默认执行全套检查、Release构建或综合桌面验收。
- 普通T任务完成后验证完整流程；相邻普通任务允许合并一次Release验收，未验部分明确标待验。
- 保存、删除、恢复、编码转换、跨文件替换等高风险T任务完成时，必须执行相关真实Release验收。
- 原生综合测试按能力选择，日常只跑受影响场景；M阶段统一执行整体回归。
- 同一代码/构建已有有效证据直接复用，仅相关改动、失败或未解决问题触发扩大复测。
- 大文件、100k目录、满盘、强杀、性能属于专项检查，不随普通界面修改重复执行。
- 按完整功能提交；小切片简记、T任务汇总、M阶段整体报告，避免反复更新大量文档。
- 不删除测试，不降低断言/性能门槛，不把待验标通过；保留现有测试产物，仍只列清理清单。

不要因为阶段边界、同等组件选择或普通可逆修复反复请求确认。用户若要求持续loop，可在关卡通过后直接推进下一阶段。数据模型、模块接口、安全边界变更先记录决策并同步规格；用户明确范围内的合理实现无需逐项审批。存在真正缺失授权/外部发布/无法满足安装目录限制时说明具体原因。

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

T任务汇总更新 [todo](tasks/todo.md) 状态和 [PROGRESS](tasks/PROGRESS.md)：功能ID、文件、命令/exit code、mock/原生范围、证据、已知问题、下一步；小切片只需简记，M阶段形成整体报告。验收策略见 [QUALITY-GATES](docs/QUALITY-GATES.md)。阻塞要写具体缺口与已尝试方法，不以“比较难”作为终止理由。
