# 首次公开发布授权审核

目标仓库：https://github.com/AnthonyWangggg/F1GuessDriver 。2026-10-09 公开页面显示空仓库；本地 origin 对应此地址。审核不执行 commit、push 或部署。

## 代码与依赖

项目所有者已明确选择自有源代码 MIT，Copyright (c) 2026 WONTONANTI，根 LICENSE 保留标准全文。许可范围见 README 和 [DATA-LICENSES.md](DATA-LICENSES.md)。这项决定不包括第三方数据或最终文件公开批准，更不包括 commit/push。工具验证标准文本，不再要求所有者重复选择源码许可。

`pnpm licenses:inventory` 从当前锁文件安装图生成 `docs/licenses/dependencies.json` 和完整本地发行 LICENSE/COPYING/NOTICE 汇编。清单不含本机路径；包含开发、构建和生产依赖。缺失发行文本或未知许可会非零退出，并成为 publication blocker，不能把 package.json 的许可标识当作完整授权证明。

MPL-2.0 的 axe/lightningcss 属开发或构建工具；本项目没有修改它们的源文件。若以后再分发这些工具或修改其受许可文件，应保留许可、按文件级 copyleft 提供相应源码。前端 CSS 的生成并不等同于再分发构建工具本体；仍需核对最终 bundle 所嵌第三方内容。[MPL 官方 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。MIT/ISC/BSD 保留版权与许可声明；Apache 保留许可及适用 NOTICE。Windows 安装清单不覆盖尚未安装的 Linux 原生可选包，Linux 重建须重新生成清单。

## 历史数据与素材

| 来源/文件                                                     | 实际依据                                                                                                                                                                                                      | 公开前处理                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1DB contributors v2026.16.0，pole-history 夹具及审计派生事实 | 固定版本 [LICENSE](https://github.com/f1db/f1db/blob/v2026.16.0/LICENSE)：CC BY 4.0，本轮实际取得原文                                                                                                         | 署名 F1DB contributors、来源版本与链接、许可链接、说明字段抽取/身份映射/去重/审计变换；不暗示背书    |
| Jolpica API 的结果、身份、统计派生与1951法国夹具              | [TERMS.md](https://github.com/jolpica/jolpica-f1/blob/main/TERMS.md)，2025-08-27版：CC BY-NC-SA 4.0、非商业；商业用途须联系提供方                                                                             | 人工确定用途、派生范围及同许可要求；商业用途需另获许可。不得用 Jolpica 代码 Apache-2.0 覆盖 API 数据 |
| Ergast 继承内容                                               | 旧 terms 页面本轮404，来源链仍需确认                                                                                                                                                                          | 不宣称所有历史内容无条件可再分发；记录 Jolpica 条款及另行授权依据                                    |
| data/reviews、reference-checks、身份/赛事审核、audit.json     | 官方 F1/FIA、IMS、Motor Sport、档案事实及 URL                                                                                                                                                                 | 链接和必要事实不构成整页复制许可；人工核查摘录长度、数据库权利及混合来源，不重新发布网页/PDF/照片    |
| 国旗38个SVG                                                   | lipis/flag-icons 固定 revision 086f7e97d657358203916dbe84f61c2bccaa81eb，[MIT原文](https://raw.githubusercontent.com/lipis/flag-icons/086f7e97d657358203916dbe84f61c2bccaa81eb/LICENSE)，Panayiotis Lipiridis | 保留 public/flags/LICENSE.txt、flag-sources逐个SHA256及署名；旗帜使用仍可能有当地法律限制            |
| 原创线条、方格旗、时间线；真实队标0                           | CSS/本项目原创，无下载官方图片字体                                                                                                                                                                            | 纳入所有者代码许可决定；不冒充官方授权或商标许可                                                     |

CC BY 4.0 允许符合署名要求的再分发；[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 另要求非商业、改编的同许可及无附加限制。数据审核准确不等于获得公开许可。不能声称“事实都不受保护”而跳过数据库及素材审核。

本轮将 10 个混合历史数据/测试事实文件保持本地并排除候选，逐项摘要见 docs/licenses/data-publication.json。源码、原创运行配置、来源说明、许可、Migration 和纯完整性摘要仍保留；没有删除本地证据。公开克隆的完整历史测试需要合法取得私有输入，执行 `pnpm data:check-inputs`；说明见 DATA-LICENSES.md。候选仅为建议，**不是已批准公开**。生产包不再携带混合事实 JSON。

## 不可绕过的审核顺序

发布包扫描包含第三方文件。本轮核查发现dotenv公开说明中的示例键/键标记、node-postgres示例连接及pino-redact测试输入；7个文件8条命中按 `data/security/dependency-example-reviews.json` 的路径、SHA256、规则和理由精确记录为INFO。文件内容/版本变化会失效；本地实际秘密复用始终BLOCKER，不豁免第三方目录或全部测试。依赖附带的技能文字只作发行数据审查，不作为本项目执行指令。

1. 自有代码 MIT 已批准，检查标准 LICENSE 及代码/数据分界；不把这一批准扩展到数据。
2. 明确 Jolpica 非商业用途或书面商业授权；确认 F1DB、混合审核事实、夹具和别名的逐文件再分发范围；补齐所有依赖许可文本。
3. `pnpm security`、`pnpm release` 通过。`pnpm publication:check` 用私有 GIT_INDEX_FILE 检查实际 blob，同时扫描原索引，保存路径、大小、模式、SHA256 到 reports/p4-c1.1/github-candidates.json 和 .txt；不修改用户索引，不创建提交。未知数据、过期摘要、缺失版本证据或冲突均阻塞。
4. 所有者审核最终候选及数据范围后，可在私有 `local-private/publication/approval.json` 人工记录 dataRedistributionEvidence、dependencyReview、fileReview、candidateSha256、dataPolicySha256。字段为人工依据摘要/引用，不填凭据；工具不会自动填写。任何候选或数据策略变化需重新审核。缺少最终批准输出 OWNER_APPROVAL_REQUIRED；真实 commit/push 仍需另行授权。
5. 技术 gate 通过仍不授权提交或推送。所有者审核报告并另行明确允许首次 commit/push；执行前重新检查真实索引与已批准候选完全一致。

未选择许可证、缺少再分发依据、秘密命中、候选未审核或依赖许可证据缺失均 BLOCKER，检查非零退出。生产部署还须完成 Linux、真实设备、备份托管与明确上线授权。
