# 历史审核补充来源

主要来源仍为 Jolpica，原始成绩 JSON 与外部 ID 均保留。

补充来源是 [F1DB v2026.16.0](https://github.com/f1db/f1db/releases/tag/v2026.16.0)，由 F1DB contributors 提供，采用 [CC BY 4.0](https://github.com/f1db/f1db/blob/v2026.16.0/LICENSE)。本项目从发布包的正赛成绩、日历和车手文件提取审核事实并作了变换；不使用其生涯统计覆盖本项目统计。

- 发布文件：`f1db-json-splitted.zip`。
- 下载 ZIP 的 SHA256：`5bfcde5546bd16ec58a86a87c5d1e4c4150c2ec680480ea5cc487cb6223ea45f`。
- 本地原包：`reports/source-cache/`，不加入 Git。
- 逐条对照证据及所用子集摘要：`reports/f1db-review-candidates.json`。
- 人工确认的跨来源车手 ID 对照：`data/mappings/f1db-drivers.json`；出生日期争议不据此覆盖 Jolpica 原文。
- 官方比赛结果、Indy 原始起步表与同时代报道补充在每条审核的 `sourceUrl` / `note` 中。

F1DB 的 `totalRaceStarts` 会把部分接替驾驶计入，见其 [固定版本统计实现](https://github.com/f1db/f1db/blob/v2026.16.0/build-logic/src/main/kotlin/com/f1db/plugin/reader/F1DBReader.kt)。本项目要求正式起步，因此采用具体记录中的非接替 entry、起步位置及 DNS/DNQ 排除。已确认接替驾驶仍保留其实际 constructor 效力及共享名次，独立于正式起步数。来源矛盾或无法建立起步依据的候选不能自动批准。

审核可以按“比赛 + 原始车手 ID”覆盖同车手所有 entries，也可以用 `carNumber` 精确指定 entry。车手归属修正必须同时指定号码和目标外部 ID，并有直接证据。不得依据展示姓名改数据库关系。
