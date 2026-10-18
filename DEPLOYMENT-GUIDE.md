# Driver Guess 日常部署指南

本指南配套的控制器已在本地实现。生产安装、首次蓝绿切换及 GitHub 配置尚未执行，需要批准本次生产改造清单。不要把本地测试通过视为生产上线完成。

本轮试运行准备以 318 文件 `df1b12ac…` 为审计基线。发现的权限与发布兼容缺陷修复后须绑定新的精确摘要，不能继承旧候选审批。GitHub 创建、push、密钥配置和 Actions 实际启用暂缓至生产试运行稳定后。

## 当前真实架构（2026-10-15，只读核实）

公网 `https://f1driverguess.online` 使用 Ubuntu 24.04、Nginx 1.24.0、Node 24.21.0、PostgreSQL 18。主机 2 核，内存 3659 MiB，可用 2809 MiB，Swap 1987 MiB 未使用，根盘可用 46480 MiB。快照时负载 0.02，数据库连接 9/100。

实际 API 为 `f1guessdriver-p4d.service`，覆盖配置将运行目录指向 `/opt/f1guessdriver/releases/public-first-20261014-973cb1c4-prod5`，监听 127.0.0.1:3000。systemd MemoryCurrent 约 58 MiB，进程 RSS 约 107 MiB，二者计量不同。3001 空闲。公网静态根为 `/opt/f1guessdriver/releases/public-web-20261014-03eb3157/dist`。8443 内部 HTTPS 和 18081 CRL 监听继续保留。

当前数据库 `f1guess_prod`，新局锁定 `f1-2026-10-08-994df511b40814a5`（valid v3）。另有 valid v2、valid v1 和一份 invalid v1；16 局均绑定当前 v3。本次没有创建生产游戏。已部署的 games/security/env JS SHA 与本地构建逐项一致，因此版本与身份审计同时有代码和生产文件依据。

游戏会话和反馈在 PostgreSQL；猜测与揭晓使用事务及行锁，恢复读取锁定版本，胜负按 ID。Cookie 为 `f1_player`，Path=/api、Secure、HttpOnly、SameSite=Strict，身份散列存数据库，没有实例内身份密钥。运行角色对快照只有 SELECT，对局有受限写权限；维护角色仍能修改快照，所以“不可变”还需要维护流程约束，不能声称数据库已经禁止所有管理员改写。`/api/ready` 已检查数据库与 valid v3；`/api/health` 仅检查服务响应。

## 日常入口

```sh
pnpm deploy dry-run auto
pnpm deploy preview auto
pnpm verify:standard --dry-run
pnpm verify:standard
```

dry-run 比较 HEAD 与工作树；无 HEAD 使用迭代前的 verify:baseline。共享模块、部署工具和未知改动保守扩大范围。混合变更不能冒充单独页面更新。preview 构建本地静态页面；使用现有 `pnpm dev` 可连本地 API 完整试玩。preview 不代表生产契约验收。

本地封装复用 P4 工具，不重复实现生产依赖打包：

```sh
# 显式设置 DEPLOY_DATASET_VERSION；必须是已认证版本。
pnpm deploy seal web web-20261015-01
# 后端同理：pnpm deploy seal server api-20261015-01
```

seal 实际执行秘密扫描、publication、构建、release:pack、release:inspect；门禁失败不生成部署清单。发布测试需另外按影响范围通过。Windows 产物只用于本地检查；生产包在固定 Node 24.21.0、pnpm 11.25.0 的 Ubuntu 24.04 上使用 frozen-lockfile 构建。清单记录每个文件 SHA256 和受限内部链接，不接受包外链接。

生产安装批准并完成后，由受限 SSH 入口执行：

```sh
ssh f1deploy@HOST 'deploy web web-20261015-01 MANIFEST_SHA256'
ssh f1deploy@HOST 'deploy server api-20261015-01 MANIFEST_SHA256'
ssh f1deploy@HOST 'deploy data data-20261015-01 MANIFEST_SHA256'
ssh f1deploy@HOST 'verify auto'
ssh f1deploy@HOST 'rollback auto'
```

MANIFEST_SHA256 必须替换为审核产物 manifest 的 64 位 SHA256；控制器将对比它与服务器封存文件，拒绝同 ID 的其他产物。以上是安装后的命令，目前不会在现有服务器工作。激活入口只能使用管理员已经封存的 release ID；它不能上传代码、写批准回执、执行任意 shell 或迁移数据库。混合前后端变更先发布兼容后端，再发布前端；需要协调不兼容切换时停止，另行设计。

## 产物、静态缓存与回滚

候选布局如下。所有目录和祖先 root 所有且不可由部署用户写入；API 运行用户只读。不要把 staging 的用户可写目录直接改名后视为封存。

```text
/opt/f1guessdriver/rolling/
  releases/ID/              # 独立 P4 runtime，永不就地覆盖
  manifests/ID.json         # seal 产生的清单，放在包外
  approvals/ID.json         # 管理员按真实门禁和兼容验收写入
  assets/                  # 追加式历史哈希资源，不自动清理
  slots/blue -> ../releases/ID
  slots/green -> ../releases/ID
  slots/blue.env           # 仅 PORT 和 GAME_DATASET_VERSION
  slots/green.env
  routing/locations.conf
  routing/security-headers.conf
  routing/g-UUID/{state.json,site.inc,upstream.inc}
  routing/current -> g-UUID
  routing/pending.json
  routing/last-success.json
```

Vite 已生成带哈希 JS/CSS。每次先校验完整 runtime，追加 assets；同名资源内容不同立即阻止发布。HTML no-cache，哈希资源一年 immutable。旧页面的延迟 chunk 继续从历史 assets 读取；flags 使用重新验证缓存策略。首次迁移前必须导入现有公网和内部仍在使用的 assets。没有自动 GC：用户页面可能长期打开，不能用“保留最近两个版本”承诺永不缺 chunk。sudo 读取的当前独立 runtime 约 47.8 MiB，公网静态目录约 1.48 MiB；新增一个 runtime 约需 48 MiB，两份约 96 MiB，具体按每轮包与 assets 新增字节建立容量预算，低于 1 GiB 空间禁止激活。

root 管理员回执的最小格式如下；这是格式说明，不是可直接放行的批准文件：

```json
{
  "manifestSha256": "替换为本轮精确清单摘要",
  "publication": "PASS",
  "tests": "PASS",
  "compatibility": "expand-only"
}
```

回执必须附真实验收记录并由管理员封存；测试或许可阻塞时不能填 PASS。CI 不能自行生成此 root 信任边界。安装时还要封存控制器与所有导入模块、固定依赖及 SHA；不能让 root 执行 PR 上传的控制器。

## 蓝绿、连接与资源

blue=3000，green=3001，仅 loopback。两套 `f1guessdriver@.service` 使用同一现有秘密环境，再用槽位环境覆盖端口及数据版本。保留 DB_POOL_MAX=5，因此两实例最多 10 个池连接；启动前仍需检查数据库其余连接。模板每实例 MemoryMax=256M、CPUQuota=100%、TasksMax=64；这是上限而非性能承诺。原 p4d unit 当前自启动为 disabled；切换完成后必须明确设置新活动槽的开机启动。当前资源支持短时重叠，尚未做第二实例负载测试；最坏增加一个 256 MiB cgroup 预算及对应数据库负载，仍需实际启动测量。

控制器要求启动前后 MemAvailable ≥768 MiB、1 分钟负载 ≤可用核数×0.75、磁盘 ≥1 GiB。先验证旧站，再启动空闲槽，轮询 ready，验证契约、候选创建的 Secure Cookie、跨实例恢复及无 Cookie 拒绝访问。发布探针会创建少量专用正常游戏，不输出 Cookie/游戏 ID/隐藏答案；生产探针写入需包含在批准范围内。切换前数据审计和旧版本回归在隔离库完成，不能拿生产新建游戏代替。

候选健康后、路由切换前先 enable 新槽；切换并验证成功后才 disable 旧槽的开机启动，保留旧进程排空。中断可能留下两个槽均 enabled，但不能只剩旧槽 enabled。unit 的 ExecStartPost 等待本地 ready；首次安装另加 Nginx 的 After=blue/green 排序 drop-in，使开机启动等待已排程实例的启动检查完成。显式故障回滚仅探测目标实例，不要求故障中的当前 API 先通过契约检查。

路由代次包含静态根和 upstream，通过同文件系统 symlink rename 切换，nginx -t 后 reload；公开 HTML 的 X-F1-Release、内容和资源 SHA 必须与代次一致。reload 接受成功不等于 worker 已切换，公开验证才是后续依据。

首次试运行暴露 reload 后立即检查的代次时序问题。修订控制器以 20 秒为每次确认的总截止时间，轮询至连续三次完整目标代次样本通过；旧/新样本交错会清零连续计数。只允许明确已知前一代次的合规响应短暂出现；未知代次、内容错误、资源 SHA/缓存/健康异常立即失败。请求关闭连接、禁用缓存且拒绝重定向；资源同时对比不可变发布目录与追加资源目录。每次样本前后检查 current 与 site/upstream include，发现并发改动即停止。回滚后的确认使用同一收敛机制；超过截止时间仍未确认恢复时，明确记录 recovery-unconfirmed、保留 pending 和两实例，不声称回滚成功。滚动日志仅记录代次、次数、稳定样本数和耗时。

Nginx reload 按官方流程优雅退出旧 worker：已在处理的请求仍由旧实例完成。控制器保留旧 API，发现 shutting-down worker 时禁止再次复用槽位，不强行结束连接。下一次使用旧槽前才 stop，Fastify 现有 SIGTERM close 最长 15 秒，systemd 20 秒。没有在本轮加入 WebSocket；未来长连接需要独立排空设计。单进程限流在双实例重叠期间可能近似翻倍，不能视为全局精确配额。

nginx -t、reload 或公开验证失败时，只在代次仍由本次操作持有时恢复旧指针、再次测试/reload/验证；保留两实例以排空和诊断。并发改动、恢复验证失败、进程被杀或断电时停止自动动作，依据 pending 日志人工恢复。操作锁不会自动抢占；检查 owner.json、实际进程和 Nginx 代次后，管理员才能移除遗留锁。

`rollback auto` 恢复上一次成功操作的前一页面或 API/数据版本，重新执行校验；不恢复数据库，不删除新局或快照。数据回滚后新版本已产生的对局仍需要保留新快照及兼容代码。冷启动候选、两次健康验证和 reload 会影响操作耗时；单主机故障、OOM、数据库锁和不兼容 API 仍是潜在停机点，不能承诺绝对零停机。

## 历史数据更新与 expand/contract

1. 在隔离维护库使用现有分页/断点/重试导入工具，保留来源和许可证据；不能直接在生产执行 data:import、data:stats 或旧版 publish 脚本。
2. 新统计必须插入全新版本；维护流程应比较更新前后所有旧 metadata/stats/timeline 和旧局/反馈摘要。新增车手/constructor 先建立身份映射，禁止通过继承关系合并车队。不能将未知杆位设零。
3. 复用 pole-audit、verify-p32、check-legacy、数据一致性及游戏数据库测试。当前 publish-v3 固定从已认证 v2 复制，不能充当任意新赛季快照生成器。未来赛果更新先产生独立候选并完成新一轮历史审核，再追加导入；本次没有生成或导入新事实。
4. 针对新版本验证统计、身份、全历史答案池、三种难度和新手分组，保留 v1/v2/v3 恢复及继续猜测测试。更新不能自动改变既定比较规则或权重。
5. 管理员批准追加导入批次后，在一个事务中插入新 metadata/stats/timeline 并完成认证；不覆盖旧行，不清理历史局。若需要新的 pole_audits 身份，先审核对应证据。导入本身不改变现有进程的 GAME_DATASET_VERSION。
6. 封存与当前 API 完全相同的 runtime 为新 release ID，仅 manifest.dataset 改为新版本；root 回执再绑定 `dataAuditSha256`，对应 `approvals/ID.data-audit.json` 的精确摘要。该报告必须含 dataset，且 sourcesAndLicense/statistics/driverIdentity/answerPools/difficulties/newVersionRegression/oldSnapshotsUnchanged/oldGamesUnchanged 均为 PASS。不要把这些状态当成报告证据本身。
7. 使用 deploy data 激活空闲实例。新创建局绑定新版本；旧局按自身版本继续。激活点是新 worker 的路由切换，切换前已接受的创建请求仍可能在旧版本完成；这是保留进行中请求的明确边界。

本轮不需要数据库 Schema 变化。后续先 expand 添加兼容且可空字段/新表；索引和回填评估锁时间与磁盘。旧服务与新服务均可运行后才激活。contract 删除/改名/NOT NULL/类型收窄等破坏性变更另行审批，并等待回滚窗口、旧代码与旧局兼容需求关闭；不能把 Migration 或 down migration 当作回滚命令。

## GitHub 与干净历史

`.github/workflows/ci.yml` 在 GitHub 托管 Ubuntu runner 对 PR/main 执行类型、Lint、构建、源码单测、秘密扫描和依赖审计；没有生产环境或密钥，不使用 pull_request_target。私有历史输入不进仓库，CI 明确不运行需要私有 pole audit 的 poles-v2 文件及历史数据库认证；这不是完整发布验收。完整数据/旧局回归结果必须由维护验收另行绑定，不能用源码 CI 代替。

production.yml 仅 main 的手动 dispatch。production-build 环境提供精确 PUBLICATION_APPROVAL_JSON，数据许可和 publication 失败即停止；固定 Actions 提交、Node/pnpm 和锁文件，上传 runtime、manifest 和 SHA256SUMS。production 环境再次人工批准后，仅用受限 SSH 操作已经由管理员审核封存的相同 ID 和同一 manifest SHA，随后 verify。data 操作不重建 runtime，必须输入独立审核封存后的 staged_data_manifest_sha256，服务端仍强制数据报告与旧 runtime 完全一致。上传 artifact 与在服务器封存是独立管理员步骤，目前没有实现自动传包和自动 root 提权接收；这保留最小权限，但尚不是无人干预的一键端到端 CD。

首次安装须在 GitHub 手工设置两个环境的 required reviewers、禁止 self-review、仅允许 main；main 启用 required checks/PR review/禁止强推，工作流与部署脚本设 CODEOWNERS。私有仓库套餐若不支持审批保护，则禁止接入生产密钥，保持人工部署。配置 DEPLOY_HOST、受限部署专用 DEPLOY_SSH_KEY、从现有可信主机记录取得的 DEPLOY_KNOWN_HOSTS；不能在线 ssh-keyscan 后直接信任。不要复用管理员 SSH 身份。

干净源码由 `pnpm repository:prepare` 从实时 publication 候选导出，仅复制校验后的 blob 字节，不复制旧 .git、引用、reflog、对象库、缓存或凭据。首先验证冻结 302 文件源码归档 SHA，再以当前完整候选清单列出后续增删改；原 302 审计不自动批准新增文件。新目录位于 local-private/clean-source/摘要，无远程配置。publication 有阻塞时仍可生成供审核的干净源码，但拒绝初始化提交。批准当前精确候选、重新运行门禁后，使用新输出目录及 `--initialize-reviewed-history` 建立独立首次提交；不得在原 Git 对象库中 filter/rebase 后上传。push/远程创建仍待批准。

## 生产改造批准清单与首次步骤

以下全部尚未执行，应作为同一批次审阅，执行前重新获取实际配置、资源和摘要：

1. 创建 `/opt/f1guessdriver/rolling` 及 root 封存目录；从现有运行包和现有公网静态目录建立 seed release，保留原目录原文件；追加现有旧 chunks。生成 seed 清单与审核回执。
2. 安装经审核编译的控制器到 `/opt/f1guessdriver/maintenance/rolling`，从已封存依赖提供 @f1/shared 等运行导入，保存控制器/依赖 SHA。安装两套模板服务、root/forced dispatcher、最小 sudoers 和只读 rolling.json。新建受限 f1deploy 身份与专用公钥，无端口转发、pty、agent forwarding 和任意命令权限；不是复用 ubuntu 密钥。
   部署账户密码锁定，无附加特权组；home、`.ssh` 和 authorized_keys 全部由 root 所有且不可由部署账户替换。root 包装器在启动 Node 前仅接受完整 deploy/verify/rollback 参数帧，重置环境并 cd /，禁止通过 sudo 调用 dry-run/preview/seal。SSH dispatcher 拒绝 CR/LF，多行输入不能被部分匹配放行。
3. 初始 current 指向 seed/blue=3000，仍由原 p4d 服务承接。`/etc/nginx/conf.d/f1guessdriver-rolling-upstream.conf` 在 http 级 include current/upstream.inc；公网 `/etc/nginx/sites-enabled/f1guessdriver-public-p4f` 替换旧 root/locations 为 current/site.inc，保留原 TLS/域名/安全头/日志政策。内部 `/etc/nginx/sites-enabled/f1guessdriver-internal-crl-v1` 仅把 API 的一个 proxy_pass 改为命名 upstream，保留内部静态根、现有 TLS、CRL 与端口。保留可直接恢复的原 Nginx 文件副本及 SHA。
4. nginx -t、reload，先确认 seed 公网和内部 HTTPS 均正常，再启动 green 并执行包含少量专用游戏的 Cookie/跨实例探针。切 green 后检查旧 worker 完全退出，再停原 p4d；此时 blue=3000 才能交由新模板管理。原 unit/drop-in 保留，不能提前删除。新服务自启动设置只启用当前槽，另一槽按需启动，防止重启后错误启动旧 p4d 占用 3000。新增 `/etc/systemd/system/nginx.service.d/50-f1guessdriver-rolling.conf`，仅添加对 blue/green 的 After 排序；daemon-reload 不重启正在运行的 Nginx。
5. 独立验证 Linux 原子切换、旧标签 chunk、API 旧局恢复、内外部健康、故障回滚、重启启动顺序；记录实际负载与切换耗时。在通过前不声称改造完成。
6. GitHub 仓库、首次 push、密钥与 Actions 启用继续暂缓，不属于本次生产试运行安装申请。日常发布先采用管理员封存加受限 SSH 激活；仍保留独立干净历史要求，不导入旧 Git 对象。

无需更改 PostgreSQL Schema、现有历史数据、网络规则、证书、DNS、备份或告警。任何新增需求超出上述清单时停止该项并说明。

## 查询、诊断和中断恢复

管理员查看 `routing/current/state.json`、pending.json、last-success.json、manifest 和审批摘要，并运行 verify；公网 HTML 响应头 X-F1-Release 显示代次。`journalctl -u f1guessdriver@blue -u f1guessdriver@green --since ...` 查槽位日志；`systemctl show ... -p MemoryCurrent -p NRestarts` 查资源与重启；`nginx -t` 查配置；不输出环境文件、Cookie 或数据库连接串。

若进程中断，先核对 public X-F1-Release、current 指针和 pending 的 previous/next。旧槽 ready、旧版本与原配置已验证且没有并发发布时，管理员可将 current 原子恢复到 pending.previous.generation，nginx -t 后 reload，再验证旧站与内部访问。不要使用 ln -sfn 后无验证地认定成功，不要直接 stop 仍可能承接旧 worker 的实例。没有完整证据时保持两实例并人工诊断。日常 rollback 的自动状态检查拒绝被中断/过时的记录。

依据：[Nginx 优雅重载](https://nginx.org/en/docs/control.html)、[缓存与 root 指令](https://nginx.org/en/docs/http/ngx_http_core_module.html)、[GitHub Actions 安全参考](https://docs.github.com/en/actions/reference/security/secure-use)。
