# Driver Guess 3.0

Driver Guess 3.0 已正式上线，生产生命周期为 `PUBLIC_VERIFIED`。正式站点为 [f1driverguess.online](https://f1driverguess.online/)。

这是一款 F1 历史车手猜谜游戏。3.0 支持快速游戏、每日挑战和 BO3，以及账号、积分与排行榜。服务端保存答案和对局状态，每局绑定数据快照及比较规则版本。STG 与 PROD 独立运行。线上应用按已验收制品标识，未来 GitHub `main` 的提交标识可能与线上应用不同。

## 本地开发

使用 Node.js 24（>= 24.12，< 25）、pnpm 11.25.0，以及支持本地测试隔离的 PostgreSQL 18。

```sh
pnpm install --frozen-lockfile
pnpm build
```

将 `apps/server/.env.example` 复制为 `apps/server/.env`，只填本机配置。无需数据库即可启动并检查进程存活。完整游戏需要应用角色、兼容的迁移和经过认证的历史快照，按 [数据库说明](docs/P1-database.md) 与 [3.0 架构](docs/v3/architecture.md) 准备独立开发库。

```sh
pnpm dev
```

前端默认在 `http://127.0.0.1:5173`，Vite 代理同源 `/api` 到后端。后端默认提供 `http://127.0.0.1:3000/api/health`，用于检查进程存活。若调整后端端口，可在 `apps/web/.env` 配置 `API_PROXY_TARGET`。共享包源码变更后重启开发服务以重新构建。

## 验证与维护

- [3.0 文档索引](docs/v3/README.md)
- [STG、PROD 与回退](docs/v3/deployment.md)
- [验证等级、数据库夹具与 Full 验收](docs/verification.md)
- [仓库公开范围与门禁](docs/repository-policy.md)

日常修改使用 `pnpm verify:quick`，阶段验收使用 `pnpm verify:standard`。正式发布前先用 `pnpm verify:full --dry-run` 查看计划，再执行 Full。公开候选需要通过实时 `pnpm security:scan` 和 `pnpm publication:check`，并获得与文件摘要绑定的所有者审批。

## License / 许可证

本项目所有者的原创源代码采用 [MIT License](LICENSE)，Copyright (c) 2026 WONTONANTI。范围包括原创 Vue/Fastify 代码、游戏比较算法、UI/CSS、TypeScript 脚本、测试及工程配置；复制或嵌入的第三方内容继续遵守原许可。

第三方程序依赖按各自许可证使用，见 [依赖清单](docs/licenses/dependencies.json) 与 [第三方许可声明](docs/licenses/THIRD_PARTY_NOTICES.txt)。F1DB、Jolpica/Ergast 数据、混合历史证据与派生数据不由本项目 MIT 重新授权，公开范围、署名、非商业及同许可要求见 [数据许可边界](docs/DATA-LICENSES.md)。38 个国旗 SVG 保留 lipis/flag-icons 作者署名和独立 MIT 许可，见 [素材来源](data/ui/ASSETS.md)。

这是独立粉丝项目，不暗示得到 Formula 1 官方认可。F1、Formula 1 和车队名称相关商标权利不由本项目 MIT 许可证授予。采用源码 MIT 不等于批准全部文件公开，也不等于授权 commit、push 或部署。
