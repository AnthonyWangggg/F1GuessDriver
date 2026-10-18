# P3.3 游戏展示与人工审核来源

统计截止为 2026-10-08。仅新增审核配置及从 v2 已认证事实派生的时间线，不修改原始身份、统计或 constructor ID。

## 传奇名单

beginner-legends.json 列出 11 名人工选择的稳定 ID，每条保存审核日期、理由与官方来源。10 名冠军依据 [F1 Hall of Fame](https://www.formula1.com/en/drivers/hall-of-fame)，Gilles Villeneuve 依据 [F1 历史专题](https://www.formula1.com/en/latest/article/5-reasons-f1-fans-are-still-in-awe-of-the-legendary-gilles-villeneuve.6Dvc1Wh0NMPqZNqBIwIZHU)。这是首批人工名单，不声称穷尽所有传奇；不从数值自动扩展。Michael Schumacher 优先归传奇，避免现代组重复。

## 国籍大洲

现代代码使用 [UN M49 地理分区](https://unstats.un.org/unsd/methodology/m49/overview)，包括将 RUS 归入 Europe 的明确政策。地理分区用于游戏接近反馈，不是历史旗帜转换。当前 784 名车手的 40 个代码为 38 个现代代码加 DDR/RHO，均有显式映射。

历史国家逐条登记：DDR Europe、RHO Africa、CSK Europe、YUG Europe。SUN/USSR 跨洲且未作可靠单洲审核，保留 null；未列代码同样 unavailable。DDR 不映射 DEU 的旗帜，RHO 不映射现代国家旗帜。

补充可复查档案：[Rhodesia 1911 百科](https://en.wikisource.org/wiki/1911_Encyclop%C3%A6dia_Britannica/Rhodesia)、[Czechoslovakia 1922 百科](https://en.wikisource.org/wiki/1922_Encyclop%C3%A6dia_Britannica/Czechoslovakia)、[Yugoslavia 1922 百科](https://en.wikisource.org/wiki/1922_Encyclop%C3%A6dia_Britannica/Yugoslavia)。配置中的部分 Britannica 页面受抓取限制，不能声称本轮已读取其全文；地理映射没有使用机器翻译或根据旗帜推断。所有规则配置内容参与 v3 哈希，修改需发布新独立版本。

## 时间线

输入来自当前 PostgreSQL 的 P1 审核后 race_results.representedConstructor、比赛 season/round/date、稳定 constructor ID。P1 已确认的接替驾驶仍计入正式代表关系，不重新从 grid 推断。按 season/round 排序，相邻已确认代表事件同 constructor 合并；离队后重返单列。首末年份表示已记录代表跨度，期间无赛事不能据此证明连续合同或每年均参赛。

同场多 constructor 标记同 order 的 parallel 阶段，不从数组/字母排序推断驾驶先后。10 名车手涉及这种记录；Bob Scott 与 George Fonder 最后事件均有歧义，lastConstructorId 为 null。constructor 反馈 unavailable，但全部生涯 ID 保留。报告 analysis.json 保存原始成绩引用；正式接口不向普通/困难返回年份、日期、赛事 ID 或原始成绩 ID。

全部 784 个时间线的去重集合与认证 P1 集合精确一致。派生阶段和证据哈希随新快照保存；旧 v1/v2 没有被写入或重解释。
