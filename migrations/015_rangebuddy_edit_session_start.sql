-- Run after 014. Admins can correct the current session's starting mileage.
begin;

create or replace function public.rangebuddy_update_session_start(
    p_van_id integer, p_session_id integer, p_start_kms integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_session public."DriverSessions"%rowtype;
    v_first_entry public."FuelEntries"%rowtype;
    v_lower_bound integer;
    v_first_consumption numeric;
begin
    if p_van_id is null or p_van_id <= 0 or p_session_id is null or p_session_id <= 0
       or p_start_kms is null or p_start_kms < 0 then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;

    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;
    select * into v_session from public."DriverSessions"
    where id = p_session_id and van_id = p_van_id and is_active
      and id = v_van.current_session_id;
    if not found then raise sqlstate 'PT409' using message = 'RB_SESSION_NOT_CURRENT'; end if;

    -- A correction cannot move this session before the van's earlier mileage history.
    select greatest(
        v_van.initial_kms,
        coalesce((select max(current_kms) from public."FuelEntries"
                  where van_id = p_van_id and session_id is distinct from p_session_id), v_van.initial_kms),
        coalesce((select max(start_kms) from public."DriverSessions"
                  where van_id = p_van_id and id <> p_session_id), v_van.initial_kms)
    ) into v_lower_bound;
    if p_start_kms < v_lower_bound then
        raise sqlstate 'PT400' using message = 'RB_SESSION_START_TOO_LOW';
    end if;

    select * into v_first_entry from public."FuelEntries"
    where van_id = p_van_id and session_id = p_session_id order by id limit 1;
    if found then
        if p_start_kms >= v_first_entry.current_kms then
            raise sqlstate 'PT400' using message = 'RB_SESSION_START_BEFORE_REFILL';
        end if;
        v_first_consumption := round(
            v_first_entry.litres * 100 / (v_first_entry.current_kms - p_start_kms), 2
        );
        update public."FuelEntries" set current_consumption = v_first_consumption
        where id = v_first_entry.id;
        if not exists (
            select 1 from public."FuelEntries"
            where session_id = p_session_id and id <> v_first_entry.id
        ) then
            update public."DriverSessions" set average_consumption = v_first_consumption
            where id = p_session_id;
        end if;
    else
        if v_van.last_kms <> v_session.start_kms then
            raise sqlstate 'PT409' using message = 'RB_SESSION_MILEAGE_CONFLICT';
        end if;
        update public."Vans" set last_kms = p_start_kms where id = p_van_id;
    end if;

    update public."DriverSessions" set start_kms = p_start_kms
    where id = p_session_id returning * into v_session;
    return to_jsonb(v_session);
end;
$$;

revoke all on function public.rangebuddy_update_session_start(integer, integer, integer)
    from public, anon, authenticated;
grant execute on function public.rangebuddy_update_session_start(integer, integer, integer)
    to service_role;
notify pgrst, 'reload schema';
commit;
