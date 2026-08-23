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

- 浏览器缓存仅作为离线恢复辅助；受控 Supabase API 是权威数据源。
- 浏览器绝不直接读写 `app_state`、历史、成员、Key 或事件表。

### 网页环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
VITE_SUPABASE_URL=你的supabase项目url
VITE_SUPABASE_ANON_KEY=你的anon公钥
VITE_WORK_CALENDAR_API_URL=https://<project-ref>.supabase.co/functions/v1/work-calendar
```

Cloudflare Pages 部署时，在项目环境变量中配置同名变量。

## 受控云端与 Codex Skill

本项目不再允许浏览器直接读写 `app_state`。部署前按以下顺序执行：

1. 在 staging 和 production 分别依次执行 `supabase/migrations/202608230001_work_calendar_security.sql`、`supabase/migrations/202608230002_security_hardening.sql`。
2. 在 `work_calendar_members` 中加入允许访问的邮箱和角色，例如：

   ```sql
   insert into public.work_calendar_members (email, role) values ('you@example.com', 'roster_admin');
   ```

3. 在 Supabase Auth 中启用 Email / Magic Link，并将站点 URL 加入 Redirect URLs。
4. 生成一个仅给 Skill 使用的新密钥，保存 SHA-256 哈希而非明文：

   ```sql
   insert into public.work_calendar_api_keys (key_id, key_hash, role)
   values ('codex-primary', '<openssl dgst -sha256 输出的十六进制哈希>', 'roster_admin');
   ```

5. 部署 `supabase/functions/work-calendar`，在 Function Settings 关闭 legacy JWT verification（函数会自行验证网页 JWT 与 Skill Key），并在 Function secrets 中设置：

   ```text
   WORK_CALENDAR_ALLOWED_ORIGIN=https://你的站点域名
   WORK_CALENDAR_WORKSPACE_ID=default
   ```

   `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase Edge Function 运行时提供；服务角色密钥不得配置到网页环境变量。
6. 在 Codex 环境设置 `WORK_CALENDAR_API_URL`、`WORK_CALENDAR_API_KEY` 与 `WORK_CALENDAR_API_KEY_ID=codex-primary`。旧的单一 `WORK_CALENDAR_API_KEY` 配置在切换后必须撤销。
7. 在 Supabase Cron 中每日执行 `select public.purge_work_calendar_retention();`，并配置 Auth 的邮件频率、攻击防护和生产 Redirect URL。

Edge Function 会记录最多 90 天的受控访问事件；`app_state_history` 默认保留 365 天。可通过拥有 `roster_admin` 权限的 Skill 查询 P95 延迟、越权拦截、token 估算以及 Skill 与网页端的成功创建工单占比。

核心中文指令测试用例位于 `tests/accuracy-fixtures.json`。把模型解析结果保存为 JSON 数组后运行：

```bash
npm run eval:intent -- tests/accuracy-fixtures.json results.json
```

命令仅在全部核心样例字段完全匹配时返回成功。
