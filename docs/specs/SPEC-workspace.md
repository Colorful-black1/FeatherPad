# SPEC-workspace：工作区与资源管理器

> 模块 `workspace`；业务依赖仅 `file-core`。状态：M1与M2工作区能力已实现并通过G1/G2统一验收；后续阶段仍须回归。树和工作区拥有自己的状态，不反向依赖editor；脏文件保护通过应用编排层注入决策结果。

## Objective 与范围

为独立文件、单根文件夹和多根工作区提供统一定位入口，支持快速浏览/操作而不把树状态误当磁盘事实。拥有 F-WORK-001–012，见 [矩阵](../FEATURE-MATRIX.md)。M1：001/003/004/005/007；M2：002/006/008/009/010/011/012。依赖文件身份/原子程度/回收站契约见 [file-core](SPEC-file-core.md)，不重新发明写入。

## Feature-ID 追踪清单

M1：F-WORK-001、F-WORK-003、F-WORK-004、F-WORK-005、F-WORK-007。

M2：F-WORK-002、F-WORK-006、F-WORK-008、F-WORK-009、F-WORK-010、F-WORK-011、F-WORK-012。

每项均以下述交互/error-state和矩阵验收，未实现不得标完成。

**M2实施状态（2026-11-03，G2通过）：** 多根、收藏、便携工作区文件、排除/隐藏规则、受限链接遍历、监听/聚焦重扫、原生拖放移动及对应失败状态已接入。真实桌面场景验证多根移除时打开文档的独立授权和持久撤销、真实文件/目录复制移动与碰撞/旧revision拒绝、10k文件过滤遍历、实际junction越界和文件树同步失败可见；工作区文件相对路径迁移、收藏排序/修复/清空和坏数据保留由定向模型/Web证据覆盖。浏览器拖放模型不等同于Explorer原生拖放，物理网络盘/可移动盘拔插留给M5综合故障回归。详细证据见[M2验收](../acceptance/M2.md)。

## 契约、项目结构与风格

跨进程线协议唯一来源是 [CONTRACTS](../CONTRACTS.md)：snake_case命令、grant/FileRef、ResultEnvelope及规范AppError.code。本文camelCase方法/类型是模块内部语义示例；域错误名写入`details.reason`并映射至规范code（无效配置/限额→INVALID_INPUT，根不可达→NOT_FOUND或PERMISSION_DENIED，越根→OUT_OF_SCOPE，循环→INVALID_INPUT）。UI每页最多请求500条，不改变线协议最大1000的限制。

```ts
type WorkspaceRoot = {
  rootId: string;
  displayName: string;
  originalPath: string;
  canonicalIdentity: string;
  availability: 'ready' | 'missing' | 'denied' | 'offline';
};
type WorkspaceSnapshot = {
  schemaVersion: 1; workspaceId: string; roots: WorkspaceRoot[];
  excludes: string[]; respectGitignore: boolean; followDirectoryLinks: boolean;
};
type WalkRequest = {
  requestId: string; rootIds: string[]; include: string[]; exclude: string[];
  followDirectoryLinks: boolean; pageSize: number;
};
```

提供 `openFolder(path, mode)`、`addRoot(path)`、`removeRoot(rootId)`、`reorderRoots(ids)`、`listChildren(rootId, cursor, pageSize≤1000)`、`reveal(identity)`、`walk(request)`、`cancel(requestId)`、`resolveRelative(rootId,path)`、`getSearchScope()`、`saveWorkspace(target)`、`loadWorkspace(path)`。返回统一 `Result<T, AppError>`，错误结构沿用file-core，附加 `INVALID_WORKSPACE`、`ROOT_UNAVAILABLE`、`OUTSIDE_ROOT`、`LINK_CYCLE`、`LIMIT_REACHED`；列表游标是不透明值并绑定当前目录项revision，过期游标要求刷新。

`walk`异步批次事件包含requestId/generation、rootId、规范identity、展示路径、relativePath、file size、候选编码提示和跳过原因；不把文件正文塞入工作区模型。search-tools自己按file-core读取并核验。消费者可取消并丢弃过期generation；不会回调editor模块。workspace配置变化不直接写editor缓冲。

建议结构 `src/features/workspace/`（树模型/规则/DTO）、`src-tauri/src/services/workspace/`（遍历/监听）、`tests/unit/workspace/`、`tests/integration/workspace/`、`tests/e2e/workspace/`，当前仅文档约定。TypeScript camelCase、PascalCase类型；稳定rootId不使用名称当主键；Rust snake_case。纯规则解析与文件适配器分离，错误用code而非解析文案。

## 打开与多根（F-WORK-001/002/009）

欢迎入口/菜单/快捷键选择文件夹。默认替换当前工作区之前让应用编排层解决dirty决策；用户取消时维持原工作区。替换不删除任何文件。独立已打开文档可留在“打开的文件”区域，不强迫必须属于根。

多根可添加、移除、重排。重复canonical root不重复添加；根包含关系允许，但树清楚显示层级，搜索按文件identity去重，结果携rootId和最短已授权路径。相同文件夹名用上级路径区分。移除根只撤销该根授权/监听/树状态，不删除磁盘，不强关打开的dirty文档；其后需独立文件授权维持访问。

T204实施决策：目录grant按物理身份去重；移除前分阶段生成独立文件grant、写入持久授权及目录撤销记录，全部成功后才更改活跃绑定。旧会话回执不得重新引入已撤销grant；移除回执可幂等重取，失败保留原根/文档。多根最多16项，切换活动根保留各自展开/选择状态；工作区模块不接触编辑正文。

工作区文件建议扩展 `.featherpad-workspace`，JSON带schemaVersion、roots（相对配置文件或绝对路径）、排除规则、允许的非安全敏感设置。相对路径优先，移动后重新解析和授权，不静默授予越界访问。配置不包含正文、访问令牌或机器绝对缓存；版本未知/语法错显示恢复/另存选项，不写空对象覆盖。保存工作区使用file-core保护写入；首次保存明确选路径。缺根保留占位与修复入口，不能把临时断盘解释成用户删除。

## 资源树与操作（F-WORK-003/004/005/006）

目录懒加载，默认文件夹在前、名称自然排序，保留原大小写；隐藏项开关与搜索排除独立。支持选择、范围选择、键盘展开/折叠、刷新、复制完整/相对路径、在系统资源管理器显示、定位当前文件。超大目录默认每页200、最大1000条并支持分页/虚拟化；M1/T104通过分页验收，尚未声明整表虚拟化。重复刷新保留已展开身份，不能按索引错选。根/目录读失败显示行内原因和重试，不空白伪成功。

新建文件/目录采用树内输入；校验空名、`CON`等保留名、非法字符、尾点/空格和现存碰撞。创建成功再插入树并选中；新文件进入固定编辑标签。重命名给出后缀提示，更新打开文档路径、最近/收藏显示和监听；应用通过identity映射事件消费，不由workspace导入editor。大小写改名也要走file-core。

T105.a边界（2026-11-01）：树输入只向已授权目录提交名称，前端做即时提示但Rust仍执行相同的Windows名称、UTF-16长度、父目录、链接和碰撞复核。创建与重命名均返回真实磁盘核验后的树项；重命名另返受影响已打开文档的documentId/ref/displayPath，前端按documentId更新路由元数据并保留EditorState。大小写改名使用同目录唯一中间名和失败回卷；任何失败不从树或标签伪造新路径。

树项revision绑定名称、类型、完整Windows属性、最后写入时间和大小；目录大小统一为0，只有文件使用原始大小。变更后刷新当前目录及直属上级以更新revision；切换根后迟到结果不能污染新根。目录改名先释放已打开后代文件lease，再从新路径重开并核对FileIdentity和最终路径，恢复原DocumentId；重开或注册失败时尝试回卷目录并重绑旧路径，失败必须可见。文件改名直接更新lease，不扩大句柄共享删除权限。

删除确认显示所选路径/数量、包含目录、已打开dirty影响和“移至回收站”。T105已接真实入口：打开确认时先重新列举项目并获取Rust impact；默认焦点取消。dirty可先保存并刷新revision/identity后重新确认，或保护草稿再回收。HTML dialog隔离背景键盘快捷键；未知传输结果保留原请求，只核对同一requestId。成功后按回执标记缺失、保留当前EditorState/undo，完整缓冲CtrlS进入另存，后续新输入使“草稿已保护”失效；分块预览不能继续分页或保存。M1按单项操作验收，多选编排由T206继续。上层脏文档可保存/保留草稿并继续/取消；不得先删除再问。成功后树移除，编辑器仍可保留缺失文件缓冲；回收站不可用时失败，绝无无提示永久删除。多项结果逐项列出。

外部拖入文件 = 打开文档；拖入目录 = 添加根；混合拖入先展示概要，可取消。树内拖动默认移动，Ctrl明确复制；悬停展开、落点预览并二次确认目标/覆盖风险。禁止拖到自身后代/非法根/只读目标。碰撞默认取消，覆盖必须逐项明确选择并重新核对revision；跨卷移动是复制校验后回收源的多步骤操作，保留进度/中断清单，不宣称原子。取消不删除已存在目标或误删源；已完成项和未完成项必须可见。

## 最近、收藏与隐私（F-WORK-007/008）

最近最多50项，以canonical identity去重，记录最后成功打开时间而非每次聚焦。独立文件与工作区可切换；缺失项灰显，提供重定位/移除。单项移除与清空立即持久化；关闭历史后新打开不写最近，既有数据由用户单独清除。最近不存搜索词、正文、剪贴板。

收藏独立列表，可加文件/根、命名、排序、移除；清空最近不清收藏，关闭历史不禁收藏。路径改变依据identity更新，磁盘不在时保留修复入口。所有此类设置由desktop提供持久化适配器注入，workspace不依赖desktop模块。

T113实现状态（2026-11-02，已通过相关真实Release）：最近列表、50项/48KiB上限、文件canonical identity与工作区grant去重、全部/文件/工作区筛选、缺失灰显/重选、单项移除、二次确认清空和隐私关闭均已接入真实设置存储。关闭历史后新打开不新增，重启仍保留既有记录；启动仅恢复既有且身份匹配的持久授权，不因历史记录自动扩大文件/根权限。证据覆盖真实文件与目录、移动后修复和重启直接打开；收藏、完整历史/恢复/日志隐私清理仍由T215等后续任务负责。

## 排除、链接与监听（F-WORK-010/011/012）

默认搜索排除 `.git/**`、`node_modules/**`、`target/**`、`dist/**`、`build/**`，遵循根及子目录 `.gitignore`（按gitignore语义处理`!`、目录规则），用户glob作为显式包含/排除。优先级：授权范围/硬限额不可覆盖 → 用户exclude → 用户include筛选 → gitignore/default；用户可明确关闭“遵循忽略”以扫描通常忽略内容。隐藏开关与ignore不混淆；UI展示生效规则和跳过统计，格式错逐条提示，不吞掉所有文件。

默认不跟随目录symlink/junction/reparse point，树可显示链接图标和目标概况。显式启用跟随后，以volume/file ID + canonical path维护visited集合并限深64，遇循环报告并跳过；可从重复根/硬链接去重。目标越已授权根先请求授权或跳过，无法解析/权限拒绝计入统计，不能无限重试。包含中文、空格、长路径、UNC与可移动盘。

监听去抖默认100ms合并，目录级watch数量有预算；事件溢出/rename歧义/挂起恢复触发受限全量重扫并标注“正在同步”。监听不是正确性的唯一来源，打开和保存仍读取真实磁盘。断盘标记offline保留树缓存、禁写，重连可刷新；不把空结果覆盖持久化根。监听只能发布identity/path变化，不更改dirty正文。

## Acceptance、error-state 与测试策略

- F-WORK-001/002/009：空目录/不存在根/权限拒绝、同名/嵌套根、移动配置目录、损坏/未来版本配置；原根不被空白覆盖，移除根不删文件。
- F-WORK-003/004：10万子项分批/键盘可用；中文名、超260字符路径、保留名、重名、大小写改名；原identity选择和打开标签联动正确。
- F-WORK-005/006：dirty删除确认/取消、回收站不可用、跨卷复制后中断、碰撞与源变更；逐项报告，无永久删除回退。
- F-WORK-007/008：50项上限去重、清空与关闭后不再新增、收藏独立、缺失项修复；不存正文。
- F-WORK-010/011：gitignore反选、glob错误、Unicode路径、junction循环/越根、嵌套根同文件结果不重复；取消不继续投递旧批次。
- F-WORK-012：事件风暴/溢出、外部rename/delete、断盘/恢复；树最终与磁盘一致，dirty缓冲仍保持。

测试层：单元验证规则、去重、根迁移、树reducer和权限边界；集成用真实临时目录/链接/监听（Windows10/11需真实junction）；e2e验证键盘树/拖放/脏文件/历史隐私。长路径/UNC/跨卷/回收站/大目录为手工或专用集成演练，不用模拟结果宣称平台通过。每个feature至少映射一个验收，故障路径需要可复现夹具。

`pnpm test:e2e`仅覆盖Web/mock bridge；真实Tauri/WebView2目录场景由`pnpm test:desktop`内的`tests/desktop/workspace.ts`与Rust `directories`/显式Release `directory_scale`集成测试组成。目录相关测试已实际执行；其余工作区规则的针对性命令在对应feature实现时补充。通用检查为`pnpm lint`、`pnpm typecheck`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。

## Boundaries 与未决风险

Always：磁盘操作走file-core，树操作后核实结果，根授权和实际canonical目标一致，循环/限额可见。Ask first（实施变更）：目录权限扩大、工作区格式迁移、默认ignore策略或跨卷覆盖行为改变。Never：永久删除降级、移除根等于删目录、监听事件直接覆盖dirty正文、无限跟随链接。

待验证：Windows网络盘监听/短路径别名、跨卷取消恢复、gitignore性能、特殊reparse point与长路径行为。未验证场景必须给状态与重试，不能伪装为空目录。
