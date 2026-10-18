# 中文展示配置

阶段 A 的配置位于 `packages/shared/src/localization-catalog.ts`，与历史统计、答案池、规则版本和已保存反馈完全独立。稳定 driverId / constructorId 不变，没有 Migration 或数据库更新。

配置修订 `zh-2026-10-16-2`。首轮 519 人候选经收尾审查撤回 12 人，现收录 507 人中文名、277 人英文回退；784 人资格、三难度及历史统计不变。214 个 constructor 中 139 个已有中文展示名，其余 75 个保留英文。国籍仍使用既有标准代码及中文映射，不据出生地或国旗推断身份。

收尾决定位于 `data/aliases/drivers.zh-reviews.json`：4 个非人物实体、2 个误用车队标签及 6 个生日冲突条目撤回中文名和中文别名，不以修改历史生日来消除冲突。另修订 19 个优先译名；其中 17 个仅核对社区大陆译名事实，仍标记 community，安东内利和贝尔曼核对新华社姓名事实，贝尔曼仅使用有来源的姓氏。保留身份无歧义的旧地区译法作为搜索别名。该记录没有所有者签名，不能代表发布批准。

每项包含 name / aliases / source / status / identity。`owner-reviewed` 是现有所有者明确确认的三名车手；`source-attested` 表示首选名在所列赛事资料中出现；`community` 是精确英文百科身份对应的 Wikidata 中文标签，**不是官方译名或人工认证的历史译名**。aliases 可包含社区地区变体及项目整理的常用简称，其可信状态不等于首选名的官方性。中文姓氏匹配可返回多个车手，不自动消除同姓歧义。

来源：

- Wikidata 结构化标签，CC0，按既有 sourceUrl 的精确 enwiki sitelink 匹配；已改名页面通过 Wikipedia API 的明确重定向链与 wikibase_item 核对，没有使用姓名相似度推测身份。来源 Q ID 逐项保存。研究原始响应及重定向链保留在 `local-private/localization/`，不进入发布包。[Wikidata 数据使用条件](https://www.wikidata.org/wiki/Wikidata:Licensing)；标签不代表赛事官方认证。
- [FIA 2024 中国大奖赛媒体资料第 24 页](https://www.fia.com/sites/default/files/media_kit_-_chinese_gp.pdf#page=24)仅核对姓名及车队名称事实；不复制文本叙述、表格设计、图像、Logo、字体或比赛统计。人名地区变体作为别名，不宣称各译法均为 FIA 用名。
- 原有 `data/aliases/drivers.zh.json` 中的三项所有者确认记录保持不变。
- 17 个高风险地区译法参照 [车手列表大陆译名列](https://zh.wikipedia.org/zh-cn/一级方程式赛车车手列表)核对姓名事实，只记录姓名及来源链接，不复制文章、表格或统计，也不将它们称为官方译名。原文版权不由软件许可再授权。
- [新华社安东内利专访](https://www.xinhuanet.com/sports/20260317/93d6df0bf7d444bd9f7a77cb5b08c98b/c.html)及[贝尔曼图片报道](https://www.xinhuanet.com/politics/20260819/9b4c0a0994f84c709cfb497dcc9e7b87/c.html)只用于姓名事实核对，不复制新闻、摄影或叙述。
- 塞纳采用 [LEGO 的中文塞纳/McLaren 产品说明](https://www.lego.com/cdn/product-assets/product.bi.additional.main.pdf/10330_ZH_BI_Build_Translate.pdf)中出现的“埃尔顿·塞纳”，保留 Wikidata 的“冼拿”地区译法及“塞纳”简称；仅引用姓名事实，不复制产品说明、图片或标志。

简体优先取 zh-cn / zh-hans 标签；仅有 zh 时做字形简化，保留原字形和其他地区标签作为别名。该步骤不把台湾/香港译法冒充大陆官方译法。无法精确匹配、无中文标签或标签含身份疑点时保持英文。审计报告逐人列出已收录译名和待核实者，供后续人工补充；当前不是 784 人全部汉化。

复现：先 `pnpm localization:audit` 只读生成 784 人本地清单；Windows 下 `pwsh -File scripts/research-localization.ps1` 及 `-Kind constructors` 缓存公开标签，`pwsh -File scripts/research-localization-redirects.ps1` 核对重定向，再 `pwsh -File scripts/prepare-localization.ps1` 生成候选并执行 Prettier 格式化。研究脚本有断点缓存和有限请求，主标签请求有有限重试和退避；失败后停止，重跑时使用已有缓存，不在运行时联网。重新运行准备脚本会生成新候选，必须重新审核差异、验证和封存，不能覆盖已批准发布产物。

运行时前后端复用相同配置。API 仍返回英文 givenName/familyName 和唯一 ID，displayNameZh 使用配置覆盖；旧局持久化反馈不改，界面按 ID 展示新译名。constructor 名称仅在界面映射，API 保留原英文，以供 title/回退。对旧后端，新界面也能显示汉化，但新增中文搜索需要新 API，蓝绿期间必须先 API 后静态并验证降级。

许可与发布：CC0 标签不改变历史数据许可；新增姓名事实引用不授予 FIA 商标、图片或原媒体资料的再许可。现有 publication 门禁、四项暂缓许可问题和准确候选所有者批准继续有效，文档不是公开发布授权。Linux 构建/封存与实际 manifest SHA 以发布步骤执行结果为准。

视觉验证使用独立 `local-archive/visual-baselines/driver-guess-2.0-A/`，从已有 p4-g 基线复制后，仅为有意的中文内容差异生成新图；p4-a/p4-b/p4-g 原图保持不变。默认回归比较 2.0-A 新图，旧版专用配置和原始失败记录保留。新截图经过本地人工视觉检查，不能替代最终发布审核。
