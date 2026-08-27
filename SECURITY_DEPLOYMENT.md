# Security deployment checklist

Run this sequence in a new Supabase staging project before touching production.

1. Apply all SQL migrations in order, including `202608240003_schedule_delta.sql`. The third migration creates the normalized shift projection and imports the existing anonymous `app_state` projects. Create the intended web member with an explicit role:

   ```sql
   insert into public.work_calendar_members (email, role)
   values ('owner@example.com', 'roster_admin');
   ```

2. Generate a 32-byte Skill secret locally. Store only its SHA-256 hex digest in the database:

   ```bash
   openssl rand -base64 32
   printf '%s' '<generated-secret>' | shasum -a 256
   ```

   ```sql
   insert into public.work_calendar_api_keys (key_id, key_hash, role)
   values ('codex-primary', '<sha256-hex>', 'roster_admin');
   ```

3. Deploy the Edge Function with `WORK_CALENDAR_ALLOWED_ORIGIN` set to the exact staging web origin and `WORK_CALENDAR_WORKSPACE_ID=default`. Set the function dashboard's legacy JWT verification toggle to **off**, because the function validates both web JWTs and Skill API keys itself. Do not set the retired `WORK_CALENDAR_API_KEY` secret.

4. Schedule `select public.purge_work_calendar_retention();` once daily with Supabase Cron. Configure staging Auth with its staging redirect URL, email rate limit, and attack protection.

5. Verify before production cutover:

   - viewer cannot create, update, delete, change staff, or read metrics;
   - scheduler can change projects but cannot change staff or read metrics;
   - roster_admin can change staff and read metrics;
   - revoked key, invalid key ID, expired key, invalid JWT, and an off-origin browser request are rejected;
   - a missing project in an update is not deleted; deletion requires explicit IDs and a current revision;
   - duplicate assignment, overlapping assignment, invalid role, oversized body, and invalid staff record are rejected;
   - a scoped `GET /schedule` followed by `POST /schedule/preview` and `PATCH /schedule` changes only the requested `shift_id`;
   - stale revision, stale `old` assertion, missing replacement person, incompatible trade, and replacement-person overlap all return errors without changing any shift;
   - event rows contain role and actor identity but no secret or raw prompt.

6. Production cutover: back up anonymous state, apply migrations, deploy the function, create a new production Skill key record, update `WORK_CALENDAR_API_KEY_ID` and the secret in Codex, then revoke every retired key row. Re-run the checks above against production.
