-- Karteikarten: Logins und Lernfortschritt
-- Einmal im Supabase-Dashboard unter "SQL Editor" ausführen. Mehrfaches Ausführen ist unschädlich.
--
-- Die App (öffentlicher Schlüssel, Rolle "anon") darf die Tabelle NICHT direkt lesen oder schreiben.
-- Sie kann nur zwei Funktionen aufrufen:
--   kk_login(code)          -> { name, progress } für ein bestehendes Konto, sonst null
--   kk_save(code, progress) -> speichert den Fortschritt eines bestehenden Kontos
-- Neue Konten legst nur du an (siehe ganz unten bzw. README).

create table if not exists public.kk_accounts (
  code       text primary key check (code = lower(btrim(code)) and code <> ''),
  name       text not null,
  progress   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.kk_accounts enable row level security;
revoke all on public.kk_accounts from anon, authenticated;

create or replace function public.kk_login(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('name', name, 'progress', progress)
  from public.kk_accounts
  where code = lower(btrim(p_code));
$$;

create or replace function public.kk_save(p_code text, p_progress jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object' then
    return false;
  end if;
  update public.kk_accounts
     set progress = p_progress, updated_at = now()
   where code = lower(btrim(p_code));
  return found;
end;
$$;

revoke all on function public.kk_login(text) from public;
revoke all on function public.kk_save(text, jsonb) from public;
grant execute on function public.kk_login(text) to anon;
grant execute on function public.kk_save(text, jsonb) to anon;

-- Konten anlegen: Login-Code (klein geschrieben) und Anzeigename
insert into public.kk_accounts (code, name) values
  ('silas', 'Silas')
on conflict (code) do nothing;
