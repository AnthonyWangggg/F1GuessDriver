# P4-A Linux VPS 准备（未部署）

架构：浏览器 → HTTPS Nginx → 仅监听 127.0.0.1 的 Fastify → 本机 PostgreSQL。单实例限流仍由原 API 实施；扩容必须先设计共享限流，不能直接启动多副本。Windows 本地 PostgreSQL 不受此模板影响。

使用 Node 24、pnpm 锁定工具构建：`pnpm release:check`。`release/latest.txt` 指向新包；Windows 生成包只验证 Windows运行依赖。Linux VPS 必须在 Linux 使用同一锁文件重新生成和验收包，不能直接宣称跨平台原生依赖兼容。同步代码与受检发布包，不同步 `.env`、报告或备份。

模板位于 deploy。准备专用非特权用户 f1guess；生产配置放 `/etc/f1-guess/production.env`，root:f1guess 0640，配置目录 0750，部署代码 root 所有且服务只读。替换域名并独立取得有效证书，确认 `nginx -t`、`systemd-analyze verify`、`curl --fail https://域名/api/health` 和真实游戏/API 流程后才可另行批准上线。模板未在 Windows 假装完成 Nginx/TLS/systemd 演练。

生产必填白名单：NODE_ENV、HOST、PORT、DATABASE_URL、GAME_DATASET_VERSION、COOKIE_SECURE、TRUST_PROXY、ALLOWED_ORIGINS、DB_POOL_MAX、DB_IDLE_TIMEOUT_MS、DB_QUERY_TIMEOUT_MS。启动时按字段名报告错误，不回显值。生产不加载仓库 .env；客户端 envPrefix 为空，没有自定义 VITE_ 公共变量。需要新增公开配置时必须人工登记白名单及测试。

Cookie 沿用 HttpOnly、SameSite=Strict、Path=/api，生产强制 Secure。原 Origin/Fetch Metadata 检查、匿名所有权、事务和答案权限不变。Nginx 覆盖 X-Forwarded-For，仅信任本机代理，8KiB 请求体限制。日志仅记录方法、状态及请求 ID；不记录原 URL、Cookie、Authorization 或数据库堆栈。Nginx 错误日志仍可能含路径，应限制读取及按模板轮换，不公开日志。

使用独立运行角色（NOSUPERUSER NOCREATEDB NOCREATEROLE），仅授予 CONNECT/USAGE、历史表 SELECT、game_sessions/game_guesses 必要 SELECT/INSERT/UPDATE。Migration 和导入使用单独维护角色，备份角色仅有读取权限。不要把当前开发角色直接当成生产权限模型。限制 PostgreSQL 至 loopback，pg_hba 使用 scram-sha-256；生产密码及凭据由站点管理员生成并另行配置，禁止提交。数据库池默认 10，查询超时15秒、空闲回收30秒；SIGTERM 有15秒关闭上限。

## 加密备份与独立恢复

`/api/health` 是存活检查；`/api/ready` 另检查 PostgreSQL 与当前 valid v3 快照，未就绪返回503且不输出连接/答案信息。Nginx 仅让本机监控访问 readiness；可用 `curl --fail http://127.0.0.1:3000/api/ready` 检查。

PostgreSQL 18 custom dump 可能包含 `CREATE SCHEMA public`。空目标已有默认 public，因此工具仅从 pg_restore TOC 清单中排除该条 schema 创建项；不排除表、行、约束或其他 schema，不 DROP 默认 schema。pg_restore 单事务成功后逐表摘要仍须全部一致。目标存在表、视图、序列、函数、自定义类型或额外用户 schema 时拒绝恢复。

`pnpm db:backup` 调用 pg_dump custom 格式，只读取 public/drizzle，采用同一导出事务快照计算各表行数及内容摘要；AES-256-GCM 验证加密包包含 dump 和摘要。密钥32随机字节，独立 key 文件，POSIX 0600/目录0700，Windows 移除 ACL 继承并仅给当前 SID访问。凭据通过子进程环境传递，不出现在 argv/输出中。工具匹配服务端 PostgreSQL 大版本；配置 PG_BIN，示例 Windows 18。

正式 BACKUP_DIR 应位于独立受限磁盘/离线或异地存储，BACKUP_KEY_FILE 放独立安全位置；本地默认 local-private 仅用于演练，密钥与备份不能作为唯一恢复副本保存在同一台主机。记录备份密钥标识并单独托管旧密钥；轮换后保留解密旧备份所需密钥。包处理内存上限512MiB dump，超限失败；大规模生产数据需改用经验证的流式加密方案。无明文临时 dump。

`pnpm db:restore-drill`：在 .env 设置 RESTORE_DATABASE_URL，目标必须为另一个 **空** 的 `f1_restore_test_*` 数据库，由恢复角色拥有。拒绝源库名、非允许前缀及已有用户表的目标；不使用 --clean，不删除任何库。pg_restore 使用单事务、失败退出、no-owner/no-acl。完整认证解密成功后才执行恢复；比较所有 public/drizzle 表的行数与摘要，覆盖历史快照、杆位、时间线、游戏反馈和 revealed。恢复库含私有对局数据，不得公开或用作公开夹具。再次演练需新空库，不会覆盖上一轮。

`pnpm db:restore --file <私有加密包>` 执行同样防护。只通过当前源连接的库名保护还不足以识别所有生产别名，因此真实灾难恢复必须先由管理员在受控环境建立独立测试目标，不得给脚本生产目标。演练报告保存本地 reports/p4-a，仅有表级摘要/计数，不含 owner token 或猜测答案 ID。

建议每日加密备份、保留7个日备份/4个周备份/12个月备份，月度真实恢复演练；容量/法规需要管理员确认。这里只提供轮换建议，脚本不会自动删除备份。若要求更低 RPO，需要 PostgreSQL WAL/PITR 和独立验收，此阶段没有实施。

依据：[PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)、[Fastify](https://fastify.dev/docs/latest/Reference/Server/)、[Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[Node crypto](https://nodejs.org/api/crypto.html)、[pnpm deploy](https://pnpm.io/cli/deploy)。
