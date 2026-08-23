# Work Calendar

项目排班日历工具，支持：

- 月历项目长条展示
- 管理人员/工人分配
- 同人同时间冲突拦截
- Excel 名单导入（指定 sheet 与列）
- 锁定本地 Excel 并自动检测更新
- 删除模式快速删除工单

## 本地运行

```bash
npm install
npm run dev
```

## 缓存与云端持久化

- 默认始终会写入浏览器本地缓存（`localStorage`）。
- 配置 Supabase 后，工单与人员名单会同步到云端，避免换电脑/清缓存后数据丢失。

### 1) 创建 Supabase 表

在 Supabase SQL Editor 执行：

```sql
create table if not exists public.app_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_state_history (
  id bigint generated always as identity primary key,
  state_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_state_history_state_created
on public.app_state_history(state_id, created_at desc);

alter table public.app_state enable row level security;
alter table public.app_state_history enable row level security;

create policy "allow anon read app_state"
on public.app_state
for select
to anon
using (true);

create policy "allow anon upsert app_state"
on public.app_state
for insert
to anon
with check (true);

create policy "allow anon update app_state"
on public.app_state
for update
to anon
using (true)
with check (true);

create policy "allow anon read app_state_history"
on public.app_state_history
for select
to anon
using (true);

create policy "allow anon insert app_state_history"
on public.app_state_history
for insert
to anon
with check (true);
```

> 说明：这是最简免费方案，适合个人作品演示。正式商用建议加登录与更严格的 RLS 规则。

### 2) 配置环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
VITE_SUPABASE_URL=你的supabase项目url
VITE_SUPABASE_ANON_KEY=你的anon公钥
VITE_APP_WORKSPACE_ID=default
VITE_SUPABASE_TABLE=app_state
VITE_SUPABASE_HISTORY_TABLE=app_state_history
```

Cloudflare Pages 部署时，在项目环境变量中配置同名变量。

## 受控云端与 Codex Skill

本项目不再允许浏览器直接读写 `app_state`。部署前按以下顺序执行：

1. 在 Supabase SQL Editor 执行 `supabase/migrations/202608230001_work_calendar_security.sql`。
2. 在 `work_calendar_members` 中加入允许访问的邮箱，例如：

   ```sql
   insert into public.work_calendar_members (email) values ('you@example.com');
   ```

3. 在 Supabase Auth 中启用 Email / Magic Link，并将站点 URL 加入 Redirect URLs。
4. 部署 `supabase/functions/work-calendar`，并在 Function secrets 中设置：

   ```text
   WORK_CALENDAR_API_KEY=<只给 Codex 使用的随机长密钥>
   WORK_CALENDAR_ALLOWED_ORIGIN=https://你的站点域名
   ```

   `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase Edge Function 运行时提供；服务角色密钥不得配置到网页环境变量。
5. 网页端增加 `VITE_WORK_CALENDAR_API_URL=https://<project-ref>.supabase.co/functions/v1/work-calendar`，并保留现有 `VITE_SUPABASE_URL` 与匿名公钥用于魔法链接登录。
6. 在 Codex 环境设置 `WORK_CALENDAR_API_URL` 与 `WORK_CALENDAR_API_KEY`。全局 Skill 位于 `~/.codex/skills/work-calendar`，无需将密钥写入仓库。

Edge Function 会记录 90 天的受控访问事件。可通过 Skill 的 `metrics` 命令汇总 P95 延迟、越权拦截、token 估算以及 Skill 与网页端的成功创建工单占比。

核心中文指令测试用例位于 `tests/accuracy-fixtures.json`。把模型解析结果保存为 JSON 数组后运行：

```bash
npm run eval:intent -- tests/accuracy-fixtures.json results.json
```

命令仅在全部核心样例字段完全匹配时返回成功。
