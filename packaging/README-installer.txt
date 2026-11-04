轻羽 FeatherPad - Windows 安装版
==============================

安装程序仅安装到当前用户目录，不要求管理员权限。安装后可从开始菜单或
应用安装目录运行 featherpad.exe。

卸载会移除程序文件和快捷方式，但按设计保留：
  %LOCALAPPDATA%\app.featherpad.desktop

该目录可能包含用户设置、收藏和最近记录、恢复副本、保存事务及会话授权。
默认卸载不会删除用户文档和这些应用数据。若在卸载界面选择清除数据，必须
再次确认放弃未保存内容的恢复副本；检测到链接或被占用项会保留并提示，
不会跟随链接删除其他目录。升级保留数据和集成设置。

运行需要 Microsoft Edge WebView2 Evergreen Runtime。安装程序不会捆绑或
静默下载 Runtime；缺失时会显示官方安装指引：
https://developer.microsoft.com/microsoft-edge/webview2/#download-section

Windows 文件关联和 Explorer 右键菜单默认关闭，可在“设置 -> 系统”中显式
启用或撤销。程序不会修改 Windows 默认应用或 UserChoice。卸载只撤销仍精确指向本安装程序的自有项，第三方改写的项保留。

非便携安装版与 portable.flag 启用的便携版使用彼此隔离的数据目录。

本安装包是未签名内部试用版。Windows SmartScreen 可能提示未知发布者。

M5候选版安装目录附带 docs/ 用户指南、恢复指南、候选说明和第三方许可证。
内部交付另附 THIRD-PARTY-SOURCES.zip。G5未通过前不称完整v1；
Win10和4核/8GB目标环境尚未实测。
