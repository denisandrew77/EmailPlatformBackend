-- Run after 007. Existing entries remain NULL; new entries store litres per 100 km.
begin;

alter table public."FuelEntries"
    add column if not exists current_consumption numeric;
comment on column public."FuelEntries".current_consumption is
    'Litres per 100 km since the previous recorded fuel entry; NULL without a previous entry.';

create or replace function public.rangebuddy_create_entry(
    p_van_id integer, p_token_hash text, p_current_kms integer,
    p_litres numeric, p_price_per_litre numeric, p_fuel_date timestamptz
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_entry public."FuelEntries"%rowtype;
    v_previous_kms integer;
    v_consumption numeric;
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
    if p_token_hash is not null and v_van.token_hash is distinct from p_token_hash then
        raise sqlstate 'PT401' using message = 'RB_INVALID_TOKEN';
    end if;
    if p_current_kms <= v_van.last_kms then
        raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
    end if;

    -- The van lock serializes submissions; recording order, not fuel_date, defines the previous entry.
    select current_kms into v_previous_kms
    from public."FuelEntries" where van_id = p_van_id
    order by id desc limit 1;
    if v_previous_kms is not null then
        if p_current_kms <= v_previous_kms then
            raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
        end if;
        v_consumption := round(p_litres * 100 / (p_current_kms - v_previous_kms), 2);
    end if;

    insert into public."FuelEntries" (
        van_id, current_kms, litres, price_per_litre, fuel_date, current_consumption
    ) values (
        p_van_id, p_current_kms, p_litres, p_price_per_litre, p_fuel_date, v_consumption
    ) returning * into v_entry;
    update public."Vans" set last_kms = p_current_kms where id = p_van_id;

    return jsonb_build_object(
        'id', v_entry.id, 'van_id', v_entry.van_id, 'current_kms', v_entry.current_kms,
        'litres', v_entry.litres, 'price_per_litre', v_entry.price_per_litre,
        'fuel_date', v_entry.fuel_date, 'current_consumption', v_entry.current_consumption
    );
end;
$$;

revoke all on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz)
    from public, anon, authenticated;
grant execute on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz)
    to service_role;

notify pgrst, 'reload schema';
commit;
