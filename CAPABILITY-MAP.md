# 轻羽 FeatherPad 能力映射

> 状态：文档方案，待实现、待验证；本次文档交付已获授权，不代表用户已批准技术方案或已通过验收。完整 v1 = M0–M5 全部完成。项目名暂未做商标检索。

## 模块与业务依赖

| 稳定模块 ID | 职责与提供的能力 | 业务依赖 | 规格 |
|---|---|---|---|
| `file-core` | 文件身份、编码/换行、受保护写入、外部变更、恢复、文件操作 | 无 | [SPEC-file-core](docs/specs/SPEC-file-core.md) |
| `workspace` | 文件夹/多根工作区、资源树、最近/收藏、遍历和监听 | `file-core` | [SPEC-workspace](docs/specs/SPEC-workspace.md) |
| `editor` | CodeMirror 文本缓冲、标签/分栏、导航命令、文本 diff、图片查看 | `file-core` | [SPEC-editor](docs/specs/SPEC-editor.md) |
| `markdown` | Markdown 三模式、渲染安全、资源解析、HTML/PDF 导出 | `editor`、`file-core` | [SPEC-markdown](docs/specs/SPEC-markdown.md) |
| `search-tools` | 文件/目录搜索、跨文件替换、格式化和文本工具 | `editor`、`workspace`、`file-core` | [SPEC-search-tools](docs/specs/SPEC-search-tools.md) |
| `desktop` | 本地设置、窗口/会话、CLI、安装/便携、Windows 集成与发布 | `editor`、`workspace`、`file-core` | [SPEC-desktop](docs/specs/SPEC-desktop.md) |
| `app-shell` | 展示框架、主题布局原语、命令/菜单/面板槽位；不包含业务策略 | 无 | 由项目 UI/技术文档定义；不创建 SPEC-app-shell |

依赖列仅表示业务调用。提供方规格定义边界契约；调用方不可逆向导入调用方。`app-shell` 作为无业务依赖的展示基础设施，应用组合入口单向装配六个业务模块与 shell；展示组件通过注入的 commands/view models 使用业务能力，不在 shell 包里导入业务模块。`editor` 不导入 `markdown`；Markdown 通过扩展注册契约接入。`file-core` 不导入编辑器；脏缓冲由调用方提交快照。无循环依赖。

## 构建顺序与里程碑

| 阶段 | 可验收增量 | 关键顺序与退出条件 |
|---|---|---|
| M0 环境壳 | 文档、工程与离线安全边界、可启动壳 | 先建立 file-core/app-shell 契约与空壳；依赖与许可证清单、Windows 本地运行流程可验证。当前只写文档，不搭建环境。 |
| M1 可用 MVP | 新建/打开/保存、单根树、基础编辑、文件搜索、恢复与无障碍骨架 | file-core → workspace/editor → search-tools 基础 → desktop 会话；数据不丢失的错误路径是必需门槛。只完成 M1 不等于完整交付。 |
| M2 效率功能 | 多根、标签/分栏、导航、高级编辑、编码/换行、目录搜索与安全批量替换 | 提供方先落地契约；workspace 与 editor 增量可并行，search-tools 替换提交串接 file-core。 |
| M3 Markdown/格式工具 | 三模式 Markdown、导出、格式化、diff、图片 | editor/file-core 稳定后并行开发 markdown 与 search-tools 格式化。 |
| M4 桌面完善 | 安装/便携、多窗口、CLI、显式系统集成 | desktop 汇总前序行为；不得用系统集成绕过脏缓冲/冲突检查。 |
| M5 性能发布 | Windows 10/11 x64 验证、性能、恢复/故障演练、发布说明 | 完成全部 86 项、错误路径、安全检查与发布验收后才可称完整 v1。 |

M0–M5 的阶段 ID 不重命名；功能所属阶段详见 [功能矩阵](docs/FEATURE-MATRIX.md)。早期阶段引入的能力在 M5 仍需回归。开发次序不得解释为删除晚期能力。

## 追踪规则

- [PRODUCT](docs/PRODUCT.md) 定义完整产品范围与全局阈值；[FEATURE-MATRIX](docs/FEATURE-MATRIX.md) 是功能清单和验收索引。
- 共 86 个稳定 feature ID：FILE 18、WORK 12、EDIT 20、MD 11、SEARCH 12、DESK 13；ID 不复用。修订范围须同步矩阵、提供方规格、计划与测试映射。
- 六个规格都写 objective、输入输出契约、交互、错误、acceptance、命令约定、结构/风格/测试策略及边界；文档中的命令是后续工程约定，当前没有安装或验证。
- 任何安全或实现限制不得只藏于正文：相关限制回填所属 feature 的验收。功能不能以“轻量”为由悄悄取消。
