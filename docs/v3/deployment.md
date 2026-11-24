# 日常部署与维护

STG 与 PROD 独立运行。发布前核对审查过的提交、宿主机身份和回退目标。部署客户端使用 `F1_DEPLOY_HOST`、`F1_DEPLOY_KNOWN_HOSTS` 和 `F1_DEPLOY_SSH_KEY`。真实配置由维护者在本地管理。

```text
pnpm deploy stg
pnpm deploy prod <STG版本>
pnpm deploy rollback
```

1. `stg` 默认构建干净工作树的 HEAD。记录完整 STG 版本 ID，确认就绪检查和应用冒烟结果。
2. `prod` 晋升已验收的同一 Linux 制品。核对生产备份及隔离恢复回执、迁移审批和 STG 验收记录，保留发布回执。
3. `rollback` 请求回退到控制器记录的版本。若数据库迁移日志不兼容，先在独立 PostgreSQL 恢复备份，核对摘要、目标版本及备份后的写入，再另行批准数据切换。

日常发布从现有双环境开始。首次初始化及故障恢复证据由维护者另行保管。版本和回执留存的自动清理以及证书自动维护仍待验证。检查应用或反向代理故障时，结合受影响环境的服务日志、发布回执和就绪探针定位。

控制器模板及本地测试见 [部署工具](../../deploy/dual/README.md)。数据库维护参考 [备份恢复](../production.md)。
