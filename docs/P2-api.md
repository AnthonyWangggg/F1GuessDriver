# P2 游戏 API

P3.2-B 已扩展版本化 REST 游戏。默认新局只使用 valid v2 快照，当前为 `f1-2026-10-08-2190d6c32d9f664f`；v1 `f1-2026-10-08-f46cf6e4723d322d` 保留供旧局继续游玩。会话固定数据与规则版本；比较只读取快照，不实时重算历史。

## P3.2-B 契约升级

游戏/猜测响应增加 `rulesVersion`。v1 使用 activeDecades，保留 active/won/lost；v2 使用 polePositions，状态 playing/won/lost/revealed。七项共同字段和比较语义不变，v2杆位也是correct/higher/lower数字比较。历史反馈按各局规则校验并原样读取，不重新解释第八列。

`POST /api/games/:id/reveal` 接收空对象或无body，使用相同Cookie、Origin及限流；行锁事务只允许活跃局结束为revealed，endedAt有值、次数不变、返回GameResponse及正确answer。重复揭晓、猜测已结束局返回409，跨身份404，无身份401。revealed独立于won，可GET刷新恢复。

新浏览器客户端每次发送 `X-F1-Game-Contract: v2`。缓存旧浏览器继续访问v1局时仍获旧形状；创建新局、访问v2或新revealed状态时返回426 `CLIENT_UPGRADE_REQUIRED`，要求刷新，不能因旧客户端而误扣次数。CLI调用示例无需浏览器能力标头；匿名身份始终由Cookie验证。

默认新游戏找不到认证v2快照时503，不静默降级。`GAME_DATASET_VERSION` 如指定，必须是有效v2才能创建新局；应设置本报告新版本或不设置。以下保留的v1响应样例用于解释旧局，八属性中的activeDecades仅适用于v1。

执行与证据详见 [阶段B报告](../P3.2-B-development-report.md)。本阶段只增加最小客户端契约适配，未开发主动揭晓确认UI。

## 启动与环境

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm start
```

后端默认 `http://127.0.0.1:3000`。启动先读取根 `.env`，随后读取后端工作目录 `.env`；已设置进程变量优先。`DATABASE_URL` 配置与 P1 相同，不需要导入或重新生成快照。没有数据库配置时健康检查仍可用，游戏接口返回明确 503。

可选变量：

```dotenv
GAME_DATASET_VERSION=f1-2026-10-08-2190d6c32d9f664f
COOKIE_SECURE=false
ALLOWED_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:3000
```

HTTPS 环境设置 `COOKIE_SECURE=true`。本地 HTTP 使用 false。默认允许 localhost 与 127.0.0.1 的 5173 / 3000；设置 `ALLOWED_ORIGINS` 后覆盖默认列表，不支持通配符。浏览器通过 Vite `/api` 同源代理访问；保持主机名一致，以符合 Cookie 的 SameSite 限制。未开放跨域 CORS。

## 模式与次数

| difficulty |                            答案池 | 最大次数 | 所有模式可猜车手 |
| ---------- | --------------------------------: | -------: | ---------------: |
| beginner   | 24 名核查过来源 ID 的知名冠军名单 |        8 |              784 |
| normal     |    254 名至少 20 次正式起步的车手 |        8 |              784 |
| historical |    全部 784 名，包含历史 Indy 500 |       10 |              784 |

配置集中在 `apps/server/src/game/difficulty.ts`。普通模式门槛依据真实快照分布：起步中位数 7、75% 分位数 35；20 次门槛保留 254 / 784 名，有足够参与经历，同时保留历史多样性。阈值对照与审核名单见 `reports/P2-pool-analysis.json`。不得用普通/新手答案池限制猜测输入。

## 匿名身份与恢复

首次创建游戏返回 `Set-Cookie: f1_player=<随机256位token>`，属性为 `HttpOnly; SameSite=Strict; Path=/api; Max-Age=31536000`，HTTPS 配置另加 Secure。数据库只保存 SHA256 摘要，不返回身份 token 或摘要。

后续游戏查询和猜测必须携带该 Cookie。浏览器通常自动保留；HTTP 客户端应使用 Cookie jar。不同身份访问同一游戏统一返回 404，缺少身份返回 401。清除 Cookie 后无法恢复对应游戏；没有账号找回机制。

刷新后客户端需保留游戏 ID，并调用 `GET /api/games/:id`。服务重启不会丢失历史或匿名身份。P3 再实现本地游戏 ID 保存与恢复交互。

## 接口

### P3 只读展示接口

`GET /api/game-options?version=<可选valid版本>` 返回 `{datasetVersion, statsAsOf, eligibleDrivers, modes}`。每个模式含 `difficulty`、`maxAttempts`、`minimumStarts`、`answerCount`。数量通过同一版本快照与 P2 `answerPool` 计算；不返回答案列表或任何对局关联。前端不硬编码数量。

`GET /api/constructors?version=<可选valid版本>` 返回 `{datasetVersion, constructors:[{id,name}]}`，提供目录中独立 constructor 的真实名称。传入游戏固定版本以验证数据可用性；名称目录没有合并身份，不会修改历史关系或反馈。两个接口均沿用搜索限流和统一错误结构；无效版本返回 503。P3 未新增数据库 Migration。

### GET /api/drivers?search=hamilton

可选 `limit=20`（1—50）、`version=<valid版本>`。默认使用配置版本；恢复旧游戏时建议传该局 `datasetVersion`。英文全名、姓氏、来源简称、中文种子、大小写与音标标准化均支持，SQL 通配符按普通字符搜索。资格过滤先于数量限制，返回去重 ID。

```json
{
  "datasetVersion": "f1-2026-10-08-f46cf6e4723d322d",
  "statsAsOf": "2026-10-08",
  "drivers": [
    {
      "id": "jolpica:driver:hamilton",
      "externalId": "hamilton",
      "givenName": "Lewis",
      "familyName": "Hamilton",
      "displayNameZh": "刘易斯·汉密尔顿"
    }
  ]
}
```

中文译名仍限于 P1 已核查的三组，不自动翻译补齐。

### GET /api/drivers/:id

可选 `version`。返回 `{datasetVersion, statsAsOf, driver, attributes}`；`attributes` 为该版本公开快照，包含 `driverId`、`eligible` 和八项属性，不包含任何游戏答案关联。不合格车手不能作为猜测输入。查看任意已知车手资料不会揭示该局隐藏车手身份。

### POST /api/games

```json
{ "difficulty": "normal" }
```

成功返回 201。返回 `id`、`datasetVersion`、`statsAsOf`、`difficulty`、`status`、`maxAttempts`、`attemptsUsed`、`attemptsRemaining`、`createdAt`、`endedAt`、`guesses`。活跃局没有 `answer` 字段，也没有答案 ID 或身份摘要。

### GET /api/games/:id

返回上述状态与按顺序保存的猜测历史。历史项为 `{driver, attemptNumber, attributes, isCorrect, createdAt}`。当状态为 `won` 或 `lost` 时增加 `answer`（公开车手信息）；活跃状态无此字段。

### POST /api/games/:id/guess

```json
{ "driverId": "jolpica:driver:senna" }
```

成功返回 `{gameId, driverId, attemptNumber, attributes, isCorrect, attemptsRemaining, gameOver, status}`；结束后另返回 `answer`。

`attributes` 恰有八个键：`nationalityCode`、`debutYear`、`constructorIds`、`championships`、`wins`、`podiums`、`raceStarts`、`activeDecades`。每项包含猜测车手的 `value` 与 `feedback`，数字方向需要时包含 `direction`。不会返回隐藏车手的属性值。

- 数字相等 correct；猜小 wrong + higher；猜大 wrong + lower。
- 国籍按已审核代码精确比较。
- constructor ID 集合有交集 correct，没有 wrong，不使用 partial，不合并商业继承关系。
- 年代按集合比较，完全相同 correct，部分交集 partial，无交集 wrong；数组顺序和重复值不影响集合判断。
- 任一侧缺失时 unavailable，不将 null 作为 0，也不发方向提示。年代 value 是 number[]。
- 胜利仅按 driverId 判断，相同属性的不同车手不获胜。

重复猜测返回 409 `DUPLICATE_GUESS`，不消耗次数。胜利或次数耗尽后状态永久结束，后续提交返回 409 `GAME_FINISHED`。数据库行锁串行化同局提交；唯一约束同时保护车手去重、顺序和版本关系。

## 错误与限流

所有错误使用：

```json
{
  "error": {
    "code": "DUPLICATE_GUESS",
    "message": "This driver was already guessed; no attempt consumed",
    "requestId": "req-1"
  }
}
```

| 状态 | 主要 code                                                    |
| ---- | ------------------------------------------------------------ |
| 400  | INVALID_REQUEST：参数、ID 或未知字段不合法                   |
| 401  | ANONYMOUS_SESSION_REQUIRED                                   |
| 403  | ORIGIN_NOT_ALLOWED                                           |
| 404  | GAME_NOT_FOUND、DRIVER_NOT_FOUND、NOT_FOUND                  |
| 409  | DUPLICATE_GUESS、GAME_FINISHED                               |
| 422  | DRIVER_NOT_ELIGIBLE                                          |
| 429  | RATE_LIMITED，含 Retry-After                                 |
| 503  | DATABASE_UNAVAILABLE、DATASET_UNAVAILABLE、ANSWER_POOL_EMPTY |
| 500  | INTERNAL_ERROR，不输出数据库查询或秘密                       |

每 IP 每 60 秒：搜索/资料合计 60 次，猜测 30 次，创建 20 次。计入失败请求，拒绝伪造 forwarded IP；单进程限流内存有容量上限。多实例部署前需要集中限流，并明确可信代理配置，目前未引入 Redis 或部署功能。

所有响应 `Cache-Control: no-store`；匿名凭证不记录到业务响应或日志。修改请求同时检查 Origin 与 Sec-Fetch-Site。无 Origin 的本地 CLI 客户端允许访问，仍必须携带身份 Cookie。

## Windows PowerShell 调用示例

在另一终端启动后端后：

```powershell
$base = 'http://127.0.0.1:3000'
$game = Invoke-RestMethod -Uri "$base/api/games" -Method Post -ContentType 'application/json' -Body (@{difficulty='normal'} | ConvertTo-Json) -SessionVariable f1Session
$found = Invoke-RestMethod -Uri "$base/api/drivers?search=senna"
$driverId = $found.drivers[0].id
$feedback = Invoke-RestMethod -Uri "$base/api/games/$($game.id)/guess" -Method Post -ContentType 'application/json' -Body (@{driverId=$driverId} | ConvertTo-Json) -WebSession $f1Session
$feedback.attributes
$state = Invoke-RestMethod -Uri "$base/api/games/$($game.id)" -WebSession $f1Session
$state.attemptsRemaining
```

不要在聊天或日志中贴匿名 Cookie。重新执行创建可开始另一局；游戏状态与历史由数据库持久化。

## 验证命令

### 阶段 D 契约补充

新版浏览器始终发送 `X-F1-Game-Contract: v2`。带 `Sec-Fetch-Site` 但未声明该契约的缓存旧客户端，可继续查询和猜测 v1；v2 查询/猜测及主动 reveal 返回 426 `CLIENT_UPGRADE_REQUIRED`。reveal 的契约检查先验证身份/所有权，再在数据库状态修改前拒绝，旧局不会因不兼容请求结束。

`POST /api/games/:id/reveal` 成功返回固定数据/规则版本的 `GameResponse`，状态为 revealed，包含答案但不增加次数。结束后禁止重复 reveal/guess。客户端在 POST 超时或结果不明时应 GET 同步，不能盲目重复 POST；GET 同样失败时锁住操作并提示手动同步。

阶段 D 可复现校验：`pnpm data:verify-p32`、`pnpm test:game-database`（包含真正的旧结构到新结构隔离迁移）、`pnpm game:pole-smoke --report reports/p3.2-d/http-smoke.json`、`pnpm exec playwright test --config playwright.cross.config.ts --project webkit`。Firefox 配置保留，但本轮 Windows 下 mozglue 激活上下文错误导致无法启动，不能将其计作通过。

```sh
pnpm game:analyze
pnpm test
pnpm test:database
pnpm test:game-database
pnpm game:smoke
pnpm type-check
pnpm lint
pnpm build
```

普通测试不依赖外部 API。`test:game-database` 在随机 `p2_test_*` Schema 执行固定数据事务测试，结束后只删除该临时 Schema；同时只读检查实际 P1 答案池。使用当前 DATABASE_URL，或 TEST_DATABASE_URL 指定测试库。实际覆盖检查需要该连接中存在指定 P1 快照。

## P3.3 v3 契约（覆盖上述默认新局配置，保留历史规则说明）

当前浏览器发送 `X-F1-Game-Contract: v3`。默认新局锁定 valid v3 快照 `f1-2026-10-08-994df511b40814a5`；缺失、无效或非 v3 配置返回 503，禁止降级。缓存 v2 浏览器可访问自己的 v1/v2 局，创建新局或修改 v3 局前返回 426；没有契约的旧浏览器只可继续 v1。CLI 仍遵守匿名 Cookie 所有权检查。

新手现代组 89 人、传奇组 11 人，共 100 个答案；先用密码学随机数按 60:40 抽组，再在组内均匀抽人，不按并集均匀抽取。现代筛选：`lastStartYear >= statsAsOf 年份 - 20` 且 `raceStarts >= 15 || podiums >= 1`；传奇优先去重。普通 254、历史 784 人不变，三个模式均允许全部 784 人作为猜测。数量来自 `GET /api/game-options`，不要前端硬编码。传奇与大洲审核配置见 `data/game/`。

v3 八个键为 nationalityCode、debutYear、constructorIds、championships、wins、podiums、raceStarts、polePositions。数字相等 correct；绝对差不超过阈值 partial，否则 wrong；不相等都附 higher/lower。阈值依次为首次起步 3、冠军 2、胜场 5、领奖台 10、起步 20、杆位 5。国籍相同 correct、不同但同已审核大洲 partial、不同洲 wrong、不能判断 unavailable。最后 constructor 相同 correct；最后不同但生涯集合有交集 partial；无交集 wrong；最后归属无法确认 unavailable。null 不作为 0。唯一 driver ID 决定胜利。

v1/v2 的数值、国籍和 constructor 反馈完全保留；v1 继续 activeDecades，v2 使用 polePositions。历史猜测 JSON 不重新计算。创建、GET、guess、reveal 的规则和数据版本均以服务端字段为准。

### GET /api/games/:id/drivers/:driverId/timeline

仅局的所有者可访问；只允许已猜测车手或终局答案，其他返回 404。读取该局固定版本的已派生时间线，返回 `{gameId, driverId, distinctConstructors, issues, stages}`。阶段包含 constructorId、name、order、parallel；只有新手额外返回 startYear/endYear，普通/困难没有任何年份、日期、原始赛事或成绩 ID。并列阶段共享 order，并标明 parallel，不能推断同场接替次序。年份为实际代表记录的首末年份，不代表完整合同或连续参赛承诺。离队后返回同一 ID 保留多个阶段，集合仍去重。

该接口受搜索限流保护。公开车手信息不额外暴露 lastStartYear/lastConstructorId；最后车队仅用于服务端比较。v1/v2 无新时间线时明确返回不可用，客户端继续使用原有生涯集合详情。

复核：`pnpm data:v3`（幂等发布）、`pnpm data:validate --version f1-2026-10-08-994df511b40814a5`、`pnpm game:v3-smoke`、`pnpm test:game-database`。模拟旧服务创建的 allowLegacyCreation 为测试构建选项，生产入口及请求参数均不开放。

`game:smoke` 使用真实本地 HTTP 及 P1 数据，新增并结束三局匿名 P2 验收游戏，不修改历史表；测试 token 只驻留内存。证据保存在 `reports/P2-api-smoke.json`，包括服务器重启后恢复结果。

## P3.4 终局答案资料（只读扩展）

`GET /api/games/:id/answer-profile` 不接收 driverId 或 version 参数，额外查询字段返回 400。使用现有 HttpOnly Cookie 和规则版本契约；身份缺失 401、非所有者或不存在局 404；active/playing 返回 409 ANSWER_NOT_AVAILABLE，错误不带答案 ID。Origin/Sec-Fetch-Site、每 IP 搜索/资料 60 次每分钟限流、Cache-Control: no-store 保留。旧浏览器的 426 升级机制不变。

终局返回 Zod 严格验证的 AnswerProfile：gameId、datasetVersion、statsAsOf、rulesVersion、status（won/lost/revealed）、driver、statistics、constructors、timeline。statistics 包括 nationalityCode、debutYear、championships、wins、podiums、raceStarts、polePositions；constructor 项为稳定 id/name。查询使用只读 repeatable-read 事务及 session.datasetVersion，不能借用最新快照，不更新游戏/猜测或统计。

v3 的 timeline 读取 driver_career_timelines，终局答案在所有难度显示认证 startYear/endYear；包含原 order/parallel，回归阶段不合并。新手进行中时间线仍有年份，普通/困难隐藏；结束后只有答案车手可解除年份隐藏，其他猜测车手仍遵守难度。v1/v2 timeline=null，界面明确旧版没有认证有序时间线，仅展示原 snapshot 的无序生涯集合。v1 polePositions=null 且标“未提供”，不得用 v2/v3 杆位补填；其他 null 为“数据未知”，真实零显示 0。

Schema 同时验证答案/时间线身份一致、版本支持、认证年份及 constructor 集合一致。已有 GameResponse、guess/reveal 语义、权限、行锁和历史反馈均未修改。新增 `pnpm exec tsx scripts/smoke-profile-api.ts` 可验收三版本真实 HTTP 与服务重启恢复；PostgreSQL 专用测试覆盖九种规则/终局组合。
