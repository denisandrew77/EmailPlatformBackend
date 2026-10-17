-- Run after 009. Applies to new entries; existing history is not recalculated.
begin;
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
    -- Without an earlier refill, estimate from departure mileage (starting fuel level is unknown).
    if v_previous_kms is null then
        select start_kms into v_previous_kms from public."DriverSessions" where id = v_van.current_session_id;
    end if;
    if p_current_kms <= v_previous_kms then
        raise sqlstate 'PT400' using message = 'RB_ODOMETER_NOT_INCREASING';
    end if;
    v_consumption := round(p_litres * 100 / (p_current_kms - v_previous_kms), 2);
    insert into public."FuelEntries" (
        van_id, session_id, current_kms, litres, price_per_litre, fuel_date, current_consumption
    ) values (
        p_van_id, v_van.current_session_id, p_current_kms, p_litres, p_price_per_litre, p_fuel_date, v_consumption
    ) returning * into v_entry;
    update public."Vans" set last_kms = p_current_kms where id = p_van_id;

    select id, current_kms into v_first_id, v_first_kms from public."FuelEntries"
        where session_id = v_van.current_session_id order by id limit 1;
    -- Only the single-refill session uses the estimate. Later totals exclude baseline litres.
    update public."DriverSessions" set
        average_consumption = case when v_first_id = v_entry.id then v_consumption else (
            select round(sum(litres) * 100 / nullif(p_current_kms - v_first_kms, 0), 2)
            from public."FuelEntries" where session_id = v_van.current_session_id and id <> v_first_id
        ) end,
        average_fuel_price = (
            select round(avg(price_per_litre), 2) from public."FuelEntries"
            where session_id = v_van.current_session_id
        )
        where id = v_van.current_session_id;
    return to_jsonb(v_entry);
end;
$$;
revoke all on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) from public, anon, authenticated;
grant execute on function public.rangebuddy_create_entry(integer, text, integer, numeric, numeric, timestamptz) to service_role;
notify pgrst, 'reload schema';
commit;
