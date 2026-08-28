# Work Calendar（工程项目智能排班系统）项目进展

> 文档日期：2026-08-28。本文只使用代码、staging 演练和本地测试中已经验证的数据；真实业务使用量、性能 P95 与自然语言采用率尚未达到可对外宣称的统计条件。

## 项目定位

**Work Calendar（自动排班系统，核心负责人）**

**业务背景：** 面向工程项目中多工种、多公司协作的排班场景，解决传统 Excel/人工拖拽排班中人员冲突难发现、多人协作易覆盖、真实名单包含敏感身份信息且不宜公开的问题。项目将网页日历、Supabase 受控后端和 Codex 自然语言 Skill 接入同一份排班状态，实现“查看 → 预览 → 确认 → 局部写入”的可追踪闭环。

## 核心能力

### 1. 局部增量排班，避免全表重排

- 对“将某人某天班次改派给另一人”“调整参与日期”“取消班次”等修改，采用 `GET /schedule` 局部读取 → JSON Patch → 服务端预览 → 显式确认 → `PATCH /schedule` 写入的链路。
- 每条 Patch 绑定稳定 `shift_id`、服务端返回的 `expectedRevision` 和旧值断言；任何变更只影响指定班次，不提交完整项目数组。
- 数据库在事务内锁定 workspace revision；并发修改返回 `409 REVISION_MISMATCH`，不会覆盖另一端更新。

### 2. 以服务端为权威的安全与冲突控制

- 网页 Magic Link 与 Codex Skill Key 均由 Supabase Edge Function 验证，权限模型分为 `viewer`、`scheduler`、`roster_admin` 三个角色。
- 服务端按匿名 `personId` 校验同一工单内、跨工单和日期窗口重叠；工人必须匹配唯一 `tradeTag`，避免人员与工种错配。
- 前端不直接读写 Postgres 表；密钥只保存在运行环境/Keychain，人员 Excel、身份证号、联系方式和真实姓名均被 `.gitignore` 排除。

### 3. 自然语言 Skill 的可控执行体验

- 全局 `work-calendar` Skill 强制执行：范围读取、人员 ID 解析、业务工时策略检查、Markdown Draft/Diff、服务端预览、用户确认、局部 Patch 写入。
- 当发生过期 revision 时，Skill 返回“数据刚刚在其他端更新，本次未写入”的自然语言恢复提示，不自动重试。
- 工时检查使用可配置的业务策略（默认每排班日 8 小时、日上限 8 小时、周上限 48 小时）；它不冒充精确劳动法时刻核算，最终冲突仍由服务端裁决。

### 4. 隐私安全的公开展示与验证环境

- GitHub Pages 部署独立只读演示，使用虚构项目、虚构公司和虚构人员，不连接业务 Supabase 或本地 Excel。
- Staging 播种脚本使用确定性虚构数据，需同时满足精确 staging 域名与 `--apply` 才能写入，避免误触生产。
- 本地凭证审计脚本不会输出密钥，可检查仓库、候选 `.env` 和当前终端是否残留临时部署 Token。

## 已验证关键数据

| 指标 | 当前结果 | 验证方式 |
| --- | --- | --- |
| 前端构建 | 通过 | `npm run build` |
| 代码规范检查 | 通过 | `npm run lint` |
| 权限与安全契约 | 通过 | `npm run test:security` |
| Delta Patch 契约 | 通过 | `npm run test:patch` |
| Patch 有效预览 | `200 OK` | staging `POST /schedule/preview` |
| 时间冲突拦截 | `422 SCHEDULING_CONFLICT` | staging 故意将同工种、同项目重叠班次改派给已排班人员 |
| 并发版本保护 | `409 REVISION_MISMATCH` | staging 成功写入一次后，用旧 revision 重放同一 Patch |
| staging 虚构人员 | 50 人 | 6 名虚构管理人员 + 44 名虚构工人 |
| staging 虚构项目 | 当前 1 / 目标 12 | 已发现旧 RPC 返回解析缺陷；本地已修复，待部署函数后补种其余 11 个项目 |
| 权限角色 | 3 类 | `viewer`、`scheduler`、`roster_admin` |
| 受控排班接口 | 3 个 | 局部读取、预览、事务级 Patch 写入 |
| 事件保留策略 | 90 天 | 数据库清理函数与部署文档已定义 |

## 当前成果表述（可用于作品集）

主导开发工程项目智能排班系统 Work Calendar，将 React 月历、Supabase Edge Function 与 Codex Skill 统一到同一套受控排班接口。系统通过匿名人员 ID、工种标签和服务端时间窗口校验减少错配风险；通过 `expectedRevision` 乐观锁和 JSON Patch 实现局部改派而非全量重排。在 staging 演练中，已验证有效预览、人员重叠拦截和并发版本保护分别返回 `200`、`422`、`409`；同时完成 50 条虚构人员数据的隔离播种、权限契约与 Patch 契约自动化检查。

## 当前交付状态

- **已完成：** 前端月历与人员选择体验、匿名化数据结构、角色权限、Edge Function、Patch 数据模型、Skill Draft/Diff、自动化验证脚本、公开只读演示、staging 种子数据框架。
- **已提交到 GitHub：** `main` 已包含 Delta Patch、安全整改和 staging 工具相关提交。
- **待完成：** 将最新 Edge Function 部署到 staging，补齐剩余 11 个虚构项目；配置 GitHub `SUPABASE_ACCESS_TOKEN` Secret 以启用 CI 自动部署；执行生产切换前的完整权限矩阵、性能与回归验收。

## 尚不可对外承诺的指标

以下指标设计已写入系统，但当前没有真实生产样本或压测报告，不能宣称为项目成果：

- 真实自然语言排班占比；
- Edge Function 端到端 P95 是否稳定小于等于 1 秒；
- 精简 payload 的 Token P50/P95；
- 冻结中文指令集 100% 字段匹配率；
- 真实生产环境的非法越权拦截累计次数。

上线后应以 `work_calendar_events` 的审计事件、固定评测集和压测结果持续填充这些指标，再更新本文件中的“已验证关键数据”。
