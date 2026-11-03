# 开发完成后的清理候选清单

用户要求：**只列出清单，不由agent自动删除。** 本文件不是删除授权，也不是要求当前正在运行的开发/测试流程执行清理。开发尚未完成，以下目录暂时保留；最终验收结束、agent与应用及构建/测试进程停止后，再由用户决定。

2026-11-03补记：用户已自行清理部分生成数据。下文为历史盘点；已删除的夹具路径以代码文本保留，后续测试需要时会生成新的UUID目录。验收证据与交付包继续保留。

## 1. 本次只读盘点

盘点时间：2026-11-01 23:03（Asia/Shanghai）。范围仅当前项目`E:\Codeing\ai-workspace\featherpad`。仅统计文件元数据，未运行项目、未删除、未移动任何文件；没有跟随符号链接/junction等reparse point。开发中的目录仍会变化，因此最终清理前要重新统计。

大小为文件逻辑长度之和，1GiB=1,073,741,824字节；未对硬链接去重，未计算稀疏/压缩与目录元数据，**不等于保证可释放的磁盘空间**。本轮跳过2063个reparse point，读取错误0项。

| 顶层目录 | 当时逻辑大小 | 主要用途 | 最终处理建议 |
|---|---:|---|---|
| [.artifacts](../.artifacts/) | 13.90GiB | 测试大文件、临时浏览器配置、故障fixture、日志、截图、验收JSON | 优先区分生成数据与证据，不能整目录不分内容删除 |
| [src-tauri/target](../src-tauri/target/) | 12.50GiB | Rust/Tauri编译缓存、调试符号、debug/release可执行文件和中间库 | 保留最终交付包/程序及配套文件后，可清理构建产物；再次开发会重编译 |
| [node_modules](../node_modules/) | 161.7MiB | 前端开发依赖 | 确认以后不再本地开发或测试时可清理；之后需要按锁文件重装 |
| [dist](../dist/) | 1.04MiB | Vite前端构建输出 | 最终原生交付包已保存、无需preview服务时可清理；再次构建会生成 |
| [.git](../.git/) | 2.55MiB | 项目提交历史 | 保留，不作为缓存清理 |

前两项合计约26.40GiB逻辑长度，是当前占空间主体；后面的子目录表包含在这些父目录内，不能重复相加。

## 2. 优先核对的具体清理候选

| 路径或范围 | 当时逻辑大小 | 归因与条件 |
|---|---:|---|
| [.artifacts/T103](../.artifacts/T103/) | 8.53GiB | 大文件/流式读取/动态增长边界测试。Rust测试源码明确在该目录生成数据；验收报告保存后，UUID目录里的大文本fixture是优先候选 |
| `.artifacts/T103/stream/` | 2.23GiB | 流式读取测试生成文件；是T103的子集 |
| `.artifacts/T103/dynamic-growth/` | 2.13GiB | 文件动态增长测试数据；是T103的子集 |
| `.artifacts/T103/head-preview/` | 1.86GiB | 多轮生成的`超过一百兆.txt`，单个104,857,601字节；是T103的子集 |
| `.artifacts/T103/reclassified/` | 340MiB | 打开期间重新判定文件大小的测试数据；是T103的子集 |
| [.artifacts/T002](../.artifacts/T002/) 中的 `webview2-*` 临时子目录 | T002总计3.97GiB | 桌面测试每轮使用mkdtemp建立独立WebView2 profile，包含浏览器缓存和测试专用featherpad-state；单个profile常见约134MiB。必须确认对应应用/WebView2进程退出，并确认不是实际用户数据 |
| [.artifacts/T003](../.artifacts/T003/) 中可重新生成的fixture/旧运行目录 | T003总计1.13GiB | 早期IPC/文件读取测试产物；先看目录内容和归属，保留最终必要证据，不凭编号盲删整目录 |
| `.artifacts/T001/clean-install/` | 135.1MiB | 干净依赖安装验证副本，不是项目主依赖目录 |
| `.artifacts/T001/clean-install-final/` | 134.7MiB | 第二份安装验证副本；两项属于T001总计269.8MiB |
| [src-tauri/target/debug](../src-tauri/target/debug/) | 10.92GiB | 调试构建与中间库，是构建侧最大的清理候选；停止开发/调试后再处理 |
| [src-tauri/target/release](../src-tauri/target/release/) | 1.58GiB | 发布构建也含大量中间依赖，**同时包含当前实际运行程序**；先将最终程序/配套资源或正式包保存在独立交付位置，再决定清理 |
| [.artifacts/playwright-results](../.artifacts/playwright-results/) | 未单列 | Web E2E的截图、trace与失败附件；保留有价值的失败记录与最终验收摘要后，可清理历史运行产物 |
| [.artifacts/desktop-results](../.artifacts/desktop-results/) | 未单列 | 原生桌面测试输出；处理原则同上 |

源码归因：[desktop.config.ts](../desktop.config.ts)与[playwright.config.ts](../playwright.config.ts)把测试输出定向到上述.artifacts子目录；[桌面测试入口](../tests/desktop/shell.spec.ts)在T002生成临时profile，并将测试应用状态目录置于该profile；[大文件打开测试](../src-tauri/tests/open_document.rs)与[流式读取测试](../src-tauri/tests/stream_snapshot.rs)在T103生成fixture。

## 3. 最大单文件举例

这些文件都位于上述候选目录内，不应再另算一遍空间：

| 文件 | 当时逻辑大小 | 说明 |
|---|---:|---|
| [featherpad_lib.lib](../src-tauri/target/debug/featherpad_lib.lib) | 721.0MiB | Rust/Tauri调试链接库 |
| [deps中的featherpad_lib.lib](../src-tauri/target/debug/deps/featherpad_lib.lib) | 721.0MiB | 构建路径中的另一项；可能共享硬链接，不能据路径数量推断物理占用 |
| [libfeatherpad_lib.rlib](../src-tauri/target/debug/libfeatherpad_lib.rlib) | 314.8MiB | Rust中间库 |
| [featherpad.pdb](../src-tauri/target/debug/featherpad.pdb) | 120.2MiB | Windows调试符号 |
| T103/head-preview各UUID子目录中的`超过一百兆.txt` | 每个100MiB+1字节 | 大文件边界fixture，多轮测试会重复生成；只处理确认属于测试的路径 |

## 4. 清理前必须先保留

1. 最终可运行程序/安装包/便携包、配套资源及SHA256。当前程序位于 [featherpad.exe](../src-tauri/target/release/featherpad.exe)，仍在迭代，不能把它连同release目录直接删掉后再找程序。
2. [docs/acceptance](acceptance/)的正式验收说明、[PROGRESS](../tasks/PROGRESS.md)、关键结果JSON、必要截图和真实故障证据。可以由用户另存归档，再清理重复fixture和浏览器缓存。
3. [.artifacts/delivery-validation.json](../.artifacts/delivery-validation.json)仍被[交付检查](DELIVERY-CHECK.md)引用；若移动或清理证据，应同步更新引用，不能制造失效链接。其他进度记录中的.artifacts路径也同样处理。
4. 测试profile中的恢复正文/原件应先确认只是fixture，且没有混入用户真实未保存内容；未经确认不清理恢复目录。

## 5. 不应误删的内容

- [src](../src/)、[src-tauri/src](../src-tauri/src/)、[tests](../tests/)、[scripts](../scripts/)：产品源码、测试源码、可复现夹具及开发脚本。**测试源码不是应删除的测试垃圾。** 当前tests只有约152KiB。
- [docs](./)、[design](../design/)、[tasks](../tasks/)：规格、验收、设计和交接记录，总体很小。
- [package.json](../package.json)、[pnpm-lock.yaml](../pnpm-lock.yaml)、[Cargo.toml](../src-tauri/Cargo.toml)、[Cargo.lock](../src-tauri/Cargo.lock)及构建配置：保留才能复现工程。
- [.git](../.git/)、签名证书/密钥、环境配置与真实用户数据：不能因为被gitignore忽略就认为可删除。
- 真实恢复草稿、便携data目录、AppData用户配置：没有本次可清理结论。

## 6. 开发完成后的复核顺序

1. 确认开发agent、构建、测试、FeatherPad及其WebView2进程均已结束。
2. 重新盘点大小和归属，因为本清单是2026-11-01的快照。
3. 保存最终可运行交付物和必要验收证据。
4. 由用户优先处理测试大文件与过期WebView2 profile，再视是否保留开发能力决定debug、release中间产物、node_modules和dist。
5. 若继续开发或回归，预计相关数据会再次生成；保留测试源码与锁文件。

本文不包含自动删除脚本；agent不得将“开发完成后可清理”理解为用户已授权自动清理。本次没有盘点或清理工程外的`E:\Codeing\featherpad-dev`共享缓存，不应把它与项目内临时目录一起处理。
