# Driver Guess 2.0 实施与分批发布方案

本轮授权范围：整体设计、阶段 A 本地实现/验证、隔离数据库测试、候选准备。未授权生产数据库变更、Migration、切流、Nginx/systemd 变更或 push。A/B/C 分别生成候选、manifest、审批及回滚记录。沿用 Vue 3.5 / Fastify / PostgreSQL / rolling，不另建游戏引擎或微服务。

## A：独立展示本地化

使用稳定 `jolpica:driver:*` / `jolpica:constructor:*` 为键的随应用发布的本地配置。字段包括中文展示名、别名、来源、可信状态；未经核实保留英文。不将中文名用于身份、答案选择、属性比较或胜负判断。Wikidata 的 CC0 中文标签只能作为可追溯的社区译名，不能称官方译名；身份链接缺失、重定向无法确定或仅有外文标签时不自动猜译。保留原有所有者确认的三个译名。

前端对搜索、已猜记录、终局资料、时间线和旧版车队集合统一执行展示回退。搜索在服务端把配置别名命中转换为稳定 ID，再与锁定版本的 eligible 记录取交集，过滤后排序/限制数量。输入规范化支持大小写、全半角、重音、中点、空格及常见标点；同姓返回多个不同 ID。保留已有数据库英文/中文别名搜索，不改写存量别名或历史统计。

数据库：无 Schema、Migration 或数据写入。API：保持现有字段/contract v1/v2/v3，响应展示字段可汉化，持久化猜测 JSON 不变；旧后端依然可响应新前端，显示通过本地配置回退。旧前端继续消费原字段。现有 rolling 的 server 操作只切 API，web 操作只切静态根；A 是同一业务发布批次中的两个可回退步骤，先 API、验收旧客户端，再静态、验收新客户端。新前端配旧 API 时新增中文别名搜索不可承诺可用，应记录该降级。

切换前记录完整原 State、原 web/server ID 和各自准确 manifest SHA，以及 A 两步后的 State。回退先按批准清单恢复原 web，再恢复原 server，保留同一 dataset；无需数据库回滚。不能假设连续两次 `rollback auto` 会跨越两步返回原 State：该命令只维护最近一次 previous/next，第二次可能重新切回新版。生产执行前把真实原 ID/SHA 绑定到回滚计划，候选设计文档中的占位信息不构成可执行发布批准。

## B：每日一题（本轮仅设计）

- `daily_challenges`：`challenge_date date PK`（北京时间）、`answer_driver_id FK`、`dataset_version FK`、`rules_version`、`max_attempts=8`、`created_at`。日期唯一；在事务中 `INSERT ... ON CONFLICT DO NOTHING` 后读取胜出行。选择使用普通难度既有答案池与比较器，不把答案放入公开 DTO。
- `daily_entries`：`id UUID PK`、`challenge_date FK`、`owner_hash`、`status`、`attempts_used`、`completed_at`、`outcome`；`UNIQUE(challenge_date, owner_hash)`。使用独立状态表隔离旧二进制的普通游戏入口，复用匿名身份、纯比较器、锁定版本读取及 DTO 构造；不复制比较算法。`daily_guesses` 保存按 entry 唯一的尝试序号、driverId 和已公开反馈，`UNIQUE(entry_id,driver_id)` 防重复。创建 entry、绑定当日 challenge 同事务，冲突时读取已有记录。不能由客户端指定答案日。
- 事务内取数据库时钟并计算 `(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date`。创建当前日 entry 时锁定对应 challenge；创建和猜测在取得行锁后重新检查日期，不能用事务开始时被冻结的时间绕过午夜。以持锁后执行猜测检查时刻为接受边界，跨午夜仍在等待锁的猜测返回 `DAILY_EXPIRED`，不得消耗新日次数；截止前已检查并执行的事务允许正常提交。旧日已完成可读取，新日另建。日期、答案、规则、统计版本均永久固定。
- `daily_submissions`：请求幂等键与 entry 唯一，保存已公开响应/请求摘要；同键不同 driverId 返回冲突，同键重试返回原响应。与猜测及结算同事务。终局只记一次，刷新只 GET 恢复。普通游戏创建接口不得替换正式 daily entry。
- 统计基础：从终局 entries 查询每日参与/成功/尝试分布，连续参与以北京时间不同日期去重计算；必要时添加独立只增计数表，不引入账号。公开统计不得包含答案 ID、未结束的猜测姓名或可推断答案的明细。匿名 Cookie 删除/换设备可获得新访客身份，首版不能声称跨身份防刷。
- API：`GET /api/daily`（日期和规则元信息）、`POST /api/daily/entry`（恢复或幂等创建）、`GET /api/daily/entries/:id`、`POST .../:id/guess`、`GET /api/daily/statistics`。复用 origin/Cookie/所有者验证和输入 schema；新功能独立 contract，不放宽普通 v3 门禁。普通 game_sessions 不存 daily 局，普通 guess/reveal 路径无法访问每日进度。回退后的旧二进制不认识新路径，但保留新表和全部记录，恢复新版即可继续读取锁定版本。

必测：UTC+8 午夜前后、闰日、事务跨日期、两实例并发建题/建 entry、同人重复请求、重复猜测不扣次数、并发最后一次、旧日/旧版本恢复、Cookie 所有者隔离、普通接口不可操作 daily、答案不泄露、统计只结算一次。

## C：随机匹配（本轮仅设计，以下公平规则须在实施前审核）

拟定首版规则：双方普通难度、同题、各 8 次，开局后统一 10 分钟。双方终局或截止时间结算；一方猜中优于未猜中；双方猜中以更少次数胜，同次数平局；双方未猜中为平局。不以毫秒响应先后作胜负依据。猜中后自己的进度锁定，但答案与终局资料要等整场结算后才公开，避免向另一方通报答案；客户端不提供主动揭晓。猜错 8 次只锁定本人，等待对方或统一截止。对手进度只含次数、反馈颜色和完成标记，不含 driverId、姓名、数值、箭头、constructor ID、时间线或原始反馈 JSON。猜中状态本身也不提前公布，只显示该方已完成。

排队最长 120 秒；取消与配对竞争以数据库事务先提交者为准。掉线不自动判负，不暂停时间，不补次数；同 Cookie 重连/刷新恢复。超过截止时间的请求先执行幂等结算，再返回终局。截止时间由数据库时钟计算，猜测须在取得 match/player 锁后检查。两人终局即时结算；一个已猜中者在整场结束前也不能从普通资料 API 读取答案。

状态机：`queued → matched | cancelled | expired`；`match: active → finished`；`player: playing → locked`（猜中/耗尽/到时）。终局结果 `win/loss/draw` 独立保存，`settled_at` 非空后不可重结算。没有跨进程内存权威。

新增表（expand-only）：

- `match_queue`：owner_hash、状态、expires_at、match_id；partial UNIQUE(owner_hash) WHERE status='queued'；按创建时间和 ID 索引，`FOR UPDATE SKIP LOCKED` 选另一个身份；每人一个活动匹配的约束通过独立 `match_memberships(owner_hash PK, match_id FK)` 保证，取消/到期/结算事务内释放。
- `matches`：UUID、状态、answer_driver_id、dataset_version、rules_version、starts_at、deadline_at、revision、settled_at、结果。
- `match_players`：PK(match_id,owner_hash)、slot UNIQUE(match_id,slot)、status、attempts_used、solved_at；两名不同身份由 membership/唯一约束和事务验证。
- `match_guesses`：PK(match_id,owner_hash,attempt_number)、UNIQUE(match_id,owner_hash,driver_id)、原始反馈服务端私有；对手 DTO 使用显式白名单。
- `match_requests`：UNIQUE(owner_hash,idempotency_key)，请求摘要与公开响应；与入队/取消/猜测/结算同事务。限流复用入口并增加数据库 owner 操作时间窗，防止通过两个实例绕过进程内限流。

所有修改锁顺序固定 match → player，匹配采用 owner 排序锁/事务级 advisory lock 防止重复入队和死锁，失败事务有限重试。API：`POST/DELETE /api/matchmaking/queue`、`GET /api/matchmaking/state`、`GET /api/matches/:id`、`POST .../:id/guess`。新 contract 独立版本；旧后端不认识新路径，灰度时前端必须读取能力并显示稍后重试，不能把新功能请求转为普通局。

首版选 HTTP 短轮询（活跃时约 2 秒，后台页面退避至 10 秒，加随机抖动）。GET 读取 PostgreSQL 递增 revision，使用私有 `ETag/If-None-Match` 和 `Cache-Control: private,no-cache`，不得通过共享缓存混淆访客。两槽均可读同一局；502/503/连接中断后指数退避、重新携 Cookie 恢复，POST 携同一幂等键。无需 WebSocket/SSE、Redis、Nginx 长连接改造。轮询使每次 HTTP 请求受现有有限排空流程保护，浏览器会自然建立新实例连接。禁止依赖某一进程事件总线或连接持有权。

验证：两个真实隔离实例共用测试 DB，排队/配对/重复提交、两个 owner 自匹配拒绝、越权拒绝、截止/取消竞态、终局一次、前后台重连、响应白名单、两槽切换时 POST 重试不双扣、旧 v1/v2/v3 局完整恢复；离线超时通过按需收敛与启动时/定时扫描实现，扫描器多实例 SKIP LOCKED 幂等运行，进程内定时器只触发收敛，不能作为唯一状态保存。

## 每个阶段的发布条件

1. 本地验证按范围 dry-run，执行必要检查；迁移/认证变化 Full。记录 PASS/FAIL/NOT_RUN/BLOCKED 及时间，不沿用历史通过。
2. 实时 publication/许可门禁；四项暂缓问题保留，未批准的数据不能被本地化名义放行。
3. 固定 Linux 构建机上构建、封存不可变产物，执行 inspect，再计算**实际 manifest 字节 SHA256**。Windows 构建不能冒充 Linux 候选。没有 Linux 环境则明确 BLOCKED，不编造 SHA。
4. B/C 的迁移单独审核/备份/生产批准；仅 expand-only。验证旧二进制对新 Schema、已有普通局读写无影响，新功能关闭后旧程序可运行；回退不删除新表或新对局。A 无迁移。
5. 保存准确候选 ID/SHA、当前/previous 回滚目标、能力开关、兼容矩阵；取得该阶段单独发布批准，再用现有 rolling 系统切换。B/C 回退时保留全部新局，可暂时关闭新功能而不可用旧表回滚脚本删除记录。
6. 公网检查 HTTPS/API/Cookie、更新前 v3 恢复、新功能与资源缓存；记录准备/上传/启动/收敛/排空/验收耗时和资源/错误。独立记录失败及恢复，不宣称无条件零停机。
