轻羽 FeatherPad - 便携版
==============================

运行：双击 featherpad.exe。

便携模式由本目录中的 portable.flag 明确启用。运行时，设置、恢复副本、
会话、最近记录和授权信息写入 featherpad.exe 同目录的 data\，不会与安装版
共享状态。

请将整个目录放在当前用户可写的本地目录。将该目录设为只读、放在只读介质，
或让 data\ 成为链接/重解析点时，轻羽会拒绝启动并说明原因，不会回退到用户
默认应用数据目录。

命令行示例：
  featherpad.exe README.md
  featherpad.exe --new-window README.md
  featherpad.exe --goto "README.md:12:3"
  featherpad.exe --reuse-window --wait README.md
  featherpad.exe --help
  featherpad.exe -- .

Windows 集成默认关闭。可在“设置 -> 系统”中显式启用“打开方式”候选和
Explorer 右键菜单；不会修改 Windows 默认应用或 UserChoice。

运行需要 Microsoft Edge WebView2 Evergreen Runtime。缺失时程序会显示官方
安装指引，不自动联网下载：
https://developer.microsoft.com/microsoft-edge/webview2/#download-section

本包是未签名内部试用版。Windows SmartScreen 可能提示未知发布者。
