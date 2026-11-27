# 更新签名密钥与发布流程

本文记录轻羽 FeatherPad 安装版的 Tauri 更新签名密钥生成、公钥配置、GitHub Secrets 设置、本地签名构建和 Tag 发布流程。适用于当前 `1.0.0` 及后续版本。

## 1. 适用范围与安全边界

- 自动更新仅面向 Windows 安装版。便携版不执行自动安装，只提示从 GitHub Releases 手动下载新版本。
- Tauri 官方 updater 强制校验 minisign 更新签名，不能关闭。公钥随应用发布，私钥和口令只存放在发布环境。
- 更新签名不是 Windows Authenticode 代码签名。安装包仍未做 Authenticode 签名，SmartScreen 提示仍可能出现。
- 私钥或口令丢失后，已经安装的用户将无法继续验证后续更新。必须在安全位置备份私钥和口令，不能提交到仓库。
- `0.1.0` 没有更新器，首次升级到 `1.0.0` 必须手动安装一次。

## 2. 前置条件

- Windows 开发机，已按项目 README 初始化 Node、pnpm、Rust、MSVC 和 Windows SDK。
- 已登录 GitHub CLI，并具有目标仓库的 Secrets 写权限：

```powershell
gh auth status
```

- 仓库为 `Colorful-black1/FeatherPad`，默认分支为 `main`。
- 需要修改或核对以下文件：

| 文件 | 作用 |
|---|---|
| `src-tauri/tauri.conf.json` | updater 更新地址、公钥和 Windows 安装模式 |
| `src-tauri/tauri.updater.conf.json` | 仅发布构建启用 `createUpdaterArtifacts` |
| `.github/workflows/build.yml` | Tag 发布与手动构建 |
| `src-tauri/windows/installer-hooks.nsh` | 普通安装要求关闭应用；`/UPDATE` 交给 Tauri 更新流程 |
| `scripts/ci/package-release.ps1` | 打包安装器、便携包、签名和校验和 |
| `scripts/ci/updater-manifest.mjs` | 生成 Release 使用的 `latest.json` |

## 3. 一次性生成密钥

在 PowerShell 中初始化项目环境：

```powershell
Set-Location 'E:\Codeing\ai-workspace\featherpad'
. .\scripts\Enter-Dev.ps1
```

在仓库外创建密钥目录并生成密钥对：

```powershell
New-Item -ItemType Directory -Path 'C:\Users\abcd\.tauri' -Force | Out-Null

pnpm tauri signer generate -w 'C:\Users\abcd\.tauri\featherpad.key'
```

命令会提示输入两次口令。口令应使用密码管理器保存，并与私钥分开备份。

生成结果：

```text
C:\Users\abcd\.tauri\featherpad.key       私钥，绝不能提交或发送
C:\Users\abcd\.tauri\featherpad.key.pub   公钥，可以提交
```

如果目标文件已存在，命令不会自动覆盖。先确认旧密钥是否仍需保留，不要随意使用 `--force`。

查看公钥：

```powershell
Get-Content -Raw 'C:\Users\abcd\.tauri\featherpad.key.pub'
```

只复制公钥。不要打印、截图或粘贴私钥内容。

## 4. 把公钥写入 Tauri 配置

打开 `src-tauri/tauri.conf.json`，把 `plugins.updater.pubkey` 设置为公钥文件内容。也可以执行：

```powershell
node -e "const fs=require('fs'); const p='src-tauri/tauri.conf.json'; const c=JSON.parse(fs.readFileSync(p,'utf8')); c.plugins.updater.pubkey=fs.readFileSync('C:/Users/abcd/.tauri/featherpad.key.pub','utf8').trim(); fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');"
```

检查配置中不再存在占位符：

```powershell
Select-String -Path src-tauri/tauri.conf.json -Pattern 'pubkey'
```

前端在构建时根据该公钥计算更新功能是否已配置。只改配置而不重新构建时，已有安装仍会显示“自动更新尚未启用”。

## 5. 配置 GitHub Secrets

私钥内容和口令分别写入两个仓库 Secrets。公钥不需要写入 Secret。

写入私钥：

```powershell
Get-Content -Raw 'C:\Users\abcd\.tauri\featherpad.key' |
  gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Colorful-black1/FeatherPad
```

写入口令，按 GitHub CLI 提示输入：

```powershell
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Colorful-black1/FeatherPad
```

确认名称已存在：

```powershell
gh secret list --repo Colorful-black1/FeatherPad
```

应看到：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

不要把私钥或口令写入命令历史、日志、提交、Issue 或聊天。需要更换密钥时，先保留旧密钥，直到所有仍在使用旧公钥的版本都停止更新。

## 6. 本地签名构建验证

设置本地签名环境变量。口令使用隐藏输入，避免出现在命令历史：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path 'C:\Users\abcd\.tauri\featherpad.key').Path

$secure = Read-Host -AsSecureString '更新签名口令'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $secure).Password
```

执行带 updater 产物的 NSIS 构建：

```powershell
pnpm tauri build --bundles nsis --ci `
  --config (Resolve-Path 'src-tauri/tauri.updater.conf.json').Path
```

成功后检查安装器和签名：

```powershell
Get-ChildItem src-tauri\target\release\bundle\nsis\*-setup.exe,
  src-tauri\target\release\bundle\nsis\*.sig |
  Select-Object Name, Length
```

至少应有一个 `*-setup.exe` 和同名 `.sig`。验证完成后清除当前 PowerShell 会话的环境变量：

```powershell
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Remove-Variable secure
```

说明：基础配置 `src-tauri/tauri.conf.json` 不开启 `createUpdaterArtifacts`，因此没有本地密钥时仍可执行普通开发/安装构建。只有 Release 构建通过 `src-tauri/tauri.updater.conf.json` 开启 updater 产物和签名。

## 7. 发布流程

发布前确认：

- 工作区已有公钥配置，且已提交到将被打 Tag 的提交。
- GitHub Secrets 已配置。
- `src-tauri/tauri.conf.json` 的版本与准备推送的 Tag 数值一致。
- 安装器/便携包不需要用户数据；不要提交 `src-tauri/target`、`dist` 或其他构建输出。

Tag 规则：

- 推荐使用完整版本 Tag，例如 `v1.0.0`。
- `v1.0` 会按 `1.0.0` 处理；`v1.0.1` 在应用版本仍为 `1.0.0` 时会被拒绝。
- 普通分支 push 不会触发发布；只有 `v*` Tag 或手动 `workflow_dispatch` 会构建。

推送代码和 Tag：

```powershell
git push origin main

git tag v1.0.0
git push origin v1.0.0
```

Tag 推送后，`.github/workflows/build.yml` 会：

1. 校验 Tag 与应用版本、检查同名 Release 是否已存在。
2. 使用 Node、pnpm、Rust 和签名 Secrets 构建 NSIS 安装器与 updater 签名。
3. 上传 Actions Artifacts（保留 30 天）。
4. 创建 draft Release，上传安装器、签名、便携包、`latest.json`、校验和和构建信息。
5. 全部上传成功后才发布 Release；同名 Release 已存在时明确失败，不覆盖、不删除。

手动在 Actions 页面运行时：

- 可以选择分支、Tag 或提交 SHA，默认 `main`。
- 只上传 Actions Artifacts，不创建 Release。
- 缺少签名密钥时仍可生成普通安装包，但不会生成可自动更新的发布包。

## 8. Release 产物

Tag 发布完成后，Release 中应包含：

```text
FeatherPad_<version>_x64-setup.exe
FeatherPad_<version>_x64-setup.exe.sig
FeatherPad_<version>_x64-portable.zip
latest.json
SHA256SUMS.txt
BUILD-INFO.txt
```

`latest.json` 是安装版自动更新的入口，默认地址为：

```text
https://github.com/Colorful-black1/FeatherPad/releases/latest/download/latest.json
```

它由发布 job 根据 `.sig` 和 `docs/RELEASE-NOTES.md` 生成，并同时提供 `windows-x86_64` 与 `windows-x86_64-nsis` 平台条目。

## 9. 验证与排障

### 应用内验证

- 设置 → 系统 → 关于应显示 `v1.0.0`，且不再显示“自动更新尚未启用”。
- 发布新版本后，安装版启动时自动检查；发现更新后顶部出现更新按钮。
- 便携版不会自动安装，应提示手动下载。

### 发布状态验证

```powershell
gh release view v1.0.0 --repo Colorful-black1/FeatherPad
gh secret list --repo Colorful-black1/FeatherPad
```

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| `failed to decode pubkey` 或关于页显示尚未启用 | `plugins.updater.pubkey` 仍是占位符或前端未重新构建。写入真实公钥后重建。 |
| Tag 构建提示缺少 updater pubkey/私钥 | 公钥或 `TAURI_SIGNING_PRIVATE_KEY`/口令 Secret 未配置。补齐 Secrets 后重新推送新 Tag。 |
| 更新包签名校验失败 | 应用内公钥与 GitHub Secrets 中私钥不匹配。恢复匹配的密钥对并重新构建发布包。 |
| `Release 'v1.0.0' already exists` | 工作流拒绝覆盖已有 Release。使用新版本 Tag，或由维护者明确处理旧 Release。 |
| 找不到 `.sig` 或 `latest.json` | 构建未使用 `src-tauri/tauri.updater.conf.json`，或发布 job 未执行。检查 Tag 构建日志。 |
| 安装后仍无法自动更新 | 当前安装的是 `0.1.0`，或构建时公钥仍是占位符。先配置真实公钥并手动安装一次正式 `1.0.0`。 |
| 便携版没有更新按钮 | 预期行为；便携版请手动下载新版本。 |
| SmartScreen 提示未知发布者 | 安装包没有 Windows Authenticode 代码签名；更新签名不能消除该提示。 |

## 10. 备份与轮换

- 私钥文件和口令必须离线备份，至少保留两份；不要只保存在 GitHub Secrets 中。
- 不要删除仍可能用于回滚或重新签名旧版本的私钥。
- 轮换公钥会影响所有已安装用户。需要先确定旧版本升级路径，不能直接替换公钥后让旧用户“失联”。
- 任何情况下都不要把 `.key`、口令或包含私钥的日志提交到仓库。

## 11. 相关文件

- [GitHub Actions 发布工作流](../.github/workflows/build.yml)
- [Tauri 更新配置](../src-tauri/tauri.conf.json)
- [发布构建配置](../src-tauri/tauri.updater.conf.json)
- [NSIS 安装钩子](../src-tauri/windows/installer-hooks.nsh)
- [Release 资产打包脚本](../scripts/ci/package-release.ps1)
- [更新清单生成脚本](../scripts/ci/updater-manifest.mjs)
- [发布说明](RELEASE-NOTES.md)
- [用户指南](USER-GUIDE.md)
