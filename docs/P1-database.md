# P1 数据库与导入操作

本阶段保留 P0 的 Vue 3.5、Fastify、PostgreSQL 与 Drizzle 技术栈。没有游戏会话、猜测接口或正式游戏 UI。

## 初始化与完整导入

PostgreSQL 服务和目标数据库需要先存在。角色需具有目标 Schema 的建表权限。将 `.env.example` 复制到项目根目录 `.env`，设置 `DATABASE_URL`。脚本优先读取根目录 `.env`，随后读取 `apps/server/.env` 补充未设置的变量；进程环境变量优先级最高。

在根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:check
pnpm db:migrate
pnpm test:database
pnpm data:import --run history-2026-10-08 --as-of 2026-10-08
pnpm data:stats --as-of 2026-10-08
```

最后一条命令输出实际版本。用它运行：

```sh
pnpm data:validate --version <实际版本>
```

校验报告保存在 `reports/<版本>.json`。出现校验错误时命令以非零状态退出，版本标记 `invalid`，不得用于正式答案池。`pending` 也不能发布。数据库连接工厂不会自动执行迁移。

可分阶段执行 `data:drivers`、`data:races` 和 `data:aliases`，传入相同的 `--run` 与 `--as-of`。`data:races` 导入历年日历、正赛结果与赛季积分榜；`data:drivers` 同时导入 constructor 目录。

## 限速、恢复与重跑

Jolpica 每页最大 100 项，匿名持续限制为每小时 500 请求；实现默认串行间隔 7.5 秒，自定义 User-Agent，每请求最多 4 次重试，遵守 HTTP `Retry-After`。完整历史导入可能耗时一小时以上，请保持连接。脚本不请求冲刺或排位赛结果。

- 传入明确 `--run`，失败后使用同一参数重跑。
- `import_pages` 保存完整、经过解析的响应与分页偏移。缓存页会被重新处理，因此保存原始页后中断也不会跳过尚未写入的业务数据。
- 完整一站的成绩在同一事务中替换。修正后的旧成绩不会残留，多条共享驾驶成绩也不会被错误压成一行。
- 一个批次绑定截止日期与来源；发现分页总数变化时拒绝继续，改用新批次重新抓取。
- 同一批次复用缓存。更新源数据时必须更换 `--run`；修改审核文件可以用同批次重放缓存。
- 导入、统计与校验使用 PostgreSQL advisory lock 防止互相交错。导入的锁由独立事务持有，业务页/整站写入仍可分段提交以便恢复。
- 统计在 repeatable-read 事务中读取一致数据；版本由截止日期、算法版本和输入摘要生成。相同输入复用版本，修正后的输入产生新版本。

来源文档：[接口与分页](https://raw.githubusercontent.com/jolpica/jolpica-f1/main/docs/README.md)、[限速](https://raw.githubusercontent.com/jolpica/jolpica-f1/main/docs/rate_limits.md)、[成绩](https://raw.githubusercontent.com/jolpica/jolpica-f1/main/docs/endpoints/results.md)、[积分榜](https://raw.githubusercontent.com/jolpica/jolpica-f1/main/docs/endpoints/driverStandings.md)。

## 表结构

| 表                        | 主键与用途                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| drivers                   | 来源命名空间稳定 ID；外部 driverId 唯一，保留原文名、出生日期、来源国籍与已映射代码               |
| driver_aliases            | driverId + 标准化别名；英文全名、姓氏、来源简称和已审核中文                                       |
| constructors              | 独立来源命名空间 ID；外部 constructorId 唯一                                                      |
| constructor_aliases       | constructorId + 标准化别名；名称与身份分离                                                        |
| seasons                   | 年份；日历、结果、积分榜完整性及最终赛季状态                                                      |
| races                     | 来源命名空间 ID；赛季 + 轮次唯一；Indy 标记及来源成绩条数                                         |
| race_results              | 来源成绩内容摘要 ID；每个来源 entry 一行，保留全部原始 JSON、三态起步与获奖确认、审核来源         |
| driver_seasons            | driverId + 赛季；积分榜、冠军确认与来源 URL                                                       |
| driver_constructor_stints | driverId + constructorId + 赛季；确认实际正赛效力（含接替驾驶）的首末轮次区间（不表示每站都出场） |
| dataset_versions          | 内容版本、来源、统计截止日、算法版本、生成时间、校验状态与报告                                    |
| driver_stats              | driverId + 数据版本；八项属性、资格状态与异常列表                                                 |
| import_runs               | 批次 ID、来源、截止日、开始与完成时间                                                             |
| import_pages              | 批次 + endpoint + offset；来源响应、获取时间和分页进度                                            |

内部稳定 ID 采用 `jolpica:driver:<driverId>`、`jolpica:constructor:<constructorId>` 与 `jolpica:race:<赛季>:<轮次>`，不根据展示名称关联。ID 和引用列均为 text；统计数组的 constructor ID 由校验脚本检查，其他关系使用数据库外键。

迁移 SQL 由维护者编写及审核，再使用 `pnpm db:generate --name reviewed_change --sql <SQL文件>` 登记到既有 Drizzle journal。该原创工具不连接数据库，不自动比较 schema，不执行 SQL；旧 journal 与 SQL 保持不变。`pnpm db:migrate` 仍由 Drizzle ORM 应用迁移，生产执行须另行批准。为移除授权冲突的 drizzle-kit，自动 schema diff 已取消，维护者必须人工核对 Schema/SQL 一致性；禁止绕过 Migration 使用 push 改生产表。

## 历史口径与缺失值

- 只使用世界锦标赛正赛结果。DNS、DNQ、DNPQ、Withdrawn 等明确非起步状态排除；正数圈数作为一般起步依据。
- 零圈退赛并不等于 DNS，无法确认时 `started=null`，必须审核后才算入正式起步数。
- 共享驾驶、同车手重复 entries、重复发车格以及早期 grid=0 标记审核。成绩原文和圈数不丢弃。
- 生涯起步、胜场、领奖台按 driverId + raceId 计数，一场同车手多条 entries 不重复累加。
- 排名序号不是获奖依据：使用来源 `positionText` 的正式数字名次；退休的第 2 条记录不能自动算领奖台。
- `data/reviews/race-results.json` 支持每站每车手审核和用 `carNumber` 精确指定 entry。多车记录优先逐车审核，分别确认 `started` 与 `representedConstructor`。接替驾驶的实际 constructor 效力与正式共享名次保留，不增加正式起步数。
- 官方结果证实车手归属有误时，审核必须指定原始外部车手 ID、赛车号码、`correctedDriverExternalId` 和来源。只修正 canonical 外键，原始 JSON 和内容摘要主键不变；校验仅接受完全匹配的审核证据。
- 1950—1960 Indianapolis 500 根据赛季与 circuitId 明确标识，并检查每年存在比赛与正式起步记录。
- constructor 不因为名称相同、改名或商业继承自动合并。目录与比赛中观察到的名称保存为该来源 ID 的别名；额外审核名称放入 `data/mappings/constructors.json`。未审核跨 ID 合并均拒绝。
- constructor 生涯集合来自确认实际参赛的正赛记录，包含已审核接替驾驶；DNS、DNQ 和仅练习/排位记录排除。首次/最后起步年份、起步数与年代仅来自正式起步，缺失年份不会用连续生涯区间补齐。
- 未确认核心值为 `null`；来源缺失或资格不确定的记录保留但不进入正式答案池。国籍按来源记录映射，不根据出生地推断；East German 保留历史代码 DDR，未映射历史或双重国籍进入待审核清单。
- 世界冠军仅来自已结束年份的最终完整积分榜，不把当前赛季领先者算作冠军。当前年份赛季即使提前决出冠军也先保留至最终审核；需支持年内最终赛季时再明确调整此口径。
- 截止日按整天筛选已返回的正赛结果；仅有日历但无成绩的已到期赛事视为不完整。该机制不是历史时间点的“当时已知数据”回放：外部 API 的历史修正会产生新版本。
- `driver_stats` 保存国籍代码、constructor 集合与年代，旧版本不被新导入重算覆盖。P2 应仅使用 `valid` 版本的快照属性，避免从可变的原始表重算反馈。

## 别名与数据库查询

英文姓名始终保留。已核查中文种子仅包含用户 P1 请求提供的三组姓名，不做机器翻译补全。缺失中文名不阻止导入；中文姓氏允许歧义，别名不设全局唯一约束。

`searchDrivers` 是数据库查询函数，支持去重、条数上限与通配符转义；调用方先采用与导入一致的 `normalizeAlias` 标准化输入。`careerConstructorIds` 查询某一已通过校验版本的生涯车队集合。这些函数没有增加游戏或猜测 API。

## 测试与交叉验证

```sh
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

普通测试只使用本地固定数据和假网络响应。数据库集成测试需配置 `TEST_DATABASE_URL`，在随机生成的 `p1_test_*` Schema 内应用迁移、重复导入、生成快照并验证查询，结束后只删除该临时 Schema。未配置时明确跳过，不能视为 PostgreSQL 验证通过。

也可以显式运行 `pnpm test:database`：优先使用 `TEST_DATABASE_URL`，否则使用当前 `DATABASE_URL` 创建隔离的临时 Schema。需要数据库角色具有创建 Schema 的权限，不会清空或改写应用业务表。

`data/reference-checks.json` 保存六名代表车手带来源与截止日的**校验参考值**，不会写进正式统计表；Hamilton 和 Alonso 比较相应历史截止日的计算值，而不是当前生涯总数。更改参考口径前需复核其来源。

统计校验检查覆盖、身份、引用、constructor 映射、Indy、缺失属性、起步/胜场/领奖台异常、年代和参考值。不完整或未审核版本不能发布；报告列出原始成绩 ID，方便后续修订审核文件后重放。

## 补充来源审核与重放

`pnpm data:audit --as-of 2026-10-08` 只读生成历史审计报告，列出真实表数量、逐年覆盖、11 场 Indy 的起步人数、未审核原始成绩和国籍缺失。

补充来源固定版本及署名见 [SOURCES.md](../data/reviews/SOURCES.md)。将对应发布包解压到 `reports/source-cache/f1db-v2026.16.0` 后执行：

```sh
pnpm data:review-candidates --source-dir reports/source-cache/f1db-v2026.16.0 --release v2026.16.0 --as-of 2026-10-08
```

该命令仅输出候选及逐条对照证据，不修改数据库或已批准审核文件。匹配要求稳定来源身份、出生日期/已审核身份对照、比赛日期、赛车号码和具体起步依据；矛盾记录单独留待人工核查。不能用另一来源的生涯总数覆盖本项目聚合统计。

审核文件确认后，用以下命令重放已导入原始成绩并生成新版本：

```sh
pnpm data:replay-reviews --run history-2026-10-08 --as-of 2026-10-08
pnpm data:stats --as-of 2026-10-08
pnpm data:validate --version <新生成的实际版本>
```

重放重新清洗全部已导入、截止日前的正赛记录，保持原始 entries 数量和主键，检查每条审核的比赛、车手与赛车号码确实存在，并按整站事务更新确认字段。旧的 `invalid` 版本及报告仍保留；不可绕过失败报告把旧版本改成 `valid`。

## P3.2 杆位审计（尚未发布新属性）

```sh
pnpm data:pole-audit --as-of 2026-10-08 --probe-api
```

默认核查既有 valid 快照与固定 F1DB v2026.16.0；可显式传入 `--version`、`--source-dir`、`--release`。默认固定发布文件摘要必须一致；更换来源版本必须重新审核来源与摘要，不能绕过这一检查。

脚本对 PostgreSQL 使用只读 repeatable-read 事务，不执行迁移或写入历史表。机器报告与原始排位探测响应保存在 `reports/pole-audit/`。`--probe-api` 复用本地证据缓存，首次联网沿用 P1 分页、限速及重试；该参数不重新导入 P1 历史数据。

数据关卡未通过时生成报告并以退出码 1 结束。这个结果不能当作可发布版本。逐场官方杆位荣誉为统计事实，grid、排位第一与是否起步仅供核查。未知总数保持 null；逐场候选数量与已确认总数分开保存。来源、授权、六人参考及12项已审核赛事见 `data/poles/`；已审核例外只允许精确匹配年份、轮次、来源 ID、发布日期版本及两侧日期，本轮新增赛事还保护原始 grid 条目。

2026-10-08 阶段 A 审计确认了 1165 场杆位归属和 784 人总数。审计方法和结果摘要见 [杆位数据来源](../data/poles/SOURCES.md)。`pnpm data --as-of 2026-10-08 --probe-api` 是同一只读命令的别名。阶段 A 保留了 P1 的 valid 版本、P2 规则和旧游戏。身份审核记录保存在本地 `data/poles/identity-reviews.json`。
