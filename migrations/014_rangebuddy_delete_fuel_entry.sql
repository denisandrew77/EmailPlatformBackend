-- Run after 013. Delete a refill and rebuild the affected readings atomically.
begin;

create or replace function public.rangebuddy_delete_entry(p_entry_id integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van_id integer;
    v_van public."Vans"%rowtype;
    v_deleted public."FuelEntries"%rowtype;
    v_session public."DriverSessions"%rowtype;
    v_entry public."FuelEntries"%rowtype;
    v_previous_kms integer;
    v_first_id integer;
    v_first_kms integer;
    v_last_kms integer;
    v_first_consumption numeric;
    v_count integer := 0;
begin
    if p_entry_id is null or p_entry_id <= 0 then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;
    select van_id into v_van_id from public."FuelEntries" where id = p_entry_id;
    if not found then raise sqlstate 'PT404' using message = 'RB_ENTRY_NOT_FOUND'; end if;
    -- Fuel writes lock the van first; use the same order to serialize with them.
    select * into v_van from public."Vans" where id = v_van_id for update;
    select * into v_deleted from public."FuelEntries" where id = p_entry_id and van_id = v_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_ENTRY_NOT_FOUND'; end if;

    if v_deleted.session_id is not null then
        select * into v_session from public."DriverSessions" where id = v_deleted.session_id;
    end if;
    delete from public."FuelEntries" where id = p_entry_id;

    v_previous_kms := v_session.start_kms;
    for v_entry in
        select * from public."FuelEntries"
        where van_id = v_van_id and session_id is not distinct from v_deleted.session_id
        order by id
    loop
        v_count := v_count + 1;
        if v_count = 1 then
            v_first_id := v_entry.id;
            v_first_kms := v_entry.current_kms;
        end if;
        update public."FuelEntries"
        set current_consumption = case when v_previous_kms is null then null
            else round(v_entry.litres * 100 / (v_entry.current_kms - v_previous_kms), 2) end
        where id = v_entry.id;
        if v_count = 1 then
            v_first_consumption := case when v_previous_kms is null then null
                else round(v_entry.litres * 100 / (v_entry.current_kms - v_previous_kms), 2) end;
        end if;
        v_previous_kms := v_entry.current_kms;
        v_last_kms := v_entry.current_kms;
    end loop;

    if v_deleted.session_id is not null then
        update public."DriverSessions" set
            average_consumption = case when v_count = 0 then null
                when v_count = 1 then v_first_consumption
                else (
                    select round(sum(litres) * 100 / (v_last_kms - v_first_kms), 2)
                    from public."FuelEntries" where session_id = v_deleted.session_id and id <> v_first_id
                ) end,
            average_fuel_price = (
                select round(avg(price_per_litre), 2)
                from public."FuelEntries" where session_id = v_deleted.session_id
            )
        where id = v_deleted.session_id;
    end if;

    if v_deleted.current_kms = v_van.last_kms then
        update public."Vans" set last_kms = greatest(
            v_van.initial_kms,
            coalesce((select max(start_kms) from public."DriverSessions" where van_id = v_van_id), v_van.initial_kms),
            coalesce((select max(current_kms) from public."FuelEntries" where van_id = v_van_id), v_van.initial_kms)
        ) where id = v_van_id;
    end if;

    return jsonb_build_object('deleted', true, 'id', p_entry_id);
end;
$$;

grant update, delete on public."FuelEntries" to service_role;
revoke all on function public.rangebuddy_delete_entry(integer) from public, anon, authenticated;
grant execute on function public.rangebuddy_delete_entry(integer) to service_role;
notify pgrst, 'reload schema';
commit;
