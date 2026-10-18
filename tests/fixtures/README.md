# 杆位历史固定数据

`pole-history.json` 是 F1DB contributors 的固定 [v2026.16.0](https://github.com/f1db/f1db/releases/tag/v2026.16.0) 的小范围摘取和字段变换，按 [CC BY 4.0](https://github.com/f1db/f1db/blob/v2026.16.0/LICENSE) 使用。保留十场异常赛事的来源标记、共享驾驶及八位车手的身份/参赛记录；本地身份来自上一次只读审计，不修正 P1 原始生日或姓名。输入 SHA256 见 `data/poles/SOURCES.md` 和机器审计报告。

固定测试不依赖数据库或网络。身份测试的本地赛事 witness 是审核配置中的显式测试输入，校验字段变化、缺失证据及错误关联的拒绝行为；实际 PostgreSQL 赛事是否匹配由完整只读审计独立检查。官方发车表、IMS 比赛记录和独立档案 URL 及具体事实保存在 `data/poles/race-reviews.json`、`identity-reviews.json`；这些配置没有写入正式统计表。
