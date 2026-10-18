# F1 Driver Guess

F1 历史车手猜谜游戏。Vue 3.5 前端与 Fastify 后端提供三种难度、版本化八项反馈、匿名会话、刷新恢复及终局资料；答案和胜负判断保存在服务端，每局锁定数据与规则版本。

项目已完成主要开发和私有部署。软件依赖、数据与品牌审核由所有者确认通过，具体范围以保留的审批证据为准。ICP 管理局审核预计 2026-10-16 完成，尚未确认通过。本次仓库整理不授权首次 GitHub 上传或正式公网发布。

维护从 [维护指南](docs/maintenance.md) 和 [部署入口](deploy/README.md) 开始；历史报告及生产绑定材料保留本地。早期部署文档描述其编写时的阶段，不作为当前服务器状态证明。

## 环境与启动

- Node.js 24 LTS（>= 24.12，< 25）
- pnpm 11.25.0（可通过 `corepack enable` 与 `corepack prepare pnpm@11.25.0 --activate` 配置）
- PostgreSQL：P1 需要；P0 启动和健康检查不要求已有数据库。

在根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm build
```

复制根目录 `.env.example` 为 `apps/server/.env`，按本机配置修改，然后运行：

```sh
pnpm dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:3000/api/health
- Vite 将 `/api` 转发到后端。修改后端端口时，在 `apps/web/.env` 设置 `API_PROXY_TARGET=http://127.0.0.1:新端口`。
- `/api/health` 返回 `{"status":"ok"}`，表示服务存活，不表示数据库就绪。
- shared / database 使用构建后的 ESM 文件，`pnpm dev` 自动构建这些包；修改包源码后需重启开发服务。
- `pnpm start` 启动构建后的后端；`pnpm --filter @f1/web preview` 预览前端构建（预览不提供 API 代理）。
- Ctrl+C 停止开发服务，后端处理 SIGINT / SIGTERM 并关闭 Fastify。

## 验证

```sh
pnpm type-check
pnpm lint
pnpm format:check
pnpm build
pnpm test
```

`pnpm test` 自动构建 shared 和 database，覆盖历史数据、游戏规则、API 安全和 Vue 交互。普通测试未配置 `TEST_DATABASE_URL` 时跳过数据库项；用 `pnpm test:database` 和 `pnpm test:game-database` 显式连接当前数据库，使用隔离临时 Schema 验证。

`pnpm test:e2e` 自动启动本地前后端，执行 Playwright 模拟异常与真实数据库浏览器流程。Windows 默认使用已安装的 Edge；其他平台默认 Chromium（先执行 `pnpm exec playwright install chromium`）。可通过 `PLAYWRIGHT_CHANNEL` 指定浏览器渠道。真实流程要求 `.env` 或 `apps/server/.env` 中配置有效数据库及 P1 快照，会创建实际匿名测试对局，不会修改历史数据。

首页 `/` 选择难度；游戏 `/game/:id` 搜索、选择、提交车手。刷新读取原有对局；本地仅保存游戏 ID，匿名 Cookie 由浏览器管理。保持使用 `127.0.0.1:5173` 同源代理；Cookie 被清除后须开始新游戏。正式部署与维护从 [维护指南](docs/maintenance.md) 和 [部署入口](deploy/README.md) 开始。

## 项目结构

```text
apps/
  web/          Vue 3.5 / TypeScript / Vite / Router 4 / Pinia / Tailwind 4
    src/
      components/         导航、搜索、属性表格、结算
      router/             首页、游戏、404 路由
      services/           同源 API 客户端与共享契约校验
      stores/             Pinia 游戏状态与恢复
      styles/             原创 F1 风格与响应式布局
      views/              首页、游戏、404、组件测试
  server/       Fastify / TypeScript / Zod
    src/
      config/             环境配置校验
      routes/             健康检查、游戏与只读数据接口
      app.ts              可注入测试的应用工厂
      index.ts            启动与退出
packages/
  shared/       前后端公共类型与 Zod API 契约
  database/     PostgreSQL + Drizzle Schema、Migration、连接与查询
  noop-logger/  原创兼容日志实现及独立 MIT
scripts/        历史数据导入、统计、校验与数据库环境检查
data/           已审核中文种子、constructor 别名策略、历史审核、参考校验
tests/          固定历史样本与 PostgreSQL 集成测试
docs/           P1 数据库、P2/P3 API 操作说明
deploy/         通用模板与本地运维索引（阶段工具保留原路径）
```

TypeScript 启用 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes。数据库连接工厂按需创建，调用方负责 `close()`，不会自动迁移。P1 操作说明见 [docs/P1-database.md](docs/P1-database.md)。开发报告保留在本地，不随公开仓库发布。

## License / 许可证

本项目所有者的原创源代码采用 [MIT License](LICENSE)，Copyright (c) 2026 WONTONANTI。范围包括原创 Vue/Fastify 代码、游戏比较算法、UI/CSS、TypeScript 脚本、测试及工程配置；复制或嵌入的第三方内容继续遵守原许可。

第三方程序依赖按各自许可证使用，见 [依赖清单](docs/licenses/dependencies.json) 与 [第三方许可声明](docs/licenses/THIRD_PARTY_NOTICES.txt)。F1DB、Jolpica/Ergast 数据、混合历史证据与派生数据不由本项目 MIT 重新授权，公开范围、署名、非商业及同许可要求见 [数据许可边界](docs/DATA-LICENSES.md)。38 个国旗 SVG 保留 lipis/flag-icons 作者署名和独立 MIT 许可，见 [素材来源](data/ui/ASSETS.md)。

这是独立粉丝项目，不暗示得到 Formula 1 官方认可。F1、Formula 1 和车队名称相关商标权利不由本项目 MIT 许可证授予。采用源码 MIT 不等于批准全部文件公开，也不等于授权 commit、push 或部署。

## 开发边界

通用配置与备份恢复参考见 [生产配置与备份恢复](docs/production.md)、[仓库文件政策](docs/repository-policy.md)。`pnpm release:check` 生成并检查隔离发布包，`pnpm security:scan` 检查候选/跟踪/历史秘密。备份、恢复、真实数据测试均需独立操作授权；本项目不会自动提交、推送或部署。

P4-B 的跨浏览器、axe、独立视觉与本机 HTTPS 生产包验收入口见 [验收说明](docs/p4-b-acceptance.md)。`pnpm release`、`pnpm security` 提供统一检查；真实移动设备和 Linux Nginx/systemd 验收仍需另行执行。

首次公开提交先执行 `pnpm publication:check`，查看 [许可证与发布门禁](docs/publication-audit.md) 和 [Linux预演/更新回滚/实机清单](docs/deployment-rehearsal.md)。目标仓库为 https://github.com/AnthonyWangggg/F1GuessDriver 。项目代码许可由所有者决定；Jolpica API 数据具有非商业和同许可限制，不能以第三方代码许可证替代。`pnpm licenses:inventory` 汇总依赖声明；缺失证据可用 `pnpm licenses:evidence` 从版本对应的官方提交补查，不能确认的仍阻止公开。技术检查不授予 commit、push 或部署权限。

游戏调用方式见 [docs/P2-api.md](docs/P2-api.md)。公开源码与运行发布包是不同范围；本地 `release/latest.txt` 不代表实际生产版本。Windows 包不能代替 Linux 平台构建与验收。

规范文件为 `AGENTS.md`。红色用于品牌，属性反馈使用绿 / 黄 / 灰。阶段运维目录从公开候选隔离，但仍保留原始工具、审批与哈希证据；不能根据目录名认定其中脚本已废弃。

## 开发验证入口

Driver Guess 2.0 的分阶段方案见 [技术与发布方案](docs/driver-guess-2.0-plan.md)，汉化覆盖、来源与英文回退见 [本地化说明](docs/localization.md)。`pnpm localization:audit` 只读核对固定 v3 的 784 人；`pnpm test:localization` 在本机开发库和既有独立测试库的全新 Schema 中运行 Full，保留测试证据，不操作生产。`--targeted` 仅运行新增本地化/旧局兼容用例，不代表完整发布验收。

日常改动使用 `pnpm verify:quick`，阶段验收使用 `pnpm verify:standard`，正式发布前先审阅 `pnpm verify:full --dry-run`。没有首次提交时，迭代开始前用 `pnpm verify:baseline` 保存比较基线（不是验收通过）。范围、缓存、安全门禁及限制见 [开发验证说明](docs/verification.md)。
