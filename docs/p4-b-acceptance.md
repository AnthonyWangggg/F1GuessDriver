# P4-B 本地验收入口与发布前人工检查

仅运行本机测试，不初始化远程仓库、不推送、不部署。先安装锁文件对应的 Playwright 浏览器：`pnpm exec playwright install chromium firefox webkit`。Windows Edge 使用已安装 msedge 通道。`pnpm browsers:probe` 保存本地浏览器版本及启动结果。

本机默认 Firefox 缓存曾报 Windows SideBySide `mozglue` 错误。隔离安装命令：在 PowerShell 设置 `$env:PLAYWRIGHT_BROWSERS_PATH = '<项目路径>/local-private/browser-repair'` 后执行 `pnpm exec playwright install firefox`。本次隔离安装成功，未修改浏览器二进制或系统运行库。不要推断所有机器都需要此处理；原缓存故障的具体系统根因仍未确证。

`pnpm test:e2e:p4b` 构建并运行 Chromium/Firefox/WebKit/Edge 的功能、几何、键盘与 axe 扫描。仅使用 `.env` 中经过目标防护的 RESTORE_DATABASE_URL，专用 39230/39273 端口，不复用开发服务器。真实测试只创建自己的匿名对局，不改用户已有对局。没有恢复目标就失败。可以用 P4B_FIREFOX_EXECUTABLE、P4B_CHROMIUM_EXECUTABLE 指定经过核实的对应浏览器；本机存在私有隔离安装时自动选择。不要用不同主版本的随意浏览器替代已认证环境。

`pnpm test:e2e:p4b:visual` 使用 Windows Edge 通道及独立 P4-B 视觉文件，执行全部原有 57 条流程。`pnpm test:e2e:p4b:visual:create` 仅用于明确审核后的新基线建立。普通模式 updateSnapshots=none。原 tests/e2e 快照和 P4-A 基线全量 SHA256 必须保持不变。P4-B 变化为可读文字颜色加深、显式跳转链接 tabindex 和抽屉模态背景 inert；不能借机扩大容差或重写历史基线。

所有 traces/video/失败截图对真实身份关闭；主动保存的最终画面、axe 结果、版本和匿名化测试摘要在被排除的 reports/p4-b，视觉基线在 local-archive。axe 未完成项需人工检查，零违规不等于完整 WCAG 认证。所有私有报告和图片公开前仍需人工隐私审核。

`pnpm release` 等价于 release:check；`pnpm security` 等价于 security:scan。`pnpm test:production` 读取 release/latest.txt 指向的真实产物，使用恢复库、临时内存自签名证书及仅监听 127.0.0.1 的 Node HTTPS 代理。真实浏览器自动使用 Secure/HttpOnly/SameSite=Strict Cookie，检查猜测、恢复、揭晓、Origin、426、限流、伪造 X-Forwarded-For 和日志脱敏。证书忽略仅作用于本地隔离浏览器上下文，不修改服务端生产安全配置或系统信任库。此入口验证代理逻辑及真实 TLS 传输，不能替代 Nginx、可信公开证书、systemd 或 Linux 原生依赖验收。

## P4-C 前人工验收记录

- 在 Linux 从同一锁文件重建生产包，实际执行 nginx -t、systemd-analyze verify、HTTPS 全流程、SIGTERM 优雅退出及重启后恢复。选择域名/证书/主机需另行授权。
- 真实 iPhone/iPad Safari、Android Chrome：输入法组合输入、真实软键盘、浏览器地址栏动态视口、安全区域、横竖屏、抽屉及页面滚动。记录具体 OS、浏览器版本及设备型号；自动宽度/visualViewport 夹具不是实机。
- NVDA/Windows 与 VoiceOver/iOS 等实际辅助技术：朗读顺序、八项非颜色反馈、状态更新、确认框、抽屉、表格与横向时间线键盘访问；不能仅依据 axe 宣称认证。
- 所有者确认项目许可证和数据再分发依据；创建最小权限生产角色、独立秘密及密钥托管、异地加密备份，并在受控环境完成恢复计划。

浏览器机制依据：[Playwright 浏览器文档](https://playwright.dev/docs/browsers)、[Chrome for Testing 官方清单](https://googlechromelabs.github.io/chrome-for-testing/)。WebKit 的 Safari 风格 UA 不代表测试在 macOS/iOS Safari 上执行。
