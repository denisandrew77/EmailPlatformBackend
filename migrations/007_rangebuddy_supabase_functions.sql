-- Run in the existing Supabase project containing public."Vans" and public."FuelEntries".
-- RPC calls are atomic transactions. Only the backend service role can call these functions.
begin;

create or replace function public.rangebuddy_activate(
    p_license_plate text, p_initial_kms integer, p_token_hash text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_plate text := upper(trim(p_license_plate));
    v_created boolean;
begin
    if v_plate is null or length(v_plate) not between 1 and 20
       or v_plate !~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$'
       or p_initial_kms is null or p_initial_kms < 0
       or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;

    insert into public."Vans" (license_plate, activation_date, initial_kms, last_kms, token_hash)
    values (v_plate, (current_timestamp at time zone 'Europe/Bucharest')::date,
            p_initial_kms, p_initial_kms, p_token_hash)
    on conflict (license_plate) do nothing
    returning * into v_van;
    v_created := found;

    if not v_created then
        -- UPDATE waits for concurrent activations and preserves the existing odometer/history.
        update public."Vans" set token_hash = p_token_hash
        where license_plate = v_plate returning * into v_van;
        if not found then
            raise sqlstate '23505' using message = 'RB_ACTIVATION_CONFLICT';
        end if;
    end if;

    return jsonb_build_object('created', v_created, 'van', jsonb_build_object(
        'id', v_van.id, 'license_plate', v_van.license_plate,
        'activation_date', v_van.activation_date,
        'initial_kms', v_van.initial_kms, 'last_kms', v_van.last_kms
    ));
end;
$$;

create or replace function public.rangebuddy_create_entry(
    p_van_id integer, p_token_hash text, p_current_kms integer,
    p_litres numeric, p_price_per_litre numeric, p_fuel_date timestamptz
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_entry public."FuelEntries"%rowtype;
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
        if p_token_hash is not null then
            raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
        end if;
        raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND';
    end if;
    -- NULL is reserved for a verified web admin; only the service role can invoke this RPC.
    if p_token_hash is not null and v_van.token_hash is distinct from p_token_hash then
        raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
    end if;
    if p_current_kms <= v_van.last_kms then
        raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
    end if;

    insert into public."FuelEntries" (van_id, current_kms, litres, price_per_litre, fuel_date)
    values (p_van_id, p_current_kms, p_litres, p_price_per_litre, p_fuel_date)
    returning * into v_entry;
    update public."Vans" set last_kms = p_current_kms where id = p_van_id;

    return jsonb_build_object(
        'id', v_entry.id, 'van_id', v_entry.van_id, 'current_kms', v_entry.current_kms,
        'litres', v_entry.litres, 'price_per_litre', v_entry.price_per_litre, 'fuel_date', v_entry.fuel_date
    );
end;
$$;

create or replace function public.rangebuddy_change_license_plate(
    p_van_id integer, p_token_hash text, p_new_license_plate text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_plate text := upper(trim(p_new_license_plate));
begin
    if p_van_id is null or p_van_id <= 0 or v_plate is null or length(v_plate) not between 1 and 20
       or v_plate !~ '^[A-Z0-9]+([ -][A-Z0-9]+)*$' then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then
        if p_token_hash is not null then
            raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
        end if;
        raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND';
    end if;
    if p_token_hash is not null and v_van.token_hash is distinct from p_token_hash then
        raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
    end if;
    -- The unique constraint is the final protection against concurrent duplicate plates.
    update public."Vans" set license_plate = v_plate where id = p_van_id returning * into v_van;
    return jsonb_build_object(
        'id', v_van.id, 'license_plate', v_van.license_plate,
        'activation_date', v_van.activation_date,
        'initial_kms', v_van.initial_kms, 'last_kms', v_van.last_kms
    );
end;
$$;

revoke all on function public.rangebuddy_activate(text, integer, text) from public, anon, authenticated;
revoke all on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.rangebuddy_change_license_plate(integer, text, text) from public, anon, authenticated;
grant execute on function public.rangebuddy_activate(text, integer, text) to service_role;
grant execute on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) to service_role;
grant execute on function public.rangebuddy_change_license_plate(integer, text, text) to service_role;

alter table public."Vans" enable row level security;
alter table public."FuelEntries" enable row level security;
revoke all on public."Vans", public."FuelEntries" from public, anon, authenticated;
grant select, insert, update on public."Vans" to service_role;
grant select, insert on public."FuelEntries" to service_role;

do $$
declare
    sequence_name text;
begin
    foreach sequence_name in array array[
        pg_get_serial_sequence('public."Vans"', 'id'),
        pg_get_serial_sequence('public."FuelEntries"', 'id')
    ] loop
        if sequence_name is not null then
            execute format('revoke all on sequence %s from public, anon, authenticated', sequence_name);
            execute format('grant usage, select on sequence %s to service_role', sequence_name);
        end if;
    end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
