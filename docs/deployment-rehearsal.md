# Linux 部署预演、更新与人工验收

本清单为待执行操作，不表示生产服务器已经通过。Windows 发布包仅验证本机，不能直接上传作为 Linux 原生依赖包。具体安全模板见 production.md 与 deploy/。

## 环境与角色

- [ ] 选择受支持 Linux VPS，确认安全更新、防火墙、SSH key、时间同步；只公开80/443，数据库和3000仅loopback，不购买或部署直到授权。
- [ ] 安装 Node 满足根 engines（>=24.12.0 <25）、pnpm精确11.25.0、PostgreSQL兼容大版本及 pg_dump/restore、Nginx、systemd；记录实际版本。用 `pnpm install --frozen-lockfile` 后 Linux 本机 `pnpm release`，核查原生依赖与全部许可。
- [ ] 独立维护角色拥有Migration权限，运行角色只能读历史表、写必要游戏表，只读备份角色；均无superuser/CREATEDB/CREATEROLE。按deploy/roles.sql.example人工替换，不把开发f1角色复用为公网运行角色。
- [ ] 系统服务非特权f1guess；代码root只读，环境文件root:f1guess0640；Postgres scram-sha-256、loopback、连接池10及查询超时。生产凭据重新生成。

## 首次预演

- [ ] 在独立受控数据库恢复已验证加密历史备份。现有恢复工具仅允许空 `f1_restore_test_*`，生产目标禁止传入该工具；管理员生产恢复流程须另行审批，不添加绕过参数。
- [ ] 先记录数据库指纹与完整备份，再以维护身份从锁定源码检查Migration journal并执行 `pnpm db:migrate`；不得清空或覆盖valid快照。迁移后只读验证v1/v2/v3、784合格、1165杆位、675零、109正值、784时间线、11场Indy与旧v1摘要。
- [ ] GAME_DATASET_VERSION 固定 `f1-2026-10-08-994df511b40814a5`；NODE_ENV=production、COOKIE_SECURE=true、TRUST_PROXY=loopback、准确HTTPS ALLOWED_ORIGINS，不读取仓库.env。缺少valid版本须失败，不降级。
- [ ] 替换Nginx域名、可信TLS证书；执行 nginx -t 和 systemd-analyze verify。Nginx覆盖转发IP、同源/api代理、8KiB、HSTS/CSP、日志最小化；ready仅本地。
- [ ] 服务启动、本地health/ready、外部HTTPShealth；实际浏览器Cookie检查Secure/HttpOnly/SameSite=Strict/Path=/api，Origin恶意请求403、旧客户端426、限流429、非法体413、未终局答案拒绝、无owner401。
- [ ] 新游戏搜索/猜测/刷新/reveal/再玩，重启后revealed恢复；v1/v2旧会话继续猜测。不得记录原始Cookie/连接串；SIGTERM停止接受请求、15秒关闭、systemd20秒期限，重启恢复。

## 更新与回滚

使用不可变release目录和摘要清单；在同锁文件平台构建、测试、许可/秘密审核后才批准切换。发布前加密备份、保存Migration journal/三版摘要，独立数据库先迁移和冒烟测试。单实例先完成维护窗口/停写，切换current路径并重启，再检查ready/API/旧游戏；不直接增加多副本绕过单实例限流。

代码回滚只在旧代码能够读取当前Schema/契约/规则版本时切回上一个受检包。v3对局不能交给只支持v1/v2的程序；数据库新增字段不盲目DROP，禁止倒写旧快照。不可兼容迁移必须采用扩展→双版本兼容→切换→延后收缩；失败先停止入口写入并保存现场。

数据库恢复到**新独立目标**，验证所有表指纹/语义、权限、旧反馈和revealed后，管理员另行批准切连接。不能用 --clean 覆盖原库；恢复会失去备份之后的对局，明确RPO/RTO、保存原故障库。WAL/PITR尚未实现，不承诺零数据丢失。

## 备份托管

- [ ] AES-256-GCM认证加密包与32字节密钥分别托管；备份异地受限账户/加密对象存储，密钥独立密码管理或离线托管，不把两者放同一归档/云目录。
- [ ] 独立确认恢复管理员、密钥ID/旧密钥保留/轮换、离线副本；传输认证TLS，库备份不进入Git。ACL/0700/0600、访问日志和备份告警。
- [ ] 7日/4周/12月建议由负责人确认；删除保留期外副本须独立规则和审批，现工具不自动删除。
- [ ] 月度从异地取包+独立取密钥+空测试库实际恢复；逐表摘要与三版语义/会话核验，测耗时并记录RPO/RTO。当前本地恢复成功不等于异地恢复已通过。

## 实机与辅助技术（全部待人工执行）

记录设备/OS/浏览器/辅助技术版本、日期、负责人、结果与隐私审核后的证据；失败必修复复测。

| 环境                          | 核心操作                                                                                                                            | 状态   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 实际iPhone/iPad Safari        | 中文输入法、软键盘自动滚动、地址栏动态高度、非零safe-area、横竖屏、320/375/390等适用宽度、抽屉滚动/关闭、表格sticky、终局资料与刷新 | 未运行 |
| 实际Android Chrome            | 软键盘、拼音选词、搜索建议、防抖、底部抽屉、横滚、旋转、reveal确认/取消/网络不明同步锁定                                            | 未运行 |
| Windows NVDA + Chrome/Firefox | 全程键盘、skiplink、搜索combobox建议朗读、八项反馈/方向、live状态、对话框焦点循环/Escape/返回、表格与时间线滚动、三种终局           | 未运行 |
| iOS/macOS VoiceOver + Safari  | Rotor/触控探索、焦点顺序、模态背景不可访问、国旗代码与反馈描述、unknown与真实0、资料卡和再玩                                        | 未运行 |

自动化四引擎、模拟视口和axe结果只作为补充；不等于实际Safari/Android或WCAG认证。另人工复核axe incomplete、200%/400%缩放、强对比/色觉、reduced-motion和所有中文错误文案。
