# SPEC-desktop：本地设置、Windows 集成与发布

> 轻羽 FeatherPad；模块 `desktop`；业务依赖仅 `editor`、`workspace`、`file-core`。状态：T112的F-DESK-001/002及相关M1设置能力已通过真实Release；其余能力待实现、待验证。拥有 F-DESK-001–013，详见 [矩阵](../FEATURE-MATRIX.md)。M0：013；M1：001/002/010/011；M2：003/004；M4：005–009；M5：012。

## Objective 与提供方契约

跨进程线协议唯一来源是 [CONTRACTS](../CONTRACTS.md)，本文camelCase API/DTO是模块内部语义示例。域错误名写入`details.reason`：INVALID_SETTINGS→INVALID_INPUT，SHORTCUT_CONFLICT/SESSION_INCOMPLETE→CONFLICT，INTEGRATION_DENIED→PERMISSION_DENIED，RUNTIME_MISSING→UNSUPPORTED。跨边界使用规范ResultEnvelope/AppError和grant校验。

在Windows10/11 x64提供可靠、本地、离线且不会抢占系统设置的桌面体验。安装/便携、多窗口、启动参数都复用同一文档/保存规则；不因系统入口绕过dirty、授权或revision检查。Tauri2负责宿主和受限IPC，React负责设置和会话展示。UI布局由应用组合层装配，本模块不依赖app-shell业务实现。

```ts
type Settings = {
  schemaVersion: 1; theme: 'light' | 'dark' | 'system';
  fontFamily: string; fontSize: number; tabSize: 2 | 4 | 8;
  insertSpaces: boolean; wordWrap: boolean; historyEnabled: boolean;
  autoSave: 'off' | 'afterDelay'; autoSaveDelayMs: number;
  hotExitEnabled: boolean; markdownAllowSanitizedHtml: boolean;
  globalShortcut: { enabled: boolean; accelerator: string | null };
};
type WindowSession = {
  windowId: string; bounds: { x: number; y: number; width: number; height: number };
  rootIds: string[]; activeViewId: string | null;
  groups: { groupId: 'primary' | 'secondary'; viewIds: string[] }[];
  views: { viewId: string; documentId: string; isPreview: boolean;
    selection: { anchor: number; head: number }[]; scrollAnchor: number }[];
};
type SessionManifest = {
  schemaVersion: 1; sessionId: string; windows: WindowSession[];
  recoverySnapshotRefs: string[]; persistedAt: string;
};
```

会话引用必须交叉校验（window/group/view/document和恢复副本均存在），不得序列化React组件或CM实例。提供 `loadSettings`、`updateSettings(patch,expectedVersion)`、`resetSettings(scope)`、`importSettings`、`exportSettings`、`requestWindowClose(windowId)`、`createWindow`、`routeOpenRequest`、`setIntegration`、`getRuntimeInfo`。结果沿用file-core统一Result/AppError，附 `INVALID_SETTINGS`、`SHORTCUT_CONFLICT`、`INTEGRATION_DENIED`、`RUNTIME_MISSING`、`SESSION_INCOMPLETE`。导入/CLI/实例间消息都当不可信边界校验。

建议结构 `src/features/desktop/{settings,session,commands}/`、`src-tauri/src/services/desktop/`（宿主平台适配器位于`src-tauri/src/platform/`）、`tests/unit/desktop/`、`tests/integration/desktop/`、`tests/e2e/desktop/`，只是约定未创建。TypeScript camelCase/PascalCase，Rust snake_case；系统适配器与纯设置合并分离，错误code稳定而文案可本地化。

## Feature-ID 追踪清单

M0：F-DESK-013。M1：F-DESK-001、F-DESK-002、F-DESK-010、F-DESK-011。

M2：F-DESK-003、F-DESK-004。M4：F-DESK-005、F-DESK-006、F-DESK-007、F-DESK-008、F-DESK-009。M5：F-DESK-012。

每项联合矩阵和下述交互/error-state/test strategy验收，安装/便携与完整发布均是v1范围。

## 设置、主题、快捷键与隐私

F-DESK-001设置优先级：内置默认 < 用户设置 < 工作区允许项 < 当前会话临时展示选择。工作区仅覆盖缩进、Tab、换行/语言显示等低风险项；不能启用自动保存、全局快捷键、系统关联、远程网络或放宽HTML/目录授权。设置页可搜索、显示来源/默认值、单项/分组重置、导入导出版本化JSON；导入先校验/预览变更，不执行配置中的命令。未知键保留为未来兼容并提示、非法值回退上层且给诊断；损坏配置隔离并提供恢复，不能无提示清空。写设置使用file-core保护写入与版本检查。

默认：主题跟随系统，字体优先本地等宽/Cascadia Mono/Consolas，14px，tabSize4、insertSpaces true、自动换行开启；新文件UTF8无BOM/CRLF；autoSave off（开启默认1500ms，合法范围500–10000）；hotExitEnabled true；Markdown raw HTML默认关闭，启用也仅清洗受限HTML；全局快捷键关闭；最近记录开启最多50项。用户修改即展示效果，持久化失败显示“仅本次生效”，不假称保存成功。

F-DESK-002亮/暗/跟随系统、字体字号Tab/行高设置可预览/撤销，缺失字体回退并说明，不在线下载。主题/状态/选择可读对比度，不能只用颜色说明dirty/error。系统高对比与200%缩放可用，减少动画尊重系统设置。

T112切片与边界：a私有版本化设置存储与原始文件revision、唯一备份/损坏隔离恢复；b用户/受授权工作区/会话设置合并、非法值诊断与未知键保留、版本化导入预览/导出；c亮暗/系统主题及本地字体、字号/行高/Tab即时预览与撤销；d可搜索设置页、单项/分组重置和定向原生验收。读取工作区配置不登记隐藏编辑文档，不授予根外路径；不自动写入工作区文件。后续能力的开关不伪装已生效。新增线协议见CONTRACTS。2026-11-02已通过相关真实Release验收；OS高对比、读屏与OS缩放的完整无障碍矩阵仍由T114继续，不把DOM 200%证据外推为这些平台能力。

F-DESK-003应用快捷键采用稳定commandId映射、冲突检测、恢复默认、导入导出。默认CtrlN/O/S、CtrlShiftS、CtrlW、CtrlShiftT、CtrlP、CtrlShiftP、CtrlF/H、CtrlShiftF/H、CtrlG、CtrlTab、AltLeft/Right；实际组合受Windows/IME保留键约束，不能抢系统安全组合。系统全局仅提供“唤起/新建轻羽窗口”等显式登记命令，默认未注册，用户选择后检测占用/错误，关闭功能和退出释放。应用内按键仅活动窗口处理，不注册成全系统热键。

F-DESK-004最近清空/关闭记录、收藏删除、恢复清理分开说明。清空最近不删收藏/正文；关闭记录后新操作不写历史；恢复含敏感正文，展示本地存储位置与手动清理范围。要删除当前dirty唯一恢复副本必须说明风险并由用户明确放弃，不能当缓存自动清理。30天未认领草稿只提示清理，保留期不授权删除唯一未保存副本。诊断日志默认不含正文/搜索词，可导出前预览路径脱敏。无遥测/账号/上传。

## 会话、热退出与多窗口

F-DESK-011默认热退出开启，关闭窗口先冻结会话清单/最新dirty快照引用，经file-core持久化并收到全部成功确认，才允许窗口销毁。写快照debounce1s、持续输入最长5s调度；热退出显式flush最新版本不能等下次定时器。失败留在应用，提供重试、另存、明确放弃；关闭热退出则走保存/不保存/取消。显式不保存产生tombstone，不得重启复活。

会话恢复包括根/工作区、固定/预览标签、组/双分栏、活动文档、光标/滚动、无标题正文/命名dirty内容、编码和换行意图；不承诺恢复完整undo。窗口越屏边界回可见区域；缺根/缺文件保留占位和恢复候选。磁盘当前内容变化则保留两者并提示diff，不自动覆盖。崩溃只保证成功落盘快照，断电/强杀前最后未持久化的数秒可能丢失；磁盘损坏/容量不足不在零损失承诺内。

F-DESK-007默认同一用户/同一安装数据域运行一个协调进程，多次启动路由至既有实例；安装版/便携版不同数据域互不窃取实例。用户可显式新窗口；后台协调文档身份和每文件写队列，任一文件只有一个可写所有窗口会话。重复打开在所属窗口聚焦；显式在新窗口打开同一文件则只读镜像并可跳转原窗口。转移可写所有权需先同步最新快照、关闭旧可写视图并完成锁内交接；不能两窗口各持一份dirty正文。进程崩溃释放内部所有权，下次从快照恢复；不同数据域/外部编辑器仍视为外部并发，按revision冲突处理，不声称OS全局独占。

关闭多个窗口任一失败/取消，未关闭窗口保留；系统关机/注销给尽力flush但Windows可能强制终止，因此不能保证最后按键。关闭行为不能无限阻止关机。CLI等待句柄与文档生命周期关联，不以应用启动成功当编辑完成。

## CLI（F-DESK-008）

安装可选提供PATH shim，便携可用exe完整路径；不默认修改全局PATH。约定命令：

```text
featherpad --help
featherpad "D:\笔记\第一篇.md" "D:\资料\配置.json"
featherpad --reuse-window "D:\项目"
featherpad --new-window "D:\项目\a.ts"
featherpad --goto "D:\项目\a.ts:12:5"
featherpad --wait "D:\临时\message.txt"
featherpad -- "D:\临时\--name.txt"
```

无参数激活最近窗口或欢迎页；路径可以多个，目录作为根，文件打开；相对路径基于调用方cwd，经IPC显式传递，不能用宿主cwd误解析。`--goto`从右解析`:line[:column]`，兼容盘符冒号、行列1基，越界clamp提示；`--new-window`与`--reuse-window`冲突退出2。`--wait`等待本请求引入或关注文档全部关闭/明确放弃，取消打开/路径错误返回1、正常生命周期完成返回0，参数错误2；宿主崩溃/无法连接返回1并给错误，不永久挂起。既有dirty文档也等待实际关闭，不另开独立可写副本。

实例通信仅接受同用户本地通道，消息含requestId/cwd/args，限制长度/数量、校验类型，不拼shell字符串、不执行用户路径。命令不把正文打印到stdout；多个路径部分成功返回1并报告各项。CLIhelp离线可用。

## Windows 安装、便携与系统集成

F-DESK-005面向Windows10（最低22H2目标）/11 x64用户级安装，无需管理员；版本升级保留用户设置/恢复，退出协调进程后替换文件，失败可恢复上个安装。发布签名策略/证书成本待落实，未签名明确告知SmartScreen行为，不能伪称已签名。卸载默认保留用户数据，显式选择清除前警告未保存恢复；清理仅产品自有目录，不跟随symlink删别处。

WebView2 runtime是宿主依赖：优先使用系统Evergreen runtime，缺失时显示检测结果和离线runtime包选择/安装指引；应用自身核心功能不在运行时联网。完整离线分发需另提供官方runtime离线包/合法安装说明，架构匹配并校验来源；应用小包大小目标不包含runtime，不能把联网bootstrapper称完全离线安装。

F-DESK-006 ZIP解压运行，通过明确portable marker识别，用户数据在程序旁 `data/`。不可写目录不静默切到用户目录，应给“移动目录/显式选择独立数据目录/取消”；与安装版隔离，版本迁移有备份，升级不覆盖data。便携默认不写注册表/PATH/文件关联，用户显式启用集成才执行并可撤销；UNC/移动盘不可写返回清楚错误。

F-DESK-009设置页单独提供扩展名关联和Explorer右键菜单opt-in，安装默认不抢占。遵循Windows默认应用设置流程，不伪造UserChoice哈希、不强抢默认编辑器；右键命令路径和参数使用Windows正确引用，带空格/中文/以`-`开头路径不可注入。记录自有注册项与旧值，撤销/卸载仅清仍指向本产品的项，第三方后续修改不回滚覆盖。当前用户权限不足时反馈，不暗中管理员提权。用户指定的轻羽 FeatherPad名称与现有同名开源项目存在混淆风险，记录为本地命名选择，发布前核实名称/包ID/图标/许可证标识，不在文档阶段反复申请命名确认。

## 无障碍、离线与性能发布

F-DESK-010所有菜单、面板、标签、树、分栏、设置可键盘到达；焦点可见、关闭弹层返回触发点、无陷阱，读屏朗读名称/当前项/dirty/错误和搜索进度。编辑器提供可访问模式，双栏和图片有标签；200%缩放/高对比/减少动画通过Windows手工验证，自动axe检查仅辅助。

F-DESK-013默认无网络权限/请求，CSP限制脚本/连接/资源，Tauri capability最小化且按窗口区分，预览窗口无IPC。Rust入口验证payload/path/revision/资源scope，不因前端已校验而省略；工作区内容和配置不可信。仅用户动作后的安全外部链接交系统浏览器。内置字体/高亮/formatter离线；断网新建/打开/保存/搜索/格式化/导出可用。不开启远程更新检查，v1采用用户下载签名包手动升级，不能影响离线。

F-DESK-012待验证性能目标，参考目标机4核/8GiB/SSD、Windows11，并在Windows10回归；开发机i5-12600KF/32GB/Win11仅作开发基准，不代表目标机通过。采样10次取p95，冷启动单列：冷启动≤1.5s，1MiB文本暖打开≤300ms，正常键入p95≤50ms，大文件只读首屏≤1s；空闲主进程+所属WebView2合计私有工作集≤180MiB、30秒CPU均值≤1%；1万文件100MiB搜索首批≤500ms/总≤5s，取消≤250ms；应用压缩分发包≤25MiB目标（runtime另计）。以上全部是目标非实测。测试报告注明CPU/系统/runtime/杀毒/电源状态/样本。

完整v1发布要求M0–M5和86项必需验收完成，附版本/变更日志、许可证/第三方清单、已知限制、校验和、安装与便携说明。安装/升级/卸载/离线runtime、故障恢复、外部并发、恶意预览、长路径回归均需证据；不把M1 MVP发布当完整交付。

## Acceptance、error-state 与测试策略

- 001–004：设置优先级/损坏文件/非法导入、主题系统切换/缺字体、快捷键占用/释放、关闭历史/清理恢复唯一副本保护；磁盘失败显示仅会话生效。
- 005/006/009：干净Win10/11 x64虚拟机离线安装、有无runtime、升级/失败回退/卸载、只读便携目录、opt-in关联与撤销第三方改动；不默认抢关联。
- 007/008：多启动路由、同文件新窗口只读镜像、所有权交接、中文空格CLI/盘符冒号/`--`/非法参数/--wait/宿主崩溃；写队列不并发覆盖。
- 010/011：键盘/读屏/200%缩放、dirty快照失败阻止退出、强杀恢复与损坏manifest、磁盘变更双副本、明确放弃不复活。
- 012/013：按目标机报告性能；断网全流程、CSP/IPC越权/路径注入、发布清单完整；开发基准不能代替目标机验收。

单元：设置合并/schema/CLI解析/会话状态机；集成：Windows宿主实例路由/registry mock和真实用户级隔离测试、文件锁与恢复；e2e：真实Tauri/WebView2命令/焦点/热退出。系统集成在测试账户/虚拟机执行并可回滚；签名/安装/卸载/runtime/关机边界必须手工记录。性能测试统一采集整棵宿主相关进程，不能只测Rust主进程。

`pnpm test:e2e`仅覆盖Web/mock bridge；真实Windows安装/会话/系统集成使用待建立的 `pnpm test:desktop -- desktop`、Rust原生测试和受控虚拟机演练。命令约定（未搭建、未执行）：`pnpm dev`、`pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:unit -- desktop`、`pnpm test:integration -- desktop`、`pnpm test:e2e -- desktop`、`cargo test --manifest-path src-tauri/Cargo.toml desktop`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。打包签名命令由工程脚本补齐，不在无工程阶段编造已可执行命令。

## Boundaries 与未决风险

Always：用户级/显式系统集成、会话flush确认、离线/最小权限、完整平台验收。Ask first（后续实施变更）：启用遥测/自动联网更新、改数据目录/恢复保留规则、提高权限或系统默认关联。Never：抢关联、未落盘即宣称安全退出、以每窗独立缓冲并发写同文件、伪称签名/测试通过。

待验证：Windows10支持生命周期与runtime版本、签名成本/SmartScreen、多窗口WebView2内存、CLI等待与关闭取消、portable升级、键盘/读屏平台差异、同名项目发布混淆。风险需要验证与发布说明，不是省略对应功能的许可。
