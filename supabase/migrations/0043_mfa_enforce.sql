-- 0043 — Two-factor, enforced where the data is.
--
-- The app asks for the code (shell/TwoFactor.jsx, App.jsx's gate) and the
-- functions refuse an aal1 token once a factor exists (mfaShort in each owner
-- gate). Neither stops a password-only session from reading these tables over
-- /rest/v1 directly — and this Supabase project is shared with four other apps
-- that sign the same account in without any code step. So every boardroom table
-- gets one RESTRICTIVE policy: once the caller has a verified factor, the
-- session must be aal2. Restrictive policies AND with the existing permissive
-- ones, so nothing that was allowed becomes allowed to anyone new; with no
-- factor enrolled this is true for every row and nothing changes at all.
--
-- The check lives in a SECURITY DEFINER function because auth.mfa_factors is
-- not readable by `authenticated`. It answers one boolean about the caller and
-- nothing else. Wrapped as (select …) so Postgres evaluates it once per
-- statement, not once per row.

create or replace function boardroom.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'aal') = 'aal2', false)
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;

revoke all on function boardroom.mfa_ok() from public, anon;
grant execute on function boardroom.mfa_ok() to authenticated;

do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c, pg_namespace n
     where n.oid = c.relnamespace and n.nspname = 'boardroom' and c.relkind = 'r'
  loop
    execute format('drop policy if exists "two-factor when enrolled" on boardroom.%I', t);
    execute format(
      'create policy "two-factor when enrolled" on boardroom.%I as restrictive for all to authenticated
         using ((select boardroom.mfa_ok())) with check ((select boardroom.mfa_ok()))', t);
  end loop;
end $$;
