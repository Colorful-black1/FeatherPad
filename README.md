# 轻羽 FeatherPad

**快开文件，专心编辑。** 一个免费、离线、面向常用文档、配置和代码文本的轻量桌面编辑器。

本目录是轻羽桌面编辑器的独立工程。**M0/G0–M4/G4已全部通过（2026-11-04），86项必需功能已交付。** M1交付真实Tauri Release、原生打开/保存/另存/副本/全部保存、外部冲突、回收站、恢复/热退出、文件内搜索替换、最近记录、设置与主题、只读文本试开、键盘导航和无障碍能力。M2补齐完整编码与逐行换行、自动保存、磁盘冲突diff、多根/收藏/工作区文件、安全遍历与监听、拖放移动、标签/双分栏、多光标/列选择/折叠/导航、全文搜索、跨文件替换、全局唤起与隐私清理。M3补齐Markdown三模式、安全资源与链接、受限HTML、离线HTML/真实多页PDF导出、格式化与文本工具、只读diff、图片和HTML安全预览，并有Web Playwright、真实桌面Playwright和实际Windows文件系统证据。M4补齐CLI/多窗口、安装/便携与选择加入的系统集成。最新范围、边界和证据见 [M4验收](docs/acceptance/M4.md) 与 [PROGRESS](tasks/PROGRESS.md)。

## 立即开始

- 想看界面：双击 [交互原型](design/prototype.html)，无需安装依赖、无需服务器；CSS需与HTML同目录。可试目录/标签、编辑、搜索、命令面板、设置、主题。演示保存不写真实源文件。
- 想理解产品：先读 [产品方案](docs/PRODUCT.md) 和 [86项完整功能矩阵](docs/FEATURE-MATRIX.md)。
- 想继续开发：单独打开 `E:\Codeing\ai-workspace\featherpad`，阅读 [agent规则](AGENTS.md) 与 [PROGRESS](tasks/PROGRESS.md)，从 [任务清单](tasks/todo.md) 的进行中任务恢复，不重建工程。
- 想了解未保存内容保护：阅读 [恢复指南](docs/RECOVERY.md)。
- 想核查环境：执行 [环境探针](scripts/Probe-Environment.ps1)，再点源 [开发会话入口](scripts/Enter-Dev.ps1)。这些脚本不安装工具、不修改系统PATH。

```powershell
Set-Location 'E:\Codeing\ai-workspace\featherpad'
powershell.exe -NoProfile -File .\scripts\Probe-Environment.ps1
. .\scripts\Enter-Dev.ps1
```

## 在 Git Bash 中启动桌面程序

以下命令在 **Windows 的 Git Bash** 中执行，使用 Bash 的 `cd` 和路径写法。项目依赖 Windows 的 MSVC、Windows SDK 和 WebView2；这里不是在 Linux / WSL 中交叉编译 Windows EXE。现有工具与缓存由 `Enter-Dev.ps1` 在子进程中初始化，不修改系统 PATH，也不切换全局 Node。

```bash
cd /e/Codeing/ai-workspace/featherpad

# 环境检查：已有工具缺失时先排查，不自动安装或升级
powershell.exe -NoProfile -File ./scripts/Probe-Environment.ps1

# 启动真正的 Tauri 桌面窗口，保持此终端打开
powershell.exe -NoProfile -Command '. ./scripts/Enter-Dev.ps1; pnpm dev; exit $LASTEXITCODE'
```

本机已安装项目依赖，可直接启动。首次启动或调试缓存变化时，需要等待 Rust 编译完成；看到 `Running ...featherpad.exe` 后会打开桌面窗口。Vite 地址为 `http://127.0.0.1:1420/`，打开网页只是在看 Web 界面，原生文件能力请在桌面窗口中使用。

停止时先保存需要保留的内容并关闭桌面窗口，再在启动它的 Git Bash 中按 **Ctrl+C** 结束开发服务；若出现终止批处理的确认，输入 `Y` 并回车。重新启动时再次执行上述启动命令即可。

如果以后重新拉取源码且没有 `node_modules`，先执行一次依赖安装；当前本机无需重复安装：

```bash
powershell.exe -NoProfile -Command '. ./scripts/Enter-Dev.ps1; pnpm install --frozen-lockfile; exit $LASTEXITCODE'
```

这些命令中的 PowerShell 代码必须保留外层**单引号**，避免 Git Bash 提前展开 `$LASTEXITCODE`。每次调用都在同一个 PowerShell 子进程里初始化环境并执行 pnpm；单独运行初始化脚本不会改变 Git Bash 的环境。

## 在 Git Bash 中打包安装器（给其他电脑使用）

在 Windows 的 Git Bash 中执行以下命令，生成可复制给其他电脑安装的 EXE 安装器。本机构建需要已有的 Node、pnpm、Rust、MSVC 和 Windows SDK；环境初始化沿用项目现有脚本，工具与缓存目录约束见 [ENVIRONMENT](docs/ENVIRONMENT.md)。

```bash
cd /e/Codeing/ai-workspace/featherpad
powershell.exe -NoProfile -Command '. ./scripts/Enter-Dev.ps1; pnpm tauri build --bundles nsis; exit $LASTEXITCODE'

# 构建成功后查看安装器
ls -lh src-tauri/target/release/bundle/nsis/*-setup.exe
```

命令会自动构建前端、Rust Release 程序和 NSIS 安装器。完成后，将 `src-tauri/target/release/bundle/nsis/` 下以 `-setup.exe` 结尾的文件复制给其他 Windows x64 电脑，双击安装，再从开始菜单启动轻羽。目标电脑无需安装 Node、Rust 或项目源码。

目标电脑需要已有 **Microsoft Edge WebView2 Runtime**；当前安装器不内嵌或自动下载它，缺失时程序会显示安装指引。安装器为当前用户安装，尚未签名。Windows 10 及最低 Runtime 版本的目标机兼容性仍未实测，现有验证环境为 Windows 11。NSIS 工具使用项目本地缓存（`src-tauri/target/.tauri/`）。

## 产品会具备什么

打开文件夹和多根工作区；文件树、最近与收藏；多标签、预览/固定、双分栏；常见代码文本高亮、多光标、列选择、注释/折叠/行操作；快速打开、命令面板、可配置快捷键；文件内/全文搜索和有预览/恢复记录的跨文件替换；Markdown源码/阅读/分屏、目录、相对图片、HTML/PDF导出；格式化、文本转换、两文件diff、图片查看；多编码与换行、外部冲突、可靠保存、草稿与崩溃恢复；亮暗主题、安装/便携、CLI与显式选择加入的Windows集成。

产品范围为功能矩阵的86项必需功能（M0–M4），M1只是MVP。小地图明确可选。产品不需要项目索引、账号、网络或开发语言服务；不承担运行调试、数据库、终端、插件市场、云同步或AI聊天。

当前版本未提供可选小地图，该项不可用，默认不启用。

## 交付索引

| 内容 | 入口 |
|---|---|
| 产品定位、默认值、可靠性、完整范围 | [PRODUCT](docs/PRODUCT.md) |
| 86项功能ID、阶段与可验证验收 | [FEATURE-MATRIX](docs/FEATURE-MATRIX.md) |
| 模块边界与依赖 | [CAPABILITY-MAP](CAPABILITY-MAP.md) |
| 文件核心 / 工作区 / 编辑 / Markdown / 搜索工具 / 桌面规格 | [file-core](docs/specs/SPEC-file-core.md)、[workspace](docs/specs/SPEC-workspace.md)、[editor](docs/specs/SPEC-editor.md)、[markdown](docs/specs/SPEC-markdown.md)、[search-tools](docs/specs/SPEC-search-tools.md)、[desktop](docs/specs/SPEC-desktop.md) |
| UI布局、组件、状态、交互与快捷键 | [UI-DESIGN](design/UI-DESIGN.md)、[原型说明](design/README.md)、[tokens](design/tokens.css) |
| 技术栈、架构、目录、性能预算 | [TECH-STACK](docs/TECH-STACK.md) |
| 已核查的本机开发环境与E盘安装约束 | [ENVIRONMENT](docs/ENVIRONMENT.md)、[结构化快照](docs/environment.snapshot.json) |
| typed IPC、保存/取消/错误语义 | [CONTRACTS](docs/CONTRACTS.md) |
| 预览隔离、文件可靠性、本地隐私 | [SECURITY-AND-RELIABILITY](docs/SECURITY-AND-RELIABILITY.md) |
| 分阶段实施、任务与进度 | [plan](tasks/plan.md)、[todo](tasks/todo.md)、[PROGRESS](tasks/PROGRESS.md) |
| 质量、性能与故障验收 | [QUALITY-GATES](docs/QUALITY-GATES.md) |
| M0/M1/M2/M3/M4阶段验收 | [M0](docs/acceptance/M0.md)、[M1](docs/acceptance/M1.md)、[M2](docs/acceptance/M2.md)、[M3](docs/acceptance/M3.md)、[M4](docs/acceptance/M4.md) |
| Agent开发规则与恢复入口 | [AGENTS](AGENTS.md) |
| 本次交付实际检查结果 | [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) |

## 五阶段路线

| 阶段 | 结束时能得到什么 |
|---|---|
| M0 环境与骨架 | 复用本机工具，真正Tauri开发/Release启动与测试通路 |
| M1 可用MVP | 单根树、基础编辑/搜索、真实保存、外部变更、恢复与设置 |
| M2 效率完善 | 多根、分栏、多光标、完整编码换行、全文搜索与安全批量替换 |
| M3 阅读与工具 | Markdown三模式、真实HTML/PDF导出、格式化、diff和图片 |
| M4 桌面交付 | CLI、多窗口、安装/便携、系统关联选择加入、最终安装包与便携包 |

## 环境约束与当前事实

本机复用 Node22.13.0、pnpm10.32.1、Rust1.99.1、VS2022 C++工具、Windows SDK和WebView2；没有升级全局工具链。项目依赖已在E盘安装，原生编译和运行的实际证据按阶段记录。
项目依赖已精确安装并双锁，原生Rust/Tauri、Release WebView2离线重载和IPC越界拒绝已实际验证，见 [M0验收](docs/acceptance/M0.md)。保存/新目标另存/副本/全部保存及标签关闭保护见 [M1验收](docs/acceptance/M1.md)；编码、工作区、编辑效率、搜索替换与可靠性补齐见 [M2验收](docs/acceptance/M2.md)；Markdown、格式化、diff、安全预览和导出见 [M3验收](docs/acceptance/M3.md)。开发使用上述会话入口后运行`pnpm dev`；日常每个T只做最小自检，M收尾按 [M统一验收清单](tasks/todo.md) 执行一次全量回归。G3最终真实桌面回归为19 passed；M0–M4阶段验收已全部通过。

优先复用 `E:\Codeing` 和默认目录的已有环境；确实缺失时，**所有新增开发工具/SDK/浏览器/安装包/缓存只能放在 `E:\Codeing` 下**，默认 `E:\Codeing\featherpad-dev`。全局Node不切换，系统PATH不修改。

## 事实源与变更

用户明确要求优先，其次是产品/功能矩阵/提供方SPEC，再是接口、技术、UI与任务计划；发生冲突应同步修正文档，不能让agent随意挑一份。精确业务阈值以PRODUCT为准，跨进程字段名以CONTRACTS为准，UI的演示内容不能改变范围或默认行为。未记录通过证据的产品能力均待实现/待验证；执行证据统一写PROGRESS。
