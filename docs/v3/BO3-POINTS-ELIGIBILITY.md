# BO3 积分资格政策

2026-10-20，用户明确批准方案B；政策版本 `bo3-points-eligibility-v2`。本阶段仅实现双方整场零有效参与不计积分，不实施生产启用。

## 正式规则

完整series内，只要任意一人有一次服务器接受并提交的有效猜测、实际客户端心跳或有效投降，双方仍按原胜负结果结算胜+3、负−1、最低0。仅当双方参与计数均为0，赛事为ineligible，双方都不写BO3奖励流水，也不改变余额。赢家仍由原状态机唯一确定；不是平局、取消比赛或nominal=0账本事件。

不要求双方都参与，不要求注册，不新增整场投降、设备指纹、封号或历史积分撤销。单次有效心跳即足够；这不是完整反串谋方案。

独立三难度、120秒排队、8次/480秒、有效猜中抢答、投降只影响小局、45秒租约、同时离线普通局平局、5秒揭晓、两胜结束、最多六普通局及必要的唯一特殊局全部不变。特殊评分、种子上下文/承诺/裁决算法及长期离线收敛不变。每日+1、快速0、match-v1/daily-v1及其他旧历史不变。

## 持久证据

复用不可由应用角色UPDATE/DELETE的bo3_events、bo3_guesses及固定bo3_players，不以最后在线时间推断整场参与：

| 证据      | 计数依据                                                                         |
| --------- | -------------------------------------------------------------------------------- |
| heartbeat | 真实命令路径持久化的heartbeat事件，payload.slot关联固定参与者                    |
| guess     | guess事件的slot匹配，且存在同series/round/principal/event_seq的已保存bo3_guesses |
| surrender | 唯一result事件reason=surrender；winnerSlot的另一方为实际投降者                   |

函数bo3_participation(uuid)汇总全部小局。COUNT事件而非LEFT JOIN行数，因此没有匹配证据时精确为0。初始化租约只产生start，排队/配对/取消、GET、刷新、自动推进及Sweep不计。已确认请求由原bo3_requests重放，绕过命令执行，不新增事件；拒绝请求和事务回滚不贡献证据。第45秒到达的心跳先消化裁决，不能续已到期租约或产生有效心跳；既有返回裁决状态的HTTP协议保持。

## Migration 与数据库不变量

实际Journal原为0000–0012，追加0013_bo3_points_eligibility.sql，前13项和旧SQL原字节不改。

bo3_series新增points_policy_version、points_eligibility、points_ineligible_reason、participation0/1及points_decided_at。迁移先ADD COLUMN DEFAULT v1，再把新插入默认值改为v2：迁移前已完成及在途赛事都锁定v1，不使用零值默认推断旧比赛。旧行结论/证据快照/决定时间保持NULL，API以锁定v1解释为旧计分资格；不重算历史、不回填奖励。

新series只能以v2 active状态创建，政策不能修改。active不能预写资格；v2 finished必须同时具有真实证据计数、明确资格、对应原因及决定时间。BEFORE终局更新重新计算持久证据，拒绝伪造快照；原bo3_immutable使终局行不可更新。finish事件仍有原唯一索引，series主键及不可变终局确保不会重复决定。

事件写入锁定父series，只允许active、关联本series的round及合法参与slot，禁止终局后补事件。ledger BEFORE INSERT拒绝未终局或ineligible的BO3。延迟约束在同事务提交时验证：v2 eligible有双方各一条合法points-v1 win/loss流水，ineligible为0条；不将缺失资格写为零分事件。原来源唯一键、余额下限和不可变账本权限保持。

points_decided_at是实际数据库决策记录时间，区别于ended_at/effectiveAt及北京时间businessDate。既有PointsService继续用权威终局时间归属BO3积分，不改跨日规则。

证据函数为SECURITY INVOKER。bo3-roles模板撤销PUBLIC执行，仅向应用角色授予EXECUTE；所需表读取均为既有BO3角色范围。无账本UPDATE/DELETE/TRUNCATE、DDL或额外发分接口。隔离points测试角色另补证据SELECT及函数EXECUTE，用于在真实约束下构造事务内终局；不是生产扩权。

## 终局事务顺序

1. 通过原load路径锁series，按锁后权威时间消化已成立事件。
2. 原endRound/seriesWinner决定唯一胜者、终局时间和finish事件，不改变算法。
3. 汇总完整series证据，按锁定政策判断资格。
4. 同一次series终局UPDATE固化资格/原因/计数/决定时间；数据库核对证据。
5. eligible调用现有PointsService.settleWithin，仍以真实BO3来源读取双方结果，先series后余额锁；ineligible跳过积分服务，不创建余额或流水。
6. 释放membership、写入原幂等确认，延迟约束验证流水，统一提交。任何失败回滚事件、资格、终局、余额、流水、membership和确认。

事务内先把series标记finished，是原积分来源读取器需要的状态，不代表提前对外提交。独立调用积分服务也会被bo3-source资格检查及数据库ledger触发器拒绝给ineligible发分。

## API 与页面

`/api/v3/bo3/series/:id`及状态/命令响应增加：

- pointsPolicyVersion：v1或v2，服务器锁定，不能由请求指定。
- pointsEligibility：active为NULL；新终局eligible/ineligible；旧v1终局按旧政策为eligible。
- pointsIneligibleReason：仅ineligible为both-zero-participation。
- pointsDecidedAt：新v2终局实际决策时间；active/旧v1为NULL。
- actualDelta：ineligible为NULL，明确表示没有奖励流水；正常0余额败者仍为0并有一条loss流水。

严格Zod检查v2状态/资格/原因/实际变化一致。缺少新字段的旧幂等确认按v1默认读取，不覆写原JSON。新增字段不向活动赛事暴露seed或对手私有猜测。私有历史新增政策/资格/原因，保留win/loss记录并显示“不计积分”；公开主页仍只返回公开积分资料。七日趋势和日榜只聚合ledger，ineligible没有积分事件，而正常零扣分事件仍有eventCount=1。

终局页面展示原赢家及赛后验证材料，并明确提示：“本场比赛已结束。由于双方整场均未产生有效参与记录，本场结果不计入积分。”未实施视觉重构，原68张E基线不更新。

## 兼容、回退与风险

G2应用要求0013；readiness及BO3 readiness检查新字段。运行时增加x-f1-bo3-points=bo3-points-eligibility-v2，rolling-host继承的兼容检查拒绝不支持该政策的实例。发布时必须配套G2客户端，旧缓存页面需重新加载；没有生产切换或功能启用。

迁移后旧在途v1仍按原规则完成，即使全程离线也保留原+3/−1。新v2不能交给G1/原D二进制回退：旧代码缺资格写入会被数据库拒绝终局；禁止移除约束来恢复旧写路径。安全回退必须保留G2终局治理、A授权层、G1完整密钥读集及签名兼容，可关闭新匹配而保留恢复。Schema不降级、不删流水/历史/证据/必要种子，不批改政策。

剩余风险：攻击者或串谋身份只需发出一次有效心跳/猜测/投降即可使双方eligible；失败方余额0时仍可能产生净正积分。不能据此擅自升级为双方必须参与或撤账。G1邮件、密钥托管、依赖、Linux、许可/审批及完整历史数据阻塞仍未解除。
