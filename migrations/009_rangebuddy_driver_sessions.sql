-- Run after 008. Historical entries remain unassigned. Start a session before adding new fuel.
begin;

create table if not exists public."DriverSessions" (
    id integer generated always as identity primary key,
    van_id integer not null references public."Vans"(id) on delete restrict,
    start_kms integer not null check (start_kms >= 0),
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    is_active boolean not null default true,
    average_consumption numeric,
    average_fuel_price numeric,
    unique (id, van_id),
    check (is_active = (ended_at is null)),
    check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists rangebuddy_one_active_session_per_van
    on public."DriverSessions" (van_id) where is_active;
alter table public."Vans" add column if not exists current_session_id integer;
alter table public."FuelEntries" add column if not exists session_id integer;
alter table public."Vans" drop constraint if exists rangebuddy_current_session_fk;
alter table public."Vans" add constraint rangebuddy_current_session_fk
    foreign key (current_session_id, id) references public."DriverSessions"(id, van_id);
alter table public."FuelEntries" drop constraint if exists rangebuddy_entry_session_fk;
alter table public."FuelEntries" add constraint rangebuddy_entry_session_fk
    foreign key (session_id, van_id) references public."DriverSessions"(id, van_id);
create index if not exists rangebuddy_entries_session_idx on public."FuelEntries" (session_id, id);

create or replace function public.rangebuddy_start_session(p_van_id integer, p_start_kms integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_session public."DriverSessions"%rowtype;
begin
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    if v_van.current_session_id is not null or exists (
        select 1 from public."DriverSessions" where van_id = p_van_id and is_active
    ) then raise sqlstate 'PT409' using message = 'RB_SESSION_ALREADY_ACTIVE'; end if;
    if p_start_kms is null or p_start_kms < v_van.last_kms then
        raise sqlstate 'PT400' using message = 'RB_SESSION_START_KMS';
    end if;
    insert into public."DriverSessions" (van_id, start_kms) values (p_van_id, p_start_kms)
        returning * into v_session;
    update public."Vans" set current_session_id = v_session.id, last_kms = p_start_kms where id = p_van_id;
    return to_jsonb(v_session);
end;
$$;

create or replace function public.rangebuddy_stop_session(p_van_id integer, p_session_id integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_session public."DriverSessions"%rowtype;
begin
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    -- An explicit session id prevents a delayed stop request from closing a newer session.
    if p_session_id is null or v_van.current_session_id is distinct from p_session_id then
        raise sqlstate 'PT409' using message = 'RB_SESSION_NOT_CURRENT';
    end if;
    update public."DriverSessions" set is_active = false, ended_at = clock_timestamp()
        where id = p_session_id and van_id = p_van_id and is_active returning * into v_session;
    if not found then raise sqlstate 'PT409' using message = 'RB_NO_ACTIVE_SESSION'; end if;
    update public."Vans" set current_session_id = null where id = p_van_id;
    return to_jsonb(v_session);
end;
$$;

create or replace function public.rangebuddy_current_session(p_van_id integer, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_session public."DriverSessions"%rowtype;
begin
    select * into v_van from public."Vans" where id = p_van_id for share;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    if p_token_hash is not null and v_van.token_hash is distinct from p_token_hash then
        raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
    end if;
    select * into v_session from public."DriverSessions"
        where id = v_van.current_session_id and van_id = p_van_id and is_active;
    if not found then return null; end if;
    return to_jsonb(v_session);
end;
$$;

create or replace function public.rangebuddy_create_entry(
    p_van_id integer, p_token_hash text, p_current_kms integer,
    p_litres numeric, p_price_per_litre numeric, p_fuel_date timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_entry public."FuelEntries"%rowtype;
    v_previous_kms integer;
    v_consumption numeric;
    v_first_id integer;
    v_first_kms integer;
begin
    if p_van_id is null or p_van_id <= 0 or p_current_kms is null or p_current_kms < 0
       or p_litres is null or p_litres <= 0 or p_litres > 9999999.999
       or p_litres <> round(p_litres, 3)
       or p_price_per_litre is null or p_price_per_litre <= 0 or p_price_per_litre > 99999.999
       or p_price_per_litre <> round(p_price_per_litre, 3)
       or p_fuel_date is null or not isfinite(p_fuel_date) then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then
        if p_token_hash is not null then raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN'; end if;
        raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND';
    end if;
    if p_token_hash is not null and v_van.token_hash is distinct from p_token_hash then
        raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
    end if;
    if v_van.current_session_id is null or not exists (
        select 1 from public."DriverSessions"
        where id = v_van.current_session_id and van_id = p_van_id and is_active
    ) then raise sqlstate 'PT409' using message = 'RB_NO_ACTIVE_SESSION'; end if;
    if p_current_kms <= v_van.last_kms then
        raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
    end if;
    select current_kms into v_previous_kms from public."FuelEntries"
        where session_id = v_van.current_session_id and van_id = p_van_id order by id desc limit 1;
    if v_previous_kms is not null then
        if p_current_kms <= v_previous_kms then
            raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
        end if;
        v_consumption := round(p_litres * 100 / (p_current_kms - v_previous_kms), 2);
    end if;
    insert into public."FuelEntries" (
        van_id, session_id, current_kms, litres, price_per_litre, fuel_date, current_consumption
    ) values (
        p_van_id, v_van.current_session_id, p_current_kms, p_litres, p_price_per_litre, p_fuel_date, v_consumption
    ) returning * into v_entry;
    update public."Vans" set last_kms = p_current_kms where id = p_van_id;

    select id, current_kms into v_first_id, v_first_kms from public."FuelEntries"
        where session_id = v_van.current_session_id order by id limit 1;
    -- Exclude baseline litres; price includes every refill. Never average rounded consumption readings.
    update public."DriverSessions" set
        average_consumption = (
            select round(sum(litres) * 100 / nullif(p_current_kms - v_first_kms, 0), 2)
            from public."FuelEntries" where session_id = v_van.current_session_id and id <> v_first_id
        ),
        average_fuel_price = (
            select round(avg(price_per_litre), 2) from public."FuelEntries"
            where session_id = v_van.current_session_id
        )
        where id = v_van.current_session_id;
    return to_jsonb(v_entry);
end;
$$;

alter table public."DriverSessions" enable row level security;
revoke all on public."DriverSessions" from public, anon, authenticated;
grant select, insert, update on public."DriverSessions" to service_role;
do $$ declare seq text := pg_get_serial_sequence('public."DriverSessions"', 'id'); begin
    execute format('revoke all on sequence %s from public, anon, authenticated', seq);
    execute format('grant usage, select on sequence %s to service_role', seq);
end $$;
revoke all on function public.rangebuddy_start_session(integer, integer) from public, anon, authenticated;
revoke all on function public.rangebuddy_stop_session(integer, integer) from public, anon, authenticated;
revoke all on function public.rangebuddy_current_session(integer, text) from public, anon, authenticated;
revoke all on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.rangebuddy_start_session(integer, integer) to service_role;
grant execute on function public.rangebuddy_stop_session(integer, integer) to service_role;
grant execute on function public.rangebuddy_current_session(integer, text) to service_role;
grant execute on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;
