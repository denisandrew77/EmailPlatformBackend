-- Run after 012. Revoking device access also ends the current driving session.
begin;

create or replace function public.rangebuddy_revoke_phone(p_van_id integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_session_stopped boolean := false;
begin
    select * into v_van from public."Vans" where id = p_van_id for update;
    if not found then raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND'; end if;

    if v_van.current_session_id is not null then
        update public."DriverSessions"
        set is_active = false, ended_at = clock_timestamp()
        where id = v_van.current_session_id and van_id = p_van_id and is_active;
        if not found then raise sqlstate 'PT409' using message = 'RB_SESSION_NOT_CURRENT'; end if;
        v_session_stopped := true;
    end if;

    update public."Vans"
    set token_hash = null, current_session_id = null
    where id = p_van_id;
    update public."RangeBuddyActivationCodes" set invalidated_at = clock_timestamp()
    where van_id = p_van_id and consumed_at is null and invalidated_at is null;

    return jsonb_build_object('revoked', true, 'session_stopped', v_session_stopped);
end;
$$;

notify pgrst, 'reload schema';
commit;
