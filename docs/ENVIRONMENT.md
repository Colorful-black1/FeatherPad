# 本机环境与安装约束

状态：**已做只读环境盘点；未安装开发工具，未安装产品依赖，未运行 Tauri 构建。** 检查日期：2026-11-01。机器可继续日常使用，本项目不得切换全局 Node、修改全局 PATH 或升级现有 IDE。

## 1. 结论与实测清单

项目根目录：`E:\Codeing\ai-workspace\featherpad`。原始结构化记录见 [environment.snapshot.json](environment.snapshot.json)。当前机器为 Windows 11 Pro x64，系统版本 10.0.26100，i5-12600KF，约 31.8 GiB 物理内存；检查时 E 盘剩余约 179.9 GiB。这是开发机信息，不是产品最低配置承诺。

| 项目 | 已找到的位置 | 核查结果 | 项目使用策略 |
|---|---|---|---|
| PowerShell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 5.1.26100.2161，探针与会话入口实测通过 | 无需安装PS7；PATH未发现pwsh，脚本兼容5.1，源文本使用ASCII避免BOM被编辑器移除后的解析问题 |
| Node | `E:\Codeing\nvm\v22.13.0\node.exe` | `v22.13.0`，实际执行通过 | 优先使用这个已有版本；不另装 Node |
| PATH 上的 Node | `E:\Codeing\nvm\v25.1.0\node.exe` | `v25.1.0` | 不改变全局选择；项目会话显式置前 22.13.0 |
| pnpm | `E:\Codeing\node\node_global\node_modules\pnpm\bin\pnpm.cjs` | 用选定 Node 实际执行，`10.32.1` | 复用，锁定 packageManager 为 pnpm@10.32.1 |
| Git | `C:\Program Files\Git\cmd\git.exe` | `2.45.1.windows.1` | 复用，不重装；本次未初始化 Git 仓库 |
| Rust | `C:\Users\abcd\.cargo\bin\rustc.exe` | `1.99.1 (58cf8f9c3 2026-10-13)` | 复用已装编译器；不调用自动升级 |
| Cargo | `C:\Users\abcd\.cargo\bin\cargo.exe` | `1.99.1 (5f94df478 2026-08-27)` | 复用；新增 crate 缓存写 E 盘 |
| Rust toolchain | `C:\Users\abcd\.rustup\toolchains\stable-x86_64-pc-windows-msvc` | active-toolchain 已确认，目标库目录存在 | Windows MSVC 目标；首轮补最小编译链路检查 |
| VS 2022 Build Tools | `E:\Codeing\sdks\vs2022` | 17.14.37614.0；vswhere 确认 C++ x86/x64 组件 | 复用 |
| MSVC 工具集 | `E:\Codeing\sdks\vs2022\VC\Tools\MSVC\14.44.35207` | 目录存在；vcvars64.bat 存在 | 项目会话使用开发环境，不另装完整 VS |
| Windows SDK | `C:\Program Files (x86)\Windows Kits\10` | Include/10.0.26100.0 存在 | 复用；最终以实际原生构建为准 |
| WebView2 | `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\156.0.4314.50` | 运行时目录存在 | 首次 Tauri 启动验证；不重复安装 |
| Chrome / Edge | 标准 Program Files 目录 | 两个 exe 路径均已找到 | 原型验证可复用；不下载测试浏览器 |
| Python | `E:\Codeing\python\python.exe` | 命令发现，未核查版本 | 产品不需要；不因习惯新增 Python 依赖 |

“目录存在”和“编译成功”是不同结论。目前尚未执行 Rust 链接测试、Tauri 原生启动或 MSI/NSIS 打包，M0 必须补齐证据。现有系统 SDK、WebView2 在 C 盘属于复用已安装环境，符合优先查找的要求。

## 2. 必须遵守的安装顺序

1. 先查项目已有配置、PATH、`E:\Codeing` 下的明确候选目录。
2. 再查默认位置：`C:\Program Files`、`C:\Program Files (x86)`、当前用户 `.cargo` / `.rustup`、LocalAppData 中的运行时。只读取所需信息，不遍历个人文件。
3. 执行 `--version`、工具组件查询、最小编译或启动验证，记录“找到 / 可执行 / 真正构建成功”三个等级。
4. 能复用就复用，不能为了版本一致性盲目重装。只有确实缺失或已验证不兼容，才准备新安装。
5. **所有新增开发工具、SDK、浏览器、包缓存及安装包必须放在 `E:\Codeing` 下，默认集中到 `E:\Codeing\featherpad-dev`。** 安装命令要显式指定路径，不能接受默认 C 盘落点，也不能只把安装包放 E 盘而将主体装到 C 盘。
6. 若供应商组件强制写入系统盘，且无法遵守这一限制：记录缺口、尝试已有组件或不需安装的替代方案；仍无法解决时停止该安装并报告。不得悄悄例外。

普通 Windows 运行、注册表、系统服务可能由系统写入系统盘；这不构成允许新工具使用默认安装路径的理由。

## 3. 项目专用目录规划

| 位置 | 用途 |
|---|---|
| `E:\Codeing\ai-workspace\featherpad` | 源码、文档、锁文件、产品构建 |
| `E:\Codeing\featherpad-dev\cache\pnpm-store` | pnpm 内容存储 |
| `E:\Codeing\featherpad-dev\cache\npm` | npm 缓存，避免工具链隐式落到用户目录 |
| `E:\Codeing\featherpad-dev\cache\cargo` | 新增 Rust crate 索引和下载缓存，CARGO_HOME |
| `E:\Codeing\featherpad-dev\cache\temp` | 本项目进程 TEMP / TMP |
| `E:\Codeing\featherpad-dev\cache\playwright` | 仅未来确需下载浏览器时使用；当前优先本机 Chrome/Edge |
| `E:\Codeing\featherpad-dev\downloads` | 经核对仍必需的安装包 |
| `E:\Codeing\featherpad-dev\tools` | 新增便携开发工具 |
| `E:\Codeing\featherpad-dev\sdk` | 真正缺失时的新 SDK |
| `E:\Codeing\ai-workspace\featherpad\.artifacts` | 测试截图、基准、验证结果，不提交用户内容 |

Tauri bundler可能另行缓存NSIS/WiX等工具；不能只凭上述环境变量认为全部缓存受控。M0核查所锁Tauri版本的`bundle.useLocalToolsDir`或等效tools-path选项，配置为项目E盘目录（例如target/.tauri），M4打包时核查实际下载/缓存路径并记录；不支持可控落点的工具不得静默使用默认C盘缓存。本次未运行bundler，也未下载这些工具。

已有 Rust toolchain 仍从当前 `.rustup` 读取；不要因为设置了 E 盘的 CARGO_HOME 就执行 rustup install。Cargo 包缓存与 Rust 工具链存放位置是两个不同概念。如未来确需新增工具链，则 RUSTUP_HOME 也必须显式指向 E 盘，并处理迁移与代理选择，不得改坏其他项目。

## 4. 使用命令

以下入口现在存在，可先执行；会话初始化只设置当前 PowerShell 进程和建立 E 盘缓存目录，不修改系统环境变量。

```powershell
Set-Location 'E:\Codeing\ai-workspace\featherpad'
powershell.exe -NoProfile -File .\scripts\Probe-Environment.ps1
. .\scripts\Enter-Dev.ps1
node --version
pnpm --version
```

不要运行 `nvm use` 改变用户其他项目的 Node 选择。不要运行 `corepack enable` 在既有安装中改写全局 shim。本项目已经有 pnpm，可直接复用。

初始化源码后由 M0 创建并锁定 package manifest，首次安装：

```powershell
pnpm install --ignore-scripts
```

评估依赖脚本来源，仅为确需构建的包建立精确 allowlist，再定向 rebuild。提交 pnpm lockfile 和脚本策略；后续使用 `pnpm install --frozen-lockfile`。不得 blanket approve、不得 `audit fix --force`。

## 5. 后续环境变更记录格式

每次新增依赖或工具，更新本文件并记录：发现证据、为何不能复用、来源、校验方式、目标目录、实际执行命令、验证结果、影响范围。`environment.snapshot.json` 保留此次盘点事实；下一次完整盘点时更新日期和值，不把推测写成已安装。

## 6. 本次工作区权限事件

开始盘点时工作区的 Windows 权限不足，已按诊断技能运行一次有备份的修复，确认当前用户缺失的权限已补齐。随后用户切换为完全权限，目录读取与写入成功；未声称已重新验证受限模式。检查范围为工作区及上级，只修改工作区根目录；有界子树扫描达到 2000 项后截断，未据此宣称全树无问题。报告与恢复材料位于工作区外的 `E:\Codeing\ai-workspace-permission-recovery`，不要复制进产品，也不要由后续 loop 自动回滚权限。以下保留诊断工具原样生成的恢复命令供人工参考：本机PATH未发现pwsh，恢复前应先确认该生成脚本所需解释器与运行方式，不能将它当作已验证的项目启动命令，也不要为此自动安装工具。

```powershell
pwsh -NoProfile -File 'E:\Codeing\ai-workspace-permission-recovery\acl-backup-596297e3ab9545ddb85bcb85efbec0b0.json.ps1' -Path 'E:\Codeing\ai-workspace' -AllowRoot 'E:\Codeing\ai-workspace' -Restore 'E:\Codeing\ai-workspace-permission-recovery\acl-backup-596297e3ab9545ddb85bcb85efbec0b0.json'
```

本段只记录已发生的环境操作，不要求后续 agent 重复修复。
