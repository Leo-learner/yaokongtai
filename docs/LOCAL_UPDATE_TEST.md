# Sparkle 本地升级验证

项目锁定 Sparkle 2.9.2。`mac-agent/project.yml` 将 Debug Feed 设为 `http://localhost:3300/updates/appcast.xml`，Release Feed 设为 `https://control.dkz12345.com/updates/appcast.xml`。`SUPublicEDKey` 是公开验证密钥；私钥由 Sparkle `generate_keys` 存在开发者登录钥匙串中，不得导出到仓库。

本地测试流程：构建并签名版本 1 和版本 2，把版本 2 压成 ZIP 放在中继本地 `apps/web/dist/updates/` 下；运行 Sparkle 2.9.2 的 `generate_appcast --download-url-prefix http://localhost:3300/updates/`，生成带 EdDSA 归档签名和 Feed 签名的 `appcast.xml`。启动 Debug 版本 1，点击菜单栏“检查更新”，核对下载、签名验证、安装前提示及更新后配对状态。`dist/`、测试 ZIP 和 Appcast 均被 Git 忽略。

本轮已构建并签名两个本地版本；`sign_update --verify` 验证了 Feed 和 ZIP，localhost 对两者均返回 HTTP 200。菜单栏触发的自动检查、下载、安装前提示以及安装后配对保持尚未完成真机验证，因此不能据此认定升级链路通过。安装前请在测试 Mac 上按上段步骤完成这些检查。

任何修改 Appcast、ZIP 或发布说明后都必须重新签名。不要把本地测试 Feed 上传到生产域名。
