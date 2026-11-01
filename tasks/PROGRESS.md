# 当前进度与交接

## 目前状态

- 产品名称：**轻羽 FeatherPad**。
- 当前交付：完整产品方案、86项功能矩阵、模块规格、UI规范与离线交互原型、技术/本机环境文档、M0–M5实现计划、57个开发任务、agent执行入口。
- 产品代码：**M0进行中**。T000已验证原生Rust/MSVC编译运行；Tauri开发窗口/WebView2壳层已实测，G0仍待IPC、故障正负例和Release。
- 下一项：**T003.d 系统选择器原生正例验收**（a–c与Web层已验证）；M1通过后继续M2–M5。
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

## 当前恢复点（2026-11-01，Asia/Shanghai）

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
