# 杆位审计来源（阶段 A）

本目录仅包含审计配置和校验参考，不向正式统计表写入参考数字。

主要逐场事实：F1DB contributors 的 [v2026.16.0](https://github.com/f1db/f1db/releases/tag/v2026.16.0)，[CC BY 4.0](https://github.com/f1db/f1db/blob/v2026.16.0/LICENSE)。使用 race-results 的 polePosition（Schema 解释为授予杆位荣誉），不是 gridPositionNumber 或 qualificationPositionNumber。本项目对数据作身份映射、去重与审计变换，未改写来源。

发布 ZIP：f1db-json-splitted.zip；发布 SHA256：`5bfcde5546bd16ec58a86a87c5d1e4c4150c2ec680480ea5cc487cb6223ea45f`。本机保存原包和解压内容于 reports/source-cache，原包校验一致。脚本记录三份输入文件 SHA256，逐场保留 polePosition=true 的原始来源字段。

第二来源：P1 PostgreSQL 中保留的 Jolpica 正赛原文、稳定 ID、日历和审核记录。grid=1 仅作为交叉核查信号，不作为杆位唯一判据；DNS 不意味着此前授予的杆位应取消。

Jolpica 额外排位探测：1950、2021 意大利、2022 圣保罗、2026；脚本默认 7.5 秒限速、分页、重试，响应保存在 reports/pole-audit。1950 返回 total=0，不能据此得出该年没有杆位。

官方口径说明：[2021 冲刺说明](https://www.formula1.com/en/latest/article/f1-sprint-true-or-false-separate-the-fact-from-the-fiction-about-f1s-new.48xIJuyFPnVE9VpQj2PtJf)、[2022 冲刺说明](https://www.formula1.com/en/latest/article/how-does-the-f1-sprint-work-the-format-explained-ahead-of-imola.4ep6uU8VYFMgftvTYxkZdI)。2021 要核查冲刺结果与处罚；2022 起不能把冲刺赢家当成 GP 杆位获授者。独立冲刺排位杆位不额外累计。

Indy 交叉事实：[官方 1950 起步表](https://www.formula1.com/en/results/1950/races/96/indianapolis-500/starting-grid)、[IMS 四圈排位记录](https://www.indianapolismotorspeedway.com/events/indy500/history/historical-stats/race-stats/records/four-lap-qualification-records)。最快总体排位速度不必然决定 Pole Day 杆位；不得按后续排位速度重新授予。

六位代表车手的参考值、截止日及官方 URL 见 reference-checks.json。参考值用于独立检查，不能覆盖逐场聚合统计。

## 2026-10-08 剩余事项逐项审核

本轮新批准的十场及八个身份分别保存在 `race-reviews.json` 与 `identity-reviews.json`。十场均读取了 F1 官方发车表；共享驾驶另对照官方成绩和 Motor Sport 同时代赛事记录。1952 意大利 Moss 的错误 grid 与共享条目区别处理。1964 美国同时区分赛前车辆/号码交换与正赛换车，不能让 Spence 继承 Clark 杆位。2024 Las Vegas 使用 FIA 2024 Start Time Information v2 与官方媒体手册，明确周六当地22:00对应次日UTC06:00，不全局容忍一日偏差。

身份依据包括 Porsche 对 Ahrens 父子的独立说明、F1 官方赛事中的具体车号、IMS 逐年参赛表、OldRacingCars 历史车手档案与 STATS F1。辅助百科页面仅用于记录全名/出生资料分歧，不以其杆位总数批准身份或比赛。每条保存已观察到的两側全名、生日、国籍、独立历史赛事 witness、URL 与理由。Biondetti、Herman、Veith、Wallard、Walt Brown 的生日分歧仍保留；本轮结论是同一参赛车手身份，不是出生资料裁决。Hayje 的本地错误姓氏也保留，明确不关联 Brett Lunger。

所有网页本轮于2026-10-08检索。原始源文件不改写；机器报告保留来源 pole 条目、Jolpica grid 原文和精确批准记录。旧失败报告为 `reports/pole-audit/audit-before-final-review.json`。固定测试摘取 F1DB 数据遵循同一 CC BY 4.0 署名，见 `tests/fixtures/README.md`。

审计通过只形成阶段 A 报告，没有发布可供游戏读取的新 dataset version。必须等待用户审核，才可以开始阶段 B。

本阶段不下载国旗图片或真实 constructor Logo，未发布任何图形资产，也未开展阶段 C。

阶段 B 将逐场证据保存为 `pole_audits` 和 `race_poles` 记录，并发布独立 v2 快照。版本及接口契约见 [游戏 API](../../docs/P2-api.md)。
