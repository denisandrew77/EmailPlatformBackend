-- Run after 016. Admin edits and dependent calculations commit together.
begin;

create or replace function public.rangebuddy_update_entry(
    p_entry_id integer, p_current_kms integer, p_litres numeric,
    p_price_per_litre numeric, p_fuel_date timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van_id integer;
    v_van public."Vans"%rowtype;
    v_original public."FuelEntries"%rowtype;
    v_updated public."FuelEntries"%rowtype;
    v_session public."DriverSessions"%rowtype;
    v_entry public."FuelEntries"%rowtype;
    v_previous_kms integer;
    v_next_kms integer;
    v_next_session_start integer;
    v_first_id integer;
    v_first_kms integer;
    v_last_kms integer;
    v_count integer := 0;
begin
    if p_entry_id is null or p_entry_id <= 0
       or p_current_kms is null or p_current_kms < 0
       or p_litres is null or p_litres <= 0 or p_litres > 9999999.999
       or p_litres <> round(p_litres, 3)
       or p_price_per_litre is null or p_price_per_litre <= 0 or p_price_per_litre > 99999.999
       or p_price_per_litre <> round(p_price_per_litre, 3)
       or p_fuel_date is null or not isfinite(p_fuel_date) then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;

    select van_id into v_van_id from public."FuelEntries" where id = p_entry_id;
    if not found then raise sqlstate 'PT404' using message = 'RB_ENTRY_NOT_FOUND'; end if;
    -- The van lock serializes edits with refills, session changes and deletions.
    select * into v_van from public."Vans" where id = v_van_id for update;
    select * into v_original from public."FuelEntries"
    where id = p_entry_id and van_id = v_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_ENTRY_NOT_FOUND'; end if;

    if v_original.session_id is not null then
        select * into v_session from public."DriverSessions"
        where id = v_original.session_id and van_id = v_van_id;
        v_previous_kms := v_session.start_kms;
    end if;
    select current_kms into v_next_kms from public."FuelEntries"
    where van_id = v_van_id and session_id is not distinct from v_original.session_id
      and id > p_entry_id order by id limit 1;
    select current_kms into v_previous_kms from public."FuelEntries"
    where van_id = v_van_id and session_id is not distinct from v_original.session_id
      and id < p_entry_id order by id desc limit 1;
    if v_previous_kms is null and v_original.session_id is not null then
        v_previous_kms := v_session.start_kms;
    end if;
    select start_kms into v_next_session_start from public."DriverSessions"
    where van_id = v_van_id and (v_original.session_id is null or id > v_original.session_id)
    order by id limit 1;

    if (v_previous_kms is not null and p_current_kms <= v_previous_kms)
       or (v_next_kms is not null and p_current_kms >= v_next_kms)
       or (v_next_session_start is not null and p_current_kms > v_next_session_start) then
        raise sqlstate 'PT400' using message = 'RB_ENTRY_MILEAGE_ORDER';
    end if;
    if v_original.current_kms = v_van.last_kms and p_current_kms < v_van.initial_kms then
        raise sqlstate 'PT400' using message = 'RB_ENTRY_MILEAGE_ORDER';
    end if;

    update public."FuelEntries" set
        current_kms = p_current_kms, litres = p_litres,
        price_per_litre = p_price_per_litre, fuel_date = p_fuel_date
    where id = p_entry_id;

    select current_kms into v_previous_kms from public."FuelEntries"
    where van_id = v_van_id and session_id is not distinct from v_original.session_id
      and id < p_entry_id order by id desc limit 1;
    if v_previous_kms is null and v_original.session_id is not null then
        v_previous_kms := v_session.start_kms;
    end if;
    select id, current_kms into v_first_id, v_first_kms from public."FuelEntries"
    where van_id = v_van_id and session_id is not distinct from v_original.session_id
    order by id limit 1;
    for v_entry in
        select * from public."FuelEntries"
        where van_id = v_van_id and session_id is not distinct from v_original.session_id
          and id >= p_entry_id order by id
    loop
        if v_previous_kms is not null and v_entry.current_kms <= v_previous_kms then
            raise sqlstate 'PT400' using message = 'RB_ENTRY_MILEAGE_ORDER';
        end if;
        update public."FuelEntries" set current_consumption = case
            when v_previous_kms is null then null
            else round(v_entry.litres * 100 / (v_entry.current_kms - v_previous_kms), 2)
        end where id = v_entry.id;
        v_previous_kms := v_entry.current_kms;
        v_last_kms := v_entry.current_kms;
    end loop;

    if v_original.session_id is not null then
        select count(*) into v_count from public."FuelEntries"
        where session_id = v_original.session_id;
        update public."DriverSessions" set
            average_consumption = case when v_count = 1 then (
                select current_consumption from public."FuelEntries" where id = v_first_id
            ) else (
                select round(sum(litres) * 100 / (v_last_kms - v_first_kms), 2)
                from public."FuelEntries" where session_id = v_original.session_id and id <> v_first_id
            ) end,
            average_fuel_price = (
                select round(avg(price_per_litre), 2)
                from public."FuelEntries" where session_id = v_original.session_id
            )
        where id = v_original.session_id;
    end if;

    if v_original.current_kms = v_van.last_kms then
        update public."Vans" set last_kms = greatest(
            v_van.initial_kms,
            coalesce((select max(start_kms) from public."DriverSessions" where van_id = v_van_id), v_van.initial_kms),
            coalesce((select max(current_kms) from public."FuelEntries" where van_id = v_van_id), v_van.initial_kms)
        ) where id = v_van_id;
    end if;

    select * into v_updated from public."FuelEntries" where id = p_entry_id;
    return to_jsonb(v_updated);
end;
$$;

revoke all on function public.rangebuddy_update_entry(integer, integer, numeric, numeric, timestamptz)
    from public, anon, authenticated;
grant execute on function public.rangebuddy_update_entry(integer, integer, numeric, numeric, timestamptz)
    to service_role;
notify pgrst, 'reload schema';
commit;
