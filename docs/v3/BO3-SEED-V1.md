# BO3 随机承诺与独立复算规范

算法版本 `bo3-seed-v1`，比赛协议 `match-v2-bo3`。只用于特殊局评分全部相同时选固定槽位；不能据此将普通局或评分优先级改为随机。槽位 0/1 为固定参与者的赛前随机公开标签，不是 owner_hash、邮箱或账号 UUID。

## 字节编码

上下文按以下顺序读取八个字符串：algorithmVersion、seriesId、contract、difficulty、datasetVersion、comparisonRulesVersion、slots[0]、slots[1]。每字段取原始 UTF-8 字节，前置该字段**字节数**的 unsigned 32-bit big-endian 整数；不按字符数，不依赖 JSON 属性顺序、空白或 Unicode 归一化，不添加分隔符。

`contextBytes` 为上述八段连接。`rawSeed` 为赛前一次生成的 32 字节 CSPRNG 输出。hex 只是披露编码，哈希输入必须解码为原始字节。

- commitment = SHA256(commitDomain || contextBytes || rawSeed)。commitDomain 为 ASCII `f1-bo3:commit:v1` 后接**一个 0x00 字节**。
- decisionDigest = SHA256(decisionDomain || contextBytes || rawSeed)。decisionDomain 为 ASCII `f1-bo3:decision:v1` 后接**一个 0x00 字节**。
- seededSlot = decisionDigest 原始首字节 & 1。不是 hex 第一个字符的最低位。

Series ID、协议、难度、快照、v3 比较版本、算法版本和槽位均在建赛事务固定。先持久化密封种子、上下文和 commitment，再创建第 1 局；初始状态已包含承诺，所有玩家命令必须在该事务提交后才可受理。无客户端确认门槛，离线玩家不能阻止自动赛程。后续胜负和分数不参与生成或改变种子，事务已提交后不能重抽。

种子使用现有服务器 AES-256-GCM 密封接口及配置密钥存储；反序列化后校验 32 字节 hex 格式及 commitment。整场结束前 verification 仅返回 context/commitment；结束后同时返回 seedHex、digest、seededSlot。公开上下文包含槽位标签，series.selfSlot 指明本人槽位。最终实际胜者可能来自抢答、投降、掉线或评分，不应一律等同 seededSlot。

## 固定向量

完整非 ASCII 上下文及种子见 `packages/shared/fixtures/bo3-seed-vector.json`。种子为测试字节 00～1f，不能用于真实赛事。

- commitment：`5ecfb065754bea8395b6208dd0de78fda5e7a6c9bc630319771218096108bdb9`
- digest：`d272ca2e53c1b01d599039748c0f9b3cd3d0f6acad6fa05f8b235f04b7552c25`
- seededSlot：0。

TypeScript 的 `apps/server/src/bo3/domain.spec.ts` 与独立 Python 标准库脚本使用同一固定向量，Python 不调用 Node 实现。运行 `python scripts/verify-bo3-vector.py` 验证向量。将本人完赛 verification 响应保存为 JSON 后可运行 `python scripts/verify-bo3-vector.py <文件路径>` 复算。脚本不连接网络、数据库或读取环境秘密；未结束的响应缺少 seedHex，应拒绝复算。

独立检查时还应核对自己赛前保存的 commitment，而非仅信任完赛响应重新提供的 commitment；同时核对上下文和固定标签。该规范证明承诺一致与随机分支可复算，不把公开随机承诺当作整个服务器或历史数据的第三方认证。
