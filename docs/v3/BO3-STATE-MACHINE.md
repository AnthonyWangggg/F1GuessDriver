# Phase D BO3 实施不变量

本轮用户已批准 D1/D2/D3。以下在业务代码之前固定；Phase 0 中尚待确认的时间、特殊局零猜测及双方离线裁决，以本轮任务书为准。

- queue: queued → matched/cancelled/expired；120 秒排他截止，同难度配对。新命名空间、新表、新锁，绝不消费 match-v1。
- series: active → finished；round: active → revealed。普通局 1～6，特殊局仅 7。两胜立即固定整场胜者；第六局领先者胜、同分才进入第七局。每局最多八次，所有七个候选答案在建赛前无放回确定，不够则拒绝建立、保留队列。
- 单局已揭晓后结果不可变。resultUntil=effectiveEndedAt+5000ms；下一局 startsAt=resultUntil，与执行器实际运行时间无关。最终局也保留五秒结果展示，整场权威 endedAt 使用决定胜负事件成立时间。
- 对每场赛事取得行锁后读取 DB 时钟，先处理 min(deadlineAt,lease0,lease1) 中已到期事件。deadline 同刻优先；租约同刻普通局平局、特殊局评分裁决；单方先到期则该方负。然后才受理猜测/投降/心跳。普通命令按行锁串行确认，事件 seq 单调。
- 评分只读取保存反馈：八项 correct=2、partial=1、wrong/未知=0；先最高分、再首次最高分序号小者、再总分、最后承诺种子。零猜测为 (0,9,0)。首次实际零分猜测序号为1。
- 心跳只能是绑定 series/round/Principal 的主动鉴权写；幂等重放返回原响应、不续约。GET/Sweep 不修改租约。新局初始租约 startsAt+45s。
- nextTransitionAt 持久化、索引、SKIP LOCKED；每场每事务有限最多 14 个边界补推进（7次结局、6次开局），无人在线在 startsAt+345s 得到唯一整场胜者，不制造猜测或心跳。

锁顺序：HTTP 先 Phase A owner/会话复核锁 → BO3 本人请求幂等锁 →（仅队列操作）BO3 独立队列调度锁 → series 行锁 → round/player → points 来源锁 → 按 UUID 排序的 balances。配对不拿另一玩家 owner 锁或请求锁，只按不可变 Principal 插入固定成员；Sweep 不拿任何 owner/请求/队列锁，只按 series SKIP LOCKED → round/player → points。认领不锁 BO3/余额，保留同一 Principal，故不会反向等待 owner。终局只删除指定 series 的 membership，不锁其他 Principal 的新队列。

整场赛果、双方账本、余额和 membership 释放同事务；任何失败全部回滚，nextTransitionAt 保持可重试。所有来源由真实终局 reader 校验，不能通过 HTTP 指定积分。规则未启用不开放配对。旧协议不发分。

种子算法 bo3-seed-v1：上下文为固定顺序 UTF-8 字符串，各字段前置 unsigned 32-bit big-endian 字节长度；字段依次 algorithmVersion、seriesId、contract、difficulty、datasetVersion、comparisonRulesVersion、slot0公开标签、slot1公开标签。commitment与decision digest使用不同ASCII域，域末尾是一个0x00字节，连接contextBytes与原始32字节种子后SHA256；winnerSlot=digest原始首字节&1。精确规范与向量见BO3-SEED-V1。种子以服务器AES-GCM密封保存，整场结束才披露hex。标签为赛前随机UUID，不是Principal/owner/邮箱；上下文不含赛后分数。

测试时钟仅显式测试构造器注入；生产取锁后 clock_timestamp，无请求/运行环境时钟开关。所有新功能默认关闭，关闭新配对开关仍允许既有赛事恢复/收敛；不执行生产迁移/开服/发布。
