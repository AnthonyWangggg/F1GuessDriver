# Driver Guess 3.0 架构

- `apps/web` 使用 Vue 3.5、Vite、Vue Router 和 Pinia。通过同源 API 访问游戏、账号和积分。
- `apps/server` 使用 Fastify 与 Zod。快速游戏、每日挑战和 BO3 由服务端验证、记录和结算。隐藏答案在符合终局条件后公开。
- `packages/shared` 保存 API 契约及跨端公共类型。`packages/database` 保存 Drizzle Schema 和 PostgreSQL 迁移。旧对局使用创建时锁定的数据和规则版本。
- 题库由离线数据工具导入和核验，猜测请求读取已发布快照。数据来源与再分发范围见 [数据许可](../DATA-LICENSES.md)。
- STG 与 PROD 使用独立的运行配置、应用角色、数据库和探针身份。制品和发布回执分别标识应用提交、制品和运行环境。

[BO3 状态机](BO3-STATE-MACHINE.md)说明匹配和系列赛转换。[开发验证](../verification.md)列出规则、权限、数据库、浏览器和发布门禁检查。
