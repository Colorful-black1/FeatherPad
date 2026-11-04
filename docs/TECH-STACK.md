# 轻羽 FeatherPad 技术栈与架构决策

状态：**M0工程已建立；依赖精确锁定，TS/lint/Web构建与Rust编译检查通过，真实窗口/G0及产品功能待验收。** 环境事实以 [ENVIRONMENT.md](ENVIRONMENT.md) 为准；实测证据见 [M0](acceptance/M0.md)。

## 1. 确定的技术路线

桌面端：**Tauri 2 + Rust / Windows MSVC**。前端：**React 19 + TypeScript 5 + Vite 7 + CodeMirror 6**。Node 复用已安装的 22.13.0，pnpm 复用 10.32.1。UI 采用原生 CSS variables、CSS Modules 和本地字体，默认不引入 Tailwind、Ant Design、Monaco、Electron、数据库或后台服务。

版本策略：上述是主版本/兼容线选择，不是未经安装验证的精确最新版本。M0 查证各包 engines、peer dependencies 和 Rust MSRV，选取兼容的补丁版本并**写入精确版本和锁文件**，不写 `latest`、不让 loop 无边界升级。Vite 7 需要 Node 20.19+ 或 22.12+，本机 22.13.0 满足该基线；未来若插件要求更高 Node，先选兼容版本，不能据此自动替换全局 Node。Tauri Rust crate 与 JS API/CLI 统一 2.x 兼容线，插件按对应发布兼容矩阵核对。

产品目标系统：Windows 10 22H2 / Windows 11 x64，WebView2 Runtime 已存在。开发机为 Windows 11；Windows 10 支持必须通过真实目标机验证后才可写入发布支持声明。其他平台保留架构适配点，不进入 v1 验收。

### 依赖选择

| 能力 | 首选 | 引入约束 |
|---|---|---|
| UI / 状态 | React、Zustand selectors、CSS Modules | React 只承载壳层；高频文本不存 React 全局状态 |
| 编辑内核 | CodeMirror 6（state/view/commands/search/language 等） | 统一版本树；语言动态加载；不自写编辑内核 |
| 语法 | CodeMirror 对应 JS/TS/JSON/HTML/CSS/XML/SQL/Java/Markdown/YAML 包 | 不可用语言退为纯文本；语法高亮不等于编译诊断 |
| 图标 | lucide-react 精确导入，或少量本地 SVG | 不在线请求字体/图标 |
| 弹层与菜单 | 优先原生可访问结构；复杂 dialog/menu 可用 Radix 对应 primitives | 按组件引入，避免整个 UI 套件 |
| 参数契约 | Rust serde + TS 显式类型，边界运行时校验 | 枚举和错误约定见 [接口文档](CONTRACTS.md)，避免重复含糊定义 |
| Markdown | markdown-it + GFM table/task 插件 + DOMPurify | HTML 默认禁用；源码视为不可信；清洗后方可渲染 |
| 代码块高亮 | highlight.js core + 按需语言 | 限尺寸/时间；大文档不阻塞输入 |
| 格式化 | Prettier standalone + 按需 parser；SQL 用 sql-formatter；XML 按需评估 @prettier/plugin-xml | Worker 运行，锁版本，保留注释与 JSONC fixtures；失败不改文档 |
| 编码 | Rust encoding_rs + 必要检测器（如 chardetng，必须评估误判） | 编码检测是建议；原字节保留；不把猜测作为静默转换授权 |
| 文件与监听 | Rust std、notify、ignore/walkdir | 长路径、junction、权限、取消和有界遍历必须测试 |
| 全文搜索 | Rust regex + ignore 遍历，增量批次 | 明确使用 Rust regex 子集；前端查找也保持同一产品语法 |
| 文件哈希 | BLAKE3 或 SHA-256，单选 | revision 属于冲突检测，不是权限机制 |
| 删除 | 经验证的系统回收站集成 crate / Windows API | 失败报错；绝不静默降级永久删除 |
| 双文件比较 | 成熟 diff 算法库 + CodeMirror 对比视图 | 大文件截断/降级；不自写复杂 diff 算法 |
| 桌面能力 | Tauri dialog、opener、single-instance 等官方插件 | 只启用必需 capability；不授予任意 shell 执行 |
| 持久化 | Rust 管理原子 JSON manifest + 独立恢复快照 | 不需要数据库；模式版本、备份、迁移、损坏隔离 |
| 单元/组件 | Vitest + React Testing Library | mock 只用于隔离，不代替原生文件验证 |
| Web 层 E2E | Playwright，优先 channel msedge/chrome | mock bridge 覆盖 UI；不冒称覆盖 Tauri |
| 桌面 E2E | tauri-driver + WebDriver 客户端（建议 WebdriverIO） | M0 检查 Windows WebView2 driver 匹配和启动；无法跑则保留明确人工关卡 |
| Rust 质量 | cargo test / fmt / clippy | Windows 原生文件、编码、恢复与冲突集成测试 |

许可证要在加入依赖时核对并生成 notices；不把“开源”自动当作无发布义务。最终采用的每个库必须在 manifest / lockfile 有证据，表中候选不是已安装声明。

## 2. 架构与模块边界

```text
React shell：布局、菜单、命令面板、焦点、主题
  ├─ workspace：目录树/工作区/收藏
  ├─ editor：DocumentRegistry + EditorView + tabs/splits/diff/安全静态预览
  ├─ markdown：受限预览/outline/export
  ├─ search-tools：查找/替换/format/文本转换
  └─ desktop：窗口、CLI、设置、会话恢复组装
            ↓ typed bridge (invoke + bounded events)
Rust services：PathGrantRegistry / FileService / WorkspaceWalker /
               SearchService / WatchService / SessionStore / DesktopService
            ↓
用户授权的本地文件、应用数据、操作系统
```

`app-shell` 只定义命令注册、槽位和布局组件，业务模块通过 composition 接入；不得让 shell 反向依赖业务实现后又被业务引用。命令定义与依赖类型放低层 contracts。产品模块依赖方向详见 [能力地图](../CAPABILITY-MAP.md)。

**两条不同的版本线：** documentVersion 是内存编辑事务版本；diskRevision 是上次确认的磁盘字节版本。二者不能混用。一个规范化真实文件只对应一个 DocumentId 和一份内存文档，多个分栏可以有独立选区/滚动位置。

### 一次输入到一次保存

1. CodeMirror transaction 更新内存文档、undo history、documentVersion，React 仅接收小粒度元数据订阅。
2. 预览/outline/字数采用 debounce 与取消；结果携带 documentVersion，迟到结果丢弃。
3. 恢复快照合并写入（建议 1 秒 debounce，最长 5 秒 flush；退出前尝试同步收敛）。快照成功独立反馈，不等于源文件已保存。
4. Ctrl+S 捕获版本 N，提交 `save_document`，按 DocumentId 串行；Rust 核对 expectedDiskRevision、编码可表示性、目标身份和权限。
5. 写同目录唯一临时文件 → flush/sync → Windows 下经测试的原子替换/安全替换流程 → 重读或校验 revision。失败尽量保留原件，不退为先 truncate 目标文件。
6. 返回 N 已保存；如果此时内存已到 N+1，仍显示 dirty。不能因一个迟到的 save 响应把新改动标成已保存。

原子替换不等于跨任意外部进程的 compare-and-swap。检查与替换之间仍可能有第三方竞态；能检测的冲突必须阻止覆盖，不能宣称绝无竞态。多文件替换同样不承诺文件系统级全局事务。

## 3. 规划目录（未来 M0 创建）

```text
src/
  app/                  应用装配、路由无需求不加路由器
  shared/{commands,contracts,ui}/
  features/{workspace,editor,markdown,search-tools,desktop}/
  bridge/               typed invoke、事件生命周期、错误映射
  workers/              format、markdown、diff 等按需 Worker
  styles/               design tokens / 全局可访问样式
src-tauri/
  src/{commands,services,models,platform}/
  capabilities/         最小权限配置
  tests/                原生集成测试
  Cargo.toml
  tauri.conf.json
tests/{integration,e2e,desktop,fixtures,benchmarks}/
scripts/                环境、验证与发布脚本
docs/                   产品和技术基线
design/                 设计原型、tokens
tasks/                  计划、任务、执行证据
```

不要把本机个人绝对路径写入产品代码。当前脚本中的绝对路径用于此工作空间环境复用，未来通过 local dev config 覆盖；发行包通过系统 API 定位 AppData 和资源。

## 4. 设置与持久化

- 常规安装：应用配置使用系统应用数据目录中稳定 appId 的子目录；内容/恢复快照与设置分开，默认不上传。开发工具安装 E 盘限制不改变产品用户数据目录语义。
- 便携版：exe 同级 `portable.flag` 启用，写 `<exe-dir>/data`。只读位置不静默丢配置；提示选择可写目录或退出便携模式。
- settings schemaVersion、session schemaVersion、recovery schemaVersion 独立；迁移先备份，不可识别的新版本只读保护。
- 工作区覆盖配置只允许展示、缩进、换行等无执行能力字段；不允许项目配置启动外部命令。读取前校验大小和 schema。
- 恢复清单含 DocumentId、原路径、编码/BOM/换行、内存版本、基线 diskRevision、快照文件、时间；无标题草稿也有稳定 ID。
- 清理规则：成功保存且对应内存版本不再需要后清理快照；未恢复的草稿不按普通缓存 TTL 自动删。给“删除恢复副本/清空历史”明确入口和范围。
- 多窗口共享设置但编辑同文件默认定位到所属窗口；明确新窗口打开同文件时使用冲突协议，不共享未加锁的写队列。session 写入采用窗口分片＋清单，避免互相覆盖。

## 5. 性能预算（待测目标）

基准机固定此次开发机，用于回归追踪；4核/8GiB/SSD是待验证目标机，两者结果分开记录。Release、无 DevTools、WebView2 已装、本地 SSD、无后台扫描，记录版本和至少10次采样，冷/热启动分开；冷启动要说明是否清理系统文件缓存，不能把第二次启动称为冷启动。

| 场景 | v1 目标 | 验证定义 |
|---|---|---|
| 热启动可输入 | P95 ≤ 800ms | 进程创建至编辑焦点接受输入，不以窗口可见代替 |
| 首次启动/未预热 | P95 ≤ 1.5s | 不含依赖安装；单列系统文件缓存条件 |
| 空闲内存 | 私有工作集合计 ≤ 180MiB 目标 | 主进程及它所属的 WebView2 子进程求和，稳定 30 秒采样 |
| 普通文件 | 1MiB 文本打开 P95 ≤ 300ms | 读盘至首屏可编辑；语言首次加载单列 |
| 输入响应 | 常规文档 P95 ≤ 50ms | 1MiB 以内，键盘事件至下一帧呈现；中文 IME 单独检查 |
| 目录 | 100k 文件仍能在 ≤ 300ms 展示首层 | 不能先完整扫描再展示；按需列举，量与深度有界 |
| 搜索 | 首批 ≤ 500ms，取消 ≤ 250ms 目标 | 固定 10k 文件、100MiB 文本语料；磁盘差异单列 |
| Markdown | 100KiB 变更后预览稳定 ≤ 300ms | debounce 纳入统计；大文档降级，不拖累输入 |
| Web 资源 | 初始 JS gzip ≤ 500KiB 目标 | 编辑必需模块计入；格式化/语言/预览后加载 |

阈值：≤2MiB正常；>2MiB且<20MiB降级可编辑；≥20MiB且≤100MiB大文件只读分块；>100MiB拒绝完整加载，仅用户显式选择前1MiB只读预览。限量片段不可保存。阈值比较按磁盘原始字节，实际编辑内存也受预算限制。性能超标需要分析并处理，不允许只在文档中提高数字让验收通过。

## 6. 开发命令契约

当前**只有文档/环境脚本存在**。以下命令由 M0 创建、实现后才可执行，不得写空脚本冒充通过：

```powershell
. .\scripts\Enter-Dev.ps1
pnpm dev                     # tauri dev 的统一入口
pnpm dev:web                 # 仅 Web UI，mock bridge，显式标记
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e                # Web bridge mock，非原生覆盖
pnpm test:desktop            # Windows 实际 Tauri WebView2
pnpm test                   # unit + integration
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build                  # tsc/Vite + Tauri Release，必须真实产物
pnpm audit                  # lockfile级审查，按可达性处置
```

产品应用自己的开发服务器可以在后续 M0 正常启动；不要为了看设计原型启动另一份 DSH GUI，也不要把 DSH checkout 当作此项目目录。

## 7. 工程约定

TypeScript strict、命名导出、2 空格、显式错误联合、不在 React render 中做 I/O。Rust cargo fmt，错误枚举而非 panic。CodeMirror extension 按 feature 组合，避免一个巨型 Editor 组件。

```ts
export async function saveCurrentDocument(id: DocumentId): Promise<void> {
  const snapshot = documents.captureSaveSnapshot(id);
  const result = await files.save(snapshot);
  if (!result.ok) {
    commands.showFileError(id, result.error);
    return;
  }
  documents.acknowledgeSavedVersion(id, snapshot.documentVersion, result.value);
}
```

允许在当前文档范围内自主修复与替换相同职责组件，但变更模块契约需先更新文档和测试。开发样例不连接真实数据库，不执行打开文件中的脚本，不读取工作区外用户文件测试破坏性操作。

## 8. 决策记录

| ADR | 决定 | 原因 / 重新考虑条件 |
|---|---|---|
| ADR-001 | Tauri 2 而非 Electron | 复用 WebView2；已找到 Rust/MSVC；若原型证明内核兼容问题再用证据评估 |
| ADR-002 | CodeMirror 6 | 按需组合、适合文本与文档；不追求 IDE 语义系统 |
| ADR-003 | 普通本地文件为事实源 | 不导入专属数据库、不锁定内容格式 |
| ADR-004 | Markdown 三模式，不做即时富文本 | 源码可控、复制可预测，第一版完整范围可验证 |
| ADR-005 | JSON manifest + 快照 | 数据规模小；避免数据库成为启动和恢复依赖 |
| ADR-006 | 无账号、遥测默认无、无云服务 | 离线快速，用户文件不离开本机 |
| ADR-007 | Worker / Rust 承担重操作 | 防止格式化、扫描与预览卡输入；IPC 不承载每键事务 |
| ADR-008 | M0精确锁定React19.3.1/TS5.9.3/Vite7.3.7/CM6、Tauri CLI+API2.12.4与Rust2.12.5，appId为app.featherpad.desktop | 核查engines/peer/MSRV，复用Node22.13.0/Rust1.99.1；最终manifest+双锁为事实源。测试选Vitest4.1.12，开发lint选ESLint10.14.0以避开初始审计问题和停维线，不升级系统工具；残余minimatch开发期moderate可达性见M0报告 |

参考入口（M0 需要联网核查锁定版本，不以本次检索可达性代替兼容性验证）：[Tauri](https://v2.tauri.app/)、[CodeMirror](https://codemirror.net/docs/)、[Vite](https://vite.dev/guide/)、[pnpm](https://pnpm.io/)、[Rust](https://www.rust-lang.org/)、[DOMPurify](https://github.com/cure53/DOMPurify)。
