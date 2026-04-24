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

alter table public.app_state enable row level security;

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
```

> 说明：这是最简免费方案，适合个人作品演示。正式商用建议加登录与更严格的 RLS 规则。

### 2) 配置环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
VITE_SUPABASE_URL=你的supabase项目url
VITE_SUPABASE_ANON_KEY=你的anon公钥
VITE_APP_WORKSPACE_ID=default
VITE_SUPABASE_TABLE=app_state
```

Cloudflare Pages 部署时，在项目环境变量中配置同名变量。
