# 轻羽 FeatherPad

**快开文件，专心编辑。** 一个免费、离线、面向常用文档、配置和代码文本的轻量桌面编辑器。

本目录是轻羽桌面编辑器的独立工程。**M0/G0及M1/T101已通过：真实系统选择器多文件打开、新建、CodeMirror独立缓冲与撤销状态、原生身份/授权拒绝及Release通路已实测；下一项安全保存。保存/恢复及M2–M5尚未完成，G1未通过。** 不把原型、mock或早期Release视为成品。最新状态和证据见 [PROGRESS](tasks/PROGRESS.md)。

## 立即开始

- 想看界面：双击 [交互原型](design/prototype.html)，无需安装依赖、无需服务器；CSS需与HTML同目录。可试目录/标签、编辑、搜索、命令面板、设置、主题。演示保存不写真实源文件。
- 想理解产品：先读 [产品方案](docs/PRODUCT.md) 和 [86项完整功能矩阵](docs/FEATURE-MATRIX.md)。
- 想继续开发：单独打开 `E:\Codeing\ai-workspace\featherpad`，阅读 [agent规则](AGENTS.md) 与 [PROGRESS](tasks/PROGRESS.md)，从 [任务清单](tasks/todo.md) 的进行中任务恢复，不重建工程。
- 想核查环境：执行 [环境探针](scripts/Probe-Environment.ps1)，再点源 [开发会话入口](scripts/Enter-Dev.ps1)。这些脚本不安装工具、不修改系统PATH。

```powershell
Set-Location 'E:\Codeing\ai-workspace\featherpad'
powershell.exe -NoProfile -File .\scripts\Probe-Environment.ps1
. .\scripts\Enter-Dev.ps1
```

## 产品会具备什么

打开文件夹和多根工作区；文件树、最近与收藏；多标签、预览/固定、双分栏；常见代码文本高亮、多光标、列选择、注释/折叠/行操作；快速打开、命令面板、可配置快捷键；文件内/全文搜索和有预览/恢复记录的跨文件替换；Markdown源码/阅读/分屏、目录、相对图片、HTML/PDF导出；格式化、文本转换、两文件diff、图片查看；多编码与换行、外部冲突、可靠保存、草稿与崩溃恢复；亮暗主题、安装/便携、CLI与显式选择加入的Windows集成。

完整v1为M0–M5全部必需功能，M1只是MVP。小地图明确可选。产品不需要项目索引、账号、网络或开发语言服务；不承担运行调试、数据库、终端、插件市场、云同步或AI聊天。

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
| Agent首次开发、loop、恢复提示 | [AGENT-START](docs/AGENT-START.md)、[AGENTS](AGENTS.md) |
| 本次交付实际检查结果 | [DELIVERY-CHECK](docs/DELIVERY-CHECK.md) |

## 六阶段路线

| 阶段 | 结束时能得到什么 |
|---|---|
| M0 环境与骨架 | 复用本机工具，真正Tauri开发/Release启动与测试通路 |
| M1 可用MVP | 单根树、基础编辑/搜索、真实保存、外部变更、恢复与设置 |
| M2 效率完善 | 多根、分栏、多光标、完整编码换行、全文搜索与安全批量替换 |
| M3 阅读与工具 | Markdown三模式、真实HTML/PDF导出、格式化、diff和图片 |
| M4 桌面交付 | CLI、多窗口、安装/便携、系统关联选择加入 |
| M5 完整v1 | 86项证据、故障与安全回归、Release性能、可运行包与指南 |

## 环境约束与当前事实

本机复用 Node22.13.0、pnpm10.32.1、Rust1.99.1、VS2022 C++工具、Windows SDK和WebView2；没有升级全局工具链。项目依赖已在E盘安装，原生编译和运行的实际证据按阶段记录。
M0实施更新：项目依赖已精确安装并双锁，原生Rust与Tauri编译、Release WebView2离线重载、IPC越界拒绝已实际验证；详细范围见 [M0验收](docs/acceptance/M0.md)。开发使用上述会话入口后运行`pnpm dev`，质量检查使用`powershell.exe -NoProfile -File scripts/check.ps1 -Desktop`。当前早期Release不提供保存；完整v1仍需全部后续阶段。

优先复用 `E:\Codeing` 和默认目录的已有环境；确实缺失时，**所有新增开发工具/SDK/浏览器/安装包/缓存只能放在 `E:\Codeing` 下**，默认 `E:\Codeing\featherpad-dev`。全局Node不切换，系统PATH不修改。

## 事实源与变更

用户明确要求优先，其次是产品/功能矩阵/提供方SPEC，再是接口、技术、UI与任务计划；发生冲突应同步修正文档，不能让agent随意挑一份。精确业务阈值以PRODUCT为准，跨进程字段名以CONTRACTS为准，UI的演示内容不能改变范围或默认行为。所有产品能力当前均待实现/待验证；未来执行证据统一写PROGRESS。
