# 双环境部署工具

[日常 STG、PROD 与回退](../../docs/v3/deployment.md)说明发布流程和批准边界。

- `scripts/dual/deploy.mjs` 是 pnpm 客户端入口，`scripts/dual/release.py` 是宿主机发布控制器。
- `build.sh`、`install-controller.sh`、服务配置和 `*.example` 为部署模板。
- `scripts/dual/` 保留首次初始化与断点恢复工具。首次上线手册和真实授权材料由维护者保存在本地私有归档。

本地运行 `python -B -m unittest discover -s scripts/dual -p "test_*.py"`。配置 `F1_DUAL_TEST_PG_BIN` 与 `F1_DUAL_TEST_BRIDGE` 并完成 `pnpm build` 后，可额外运行需要隔离 PostgreSQL 和本地 HTTP 的场景。
