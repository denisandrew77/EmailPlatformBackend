-- Run after 019. Permanently delete a van and its RangeBuddy history.
begin;

create or replace function public.rangebuddy_delete_van(p_van_id integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_paths jsonb;
begin
    if p_van_id is null or p_van_id <= 0 then
        raise sqlstate 'PT400' using message = 'RB_INVALID_INPUT';
    end if;

    perform 1 from public."Vans" where id = p_van_id for update;
    if not found then
        raise sqlstate 'PT404' using message = 'RB_VAN_NOT_FOUND';
    end if;

    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
    from public."RangeBuddyVanDocuments" where van_id = p_van_id;

    delete from public."FuelEntries" where van_id = p_van_id;
    update public."Vans" set current_session_id = null where id = p_van_id;
    delete from public."DriverSessions" where van_id = p_van_id;
    -- Activation codes and document metadata cascade from Vans.
    delete from public."Vans" where id = p_van_id;

    return jsonb_build_object('deleted', true, 'van_id', p_van_id, 'storage_paths', v_paths);
end;
$$;

revoke all on function public.rangebuddy_delete_van(integer) from public, anon, authenticated;
grant execute on function public.rangebuddy_delete_van(integer) to service_role;

notify pgrst, 'reload schema';
commit;
