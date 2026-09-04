# Work Calendar

Work Calendar 是一个面向工程项目的排班日历：用月视图管理工单、人员与参与时间段，并在写入前阻止同一人员的时间冲突。它将网页端操作与 Codex Skill 接入同一受控 API，既适合日常排班，也能以自然语言完成查询、预览和经确认后的变更。

项目阶段性进展、已验证数据与待验收项见 [项目进展说明](docs/project_progress.md)。

> 隐私原则：人员 Excel、身份证号、联系方式、真实姓名、密钥和本地环境变量均不进入仓库。`人员名单.xlsx` 被永久忽略，只能在本地受控使用。

## 公开作品集演示

[打开公开演示](https://karma-taylor.github.io/work_calendar/)

该链接部署的是独立的只读版本：其中项目、公司、人员与工种均为虚构示例数据，不连接 Supabase、不读取本机 Excel、不需要登录，也不能创建、编辑或删除工单。它用于展示日历、人员标签和项目详情的交互体验；实际业务环境仍应使用受控登录与服务端授权。

推送到 `main` 后，GitHub Actions 会以 `VITE_DEMO_MODE=true` 自动构建并部署此演示版本到 GitHub Pages。

## 能解决什么问题

- 以月历连续色条直观显示跨天工单，快速掌握项目覆盖范围。
- 为一个工单配置管理人员和工人分段安排；每位工人拥有唯一工种标签。
- 按公司筛选人员，支持搜索、多选、全选、清空和工种标签自动汇总。
- 服务端以匿名人员 ID 校验同一工单内及跨工单的时间重叠，避免重复排班。
- 所有写入先读取最新 revision；数据在另一端更新时返回 `REVISION_MISMATCH`，不会静默覆盖他人的变更。
- 对既有班次的改派、调整日期或取消使用局部读取 → JSON Patch 预览 → 用户确认 → 事务级行更新，不会全量重排。
- 支持网页登录和 Codex Skill 共用同一数据、规则、审计与历史快照。

## 使用效果

日常使用中，排班人员可以在一个干净的月视图中完成“查看项目 → 创建工单 → 选择人员 → 设置参与日期 → 保存”的闭环。项目色条让当前月份的安排一目了然；弹窗内会直接显示所选工人的工种标签，减少手工填写和错配。

对于多端协作，网页端、Skill 和 Supabase Edge Function 使用同一套冲突规则。写入冲突、权限不足和过期 revision 都会得到结构化结果与审计记录，而不是覆盖数据或暴露底层异常。

## 技术架构

| 层级 | 技术 | 作用 |
| --- | --- | --- |
| 网页 | React 19、Vite、原生 CSS | 月历、人员选择、登录、工单创建与编辑 |
| 本地名单 | SheetJS (`xlsx`) | 仅在浏览器本地导入和解析受控名单 |
| 权威数据 | Supabase Postgres | 保存当前状态、历史快照、成员、Key 哈希与指标事件 |
| 受控接口 | Supabase Edge Function（TypeScript/Deno） | 身份鉴别、权限控制、schema 校验、冲突校验、revision 写入与审计 |
| 身份验证 | Supabase Magic Link | 仅白名单邮箱可进入网页端 |
| AI 操作 | Codex `work-calendar` Skill | 自然语言查询、预览、确认后写入同一份排班数据 |

浏览器不会直接读写数据库表；`app_state`、历史、成员、Key 和事件均经 Edge Function 访问。浏览器缓存仅用作恢复辅助，不是权威来源。

## 快速开始

### 1. 安装依赖并启动

```bash
npm install
npm run dev
```

浏览器访问 `http://localhost:5173`。本地运行时会从未提交的 `.env` 读取配置。

### 2. 配置网页环境变量

在项目根目录创建 `.env`：

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<Supabase anon key>
VITE_WORK_CALENDAR_API_URL=https://<project-ref>.supabase.co/functions/v1/work-calendar
```

这些变量只用于网页连接；不要填入 service-role key、Skill Key 或任何人员隐私数据。部署到 Cloudflare Pages 等平台时，在平台的私密环境变量中配置相同名称。

### 本地开发进程与临时凭证

请使用固定的启动、停止和凭证审计命令，避免遗留多个 Vite 进程：

```bash
npm run dev:local
npm run stop:local
npm run audit:local-secrets
```

停止脚本只会终止监听 `5173`、`5174`、`4173` 且命令行包含 `vite` 的进程，绝不会终止 PID 1 或其他服务。`audit:local-secrets` 不显示密钥内容；若它发现临时 staging PAT 的标签、候选本地配置引用或当前 shell 的 `SUPABASE_ACCESS_TOKEN`，应先在 Supabase Dashboard 的 Access Tokens 页面撤销该 PAT，并在终端执行 `unset SUPABASE_ACCESS_TOKEN`。

### 3. 登录与导入名单

1. 使用已加入白名单的邮箱请求 Magic Link。
2. 打开邮箱内的一次性链接，回到日历。
3. 在网页中选择本机受控的人员 Excel 导入名单。
4. 创建工单，选择管理人员、工人及参与日期；工种标签会随选中人员自动显示。

名单文件不得提交到 Git。包含身份证号、联系方式或真实姓名的原始文件应只保存在加密或受控的本地位置。

## Supabase 部署

建议先部署到独立 staging 项目并完成验收，再切换生产。

1. 按顺序执行迁移：

   ```text
   supabase/migrations/202608230001_work_calendar_security.sql
   supabase/migrations/202608230002_security_hardening.sql
   supabase/migrations/202608240003_schedule_delta.sql
   supabase/migrations/202609040004_skill_quality_observability.sql
   ```

2. 在 `work_calendar_members` 建立白名单和角色：`viewer` 只读、`scheduler` 可管理工单、`roster_admin` 可管理人员名单与工种。
3. 启用 Supabase Auth 的 Email / Magic Link；将生产站点 URL 加入 Redirect URLs，并配置邮件频率与攻击防护。
4. 部署 `supabase/functions/work-calendar`，并关闭 Edge Function 的 legacy JWT verification。函数自行验证网页 JWT 或 Skill Key。
5. 为函数设置私密变量：

   ```text
   WORK_CALENDAR_ALLOWED_ORIGIN=https://你的站点域名
   WORK_CALENDAR_WORKSPACE_ID=default
   WORK_CALENDAR_SKILL_VERSION=sha256:<已人工批准的-Skill-文件哈希>
   ```

   `WORK_CALENDAR_SKILL_VERSION` 仅用于将已批准的规则版本写入脱敏审计事件；每次人工发布候选 Skill 后同步更新它，不接受客户端传入的版本号。

6. 为 Skill 创建有 `key_id` 的 SHA-256 哈希记录；明文 Key 仅保存在本机的 `WORK_CALENDAR_API_KEY` 环境变量，绝不写入网页、仓库或数据库。
7. 在 Supabase Cron 中每日执行 `select public.purge_work_calendar_retention();`，以清理超过保留期的事件和快照。

### Staging 自动播种与 Patch 演练

播种工具只接受明确标记为 `staging` 的项目 URL，且必须额外传入 `--apply` 才会写入。它生成 50 位虚构化名人员和 12 个跨日虚构工单；不读取 Excel，也不接触生产或真实名单。

```bash
export WORK_CALENDAR_STAGE=staging
export WORK_CALENDAR_API_URL=https://<staging-ref>.supabase.co/functions/v1/work-calendar
export WORK_CALENDAR_API_KEY_ID=<staging-key-id>
# 从本机 Keychain 或私密终端环境注入；不要写入 .env 或仓库
export WORK_CALENDAR_API_KEY="$(security find-generic-password -s <key-id> -a work-calendar-staging -w)"

npm run seed:staging                 # 仅显示将执行的计划
npm run seed:staging -- --apply       # 写入虚构 staging 数据
npm run verify:staging-patch          # 有效预览 + 冲突拒绝
npm run verify:staging-patch -- --apply # 写入一次，再验证陈旧 revision 被拒绝
```

第二次验收会刻意使用第一次写入前的 revision 重新提交同一 Patch，期望得到 `409 REVISION_MISMATCH`。仅限 staging；如需反复测试，请删除并重建 staging 数据，或使用新的虚构项目 ID，绝不可对生产运行。

### GitHub Actions：仅部署 staging 后端

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 会在 `main` 收到推送后依次运行 lint、权限契约测试、Patch 契约测试、Skill 质量契约测试与构建；全部通过才部署 **staging** 的 `work-calendar` Edge Function。请在 GitHub 的 `staging` Environment 中设置下列 Secrets，不能用生产值：

- `SUPABASE_ACCESS_TOKEN`：专用、可轮换的 Supabase PAT；
- `SUPABASE_STAGING_PROJECT_REF`：staging 项目 Ref。

该工作流不运行数据库迁移、不播种数据、不部署生产。迁移仍需先在 staging SQL Editor/CLI 审核并手动执行。

## Codex Skill 工作流

`work-calendar` Skill 适用于排班请求，不用于导入 Excel。标准流程为：

1. 解析用户意图与日期范围。
2. 查询当前人员、项目和最新 revision。
3. 调用服务端预览，检查人员、日期和冲突。
4. 向用户展示变更摘要；仅在用户确认后写入。
5. 若发生 `REVISION_MISMATCH`，提示“数据已在其他端更新”，重新读取后再预览，不自动覆盖。

Skill 输出只使用匿名 ID 和化名，不返回真实姓名或原始名单内容。

## 局部增量排班

既有班次的修改以 assignment 的稳定 ID 作为 `shift_id`。客户端或 Skill 先用
`GET /schedule` 读取目标人员和日期范围，再产生包含旧值断言的 Patch，调用
`POST /schedule/preview` 进行冲突校验；用户确认后才调用 `PATCH /schedule`。数据库会锁定
workspace revision 并只更新 Patch 指向的班次行。若 revision 或旧值已经变化，服务端返回
`REVISION_MISMATCH` 或 `PATCH_PRECONDITION_FAILED`，且不会写入任何行。

示例见 [patch_payload.json](examples/patch_payload.json)。执行新迁移
`202608240003_schedule_delta.sql` 后，旧的全量工单接口仍可使用，并会同步规范化班次投影。

## 安全与可观测性

- 固定单 workspace，客户端传入的 workspace 不被信任。
- 网页 JWT 与 Skill Key 都由服务端验证，并绑定成员角色或可轮换的 `key_id`。
- 所有写入使用显式命令和 `expectedRevision`；空数组不会隐式删除项目。
- 事件审计记录来源、角色、操作、结果、错误码、耗时、revision 和摘要，不保存密钥、原始对话或真实姓名。
- 事件默认保留 90 天，历史快照默认保留 365 天。
- 范围优先读取与精简 payload 控制 Token 成本；服务端记录端到端耗时，目标 P95 不超过 1 秒。
- Skill 失败只可记录脱敏结构化轨迹；候选规则受限编辑、同集评测和人工审批后才可发布。详见 [Skill 质量闭环](docs/skill-quality-loop.md)。

## 质量验证

```bash
npm run lint
npm run build
npm run test:security
npm run test:patch
npm run test:skill-quality
```

中文自然语言指令评测位于 `tests/accuracy-fixtures.json`。将模型解析结果保存为 JSON 后执行：

```bash
npm run eval:intent -- tests/accuracy-fixtures.json results.json
```

核心样例要求意图、人员、日期、项目和变更类型字段完全匹配；`expectedRevision` 则由 Skill 从云端读取并在写入时绑定。

## 仓库边界

允许提交：应用源码、数据库迁移、Edge Function、脱敏测试样例、文档和通用图标。

禁止提交：人员 Excel、身份证号、电话号码、真实姓名、密钥、`.env`、浏览器导出缓存、生产数据库转储或任何可重新识别个人的信息。
