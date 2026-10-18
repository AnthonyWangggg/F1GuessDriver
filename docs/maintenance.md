# 项目维护指南

## 正式入口与历史记录

启动方式见 [README](../README.md)，API 见 [P2-api.md](P2-api.md)，数据维护见 [P1-database.md](P1-database.md)，运维工具见 [部署入口](../deploy/README.md)。

[production.md](production.md) 与 [deployment-rehearsal.md](deployment-rehearsal.md) 保留早期准备阶段的模板和清单，其中“未部署”及未勾选状态不能用来判断当前服务器。真实状态和审批由部署负责人根据本地证据核对。

阶段目录仍可能被 systemd、测试、封存清单及回滚手册引用，保留原路径。日常维护不应逐个执行 P4 脚本。

## 验证与数据库边界

改动前建立比较基线并查看 dry-run，按 [验证说明](verification.md) 执行。普通单测可明确设置空 `TEST_DATABASE_URL`，避免从本地配置加载测试连接。数据库集成、历史数据库校验、真实对局 E2E 和生产冒烟需要独立操作授权，未运行时记录 NOT_RUN，不能宣称 Full 通过。

视觉基线、历史源、许可和审批资料不作为缓存删除。不得重算或覆盖认证快照，不以当前在线响应替代锁定输入。

## 发布包、更新与回滚

1. 审阅源码与许可范围，运行秘密、publication 和目标平台检查。
2. 使用冻结锁文件在目标平台构建独立包，检查实际依赖、来源页、MIT、第三方通知和国旗资源。
3. 保存源候选和包摘要、平台版本与审批绑定。Windows 验证不代替 Linux 验收。
4. 部署负责人依据有效手册执行获准批次；源码整理不自动改变证书、Origin、CRL、备份与告警。
5. 更新前检查兼容性及回滚依据，旧代码须支持现 Schema 与 v1/v2/v3 契约，不 DROP 字段或覆盖快照。

`pnpm release:pack` 更新本地 `release/latest.txt`。保留旧包和指针证据，区分本地检查包与生产绑定；latest 不是生产状态。`pnpm release:smoke` 操作独立恢复数据库，需要另行批准。

备份与恢复工具见 [production.md](production.md)。Full 不授权恢复，恢复目标须独立批准。真实备份与密钥分开托管，不进入 Git 或 HTTP 包。

## 首次上传

候选清单不是公开授权。`pnpm publication:check` 在私有索引生成精确文件、哈希与候选摘要，保留真实索引；按 data-publication 分类与实际证据检查。最终文件审批须绑定当前摘要。

排除真实配置、私钥、备份、日志、会话记录、local-only 历史资料、阶段运维资料与测试产物。保留必要 data 配置、来源、许可与 migrations，不以源码 MIT 覆盖第三方数据。

软件依赖、数据和品牌审核按所有者确认及保留证据处理。机器可读审批缺失或绑定旧摘要时，保持 publication 阻塞。ICP 尚未确认通过，不推断已获正式公网开放许可。
