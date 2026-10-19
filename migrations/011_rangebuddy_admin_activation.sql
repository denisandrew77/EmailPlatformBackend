-- Run once after 010. This intentionally revokes all existing device tokens.
begin;

create table public."RangeBuddyActivationCodes" (
    id bigint generated always as identity primary key,
    van_id integer not null references public."Vans"(id) on delete cascade,
    code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    invalidated_at timestamptz
);
create unique index rangebuddy_one_pending_code_per_van
    on public."RangeBuddyActivationCodes" (van_id)
    where consumed_at is null and invalidated_at is null;
create unique index rangebuddy_pending_code_hash_unique
    on public."RangeBuddyActivationCodes" (code_hash)
    where consumed_at is null and invalidated_at is null;

create or replace function public.rangebuddy_create_van(p_license_plate text, p_initial_kms integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_plate text := upper(trim(p_license_plate));
begin
    if v_plate is null or length(v_plate) not between 1 and 20
       or v_plate !~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$'
       or p_initial_kms is null or p_initial_kms < 0 then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    insert into public."Vans" (license_plate, activation_date, initial_kms, last_kms)
    values (v_plate, (current_timestamp at time zone 'Europe/Bucharest')::date,
            p_initial_kms, p_initial_kms) returning * into v_van;
    return jsonb_build_object(
        'id', v_van.id, 'license_plate', v_van.license_plate,
        'activation_date', v_van.activation_date,
        'initial_kms', v_van.initial_kms, 'last_kms', v_van.last_kms
    );
end;
$$;

create or replace function public.rangebuddy_issue_code(p_van_id integer, p_code_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_code public."RangeBuddyActivationCodes"%rowtype;
begin
    if p_van_id is null or p_van_id <= 0 or p_code_hash is null
       or p_code_hash !~ '^[a-f0-9]{64}$' then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    perform 1 from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    update public."RangeBuddyActivationCodes" set invalidated_at = clock_timestamp()
    where consumed_at is null and invalidated_at is null and expires_at <= clock_timestamp();
    update public."RangeBuddyActivationCodes" set invalidated_at = clock_timestamp()
    where van_id = p_van_id and consumed_at is null and invalidated_at is null;
    insert into public."RangeBuddyActivationCodes" (van_id, code_hash, expires_at)
    values (p_van_id, p_code_hash, now() + interval '24 hours')
    returning * into v_code;
    return jsonb_build_object('expires_at', v_code.expires_at);
end;
$$;

create or replace function public.rangebuddy_redeem_code(p_code_hash text, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_code public."RangeBuddyActivationCodes"%rowtype;
    v_van_id integer;
begin
    if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
       or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    select van_id into v_van_id from public."RangeBuddyActivationCodes"
    where code_hash = p_code_hash and consumed_at is null and invalidated_at is null
      and expires_at > clock_timestamp();
    if not found then raise sqlstate 'PT401' using message = 'RB_INVALID_CODE'; end if;
    select * into v_van from public."Vans" where id = v_van_id for update;
    if not found then raise sqlstate 'PT401' using message = 'RB_INVALID_CODE'; end if;
    select * into v_code from public."RangeBuddyActivationCodes"
    where code_hash = p_code_hash and van_id = v_van_id
      and consumed_at is null and invalidated_at is null for update;
    if not found or v_code.consumed_at is not null or v_code.invalidated_at is not null
       or v_code.expires_at <= clock_timestamp() then
        raise sqlstate 'PT401' using message = 'RB_INVALID_CODE';
    end if;
    update public."RangeBuddyActivationCodes" set consumed_at = clock_timestamp() where id = v_code.id;
    update public."Vans" set token_hash = p_token_hash where id = v_van_id returning * into v_van;
    return jsonb_build_object(
        'id', v_van.id, 'license_plate', v_van.license_plate,
        'activation_date', v_van.activation_date,
        'initial_kms', v_van.initial_kms, 'last_kms', v_van.last_kms
    );
end;
$$;

create or replace function public.rangebuddy_revoke_phone(p_van_id integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
begin
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    update public."Vans" set token_hash = null where id = p_van_id;
    update public."RangeBuddyActivationCodes" set invalidated_at = clock_timestamp()
    where van_id = p_van_id and consumed_at is null and invalidated_at is null;
    return jsonb_build_object('revoked', true);
end;
$$;

drop function if exists public.rangebuddy_activate(text, integer, text);
update public."Vans" set token_hash = null where token_hash is not null;

alter table public."RangeBuddyActivationCodes" enable row level security;
revoke all on public."RangeBuddyActivationCodes" from public, anon, authenticated;
grant select, insert, update on public."RangeBuddyActivationCodes" to service_role;
do $$ declare seq text := pg_get_serial_sequence('public."RangeBuddyActivationCodes"', 'id'); begin
    execute format('revoke all on sequence %s from public, anon, authenticated', seq);
    execute format('grant usage, select on sequence %s to service_role', seq);
end $$;
revoke all on function public.rangebuddy_create_van(text, integer) from public, anon, authenticated;
revoke all on function public.rangebuddy_issue_code(integer, text) from public, anon, authenticated;
revoke all on function public.rangebuddy_redeem_code(text, text) from public, anon, authenticated;
revoke all on function public.rangebuddy_revoke_phone(integer) from public, anon, authenticated;
grant execute on function public.rangebuddy_create_van(text, integer) to service_role;
grant execute on function public.rangebuddy_issue_code(integer, text) to service_role;
grant execute on function public.rangebuddy_redeem_code(text, text) to service_role;
grant execute on function public.rangebuddy_revoke_phone(integer) to service_role;
notify pgrst, 'reload schema';
commit;
