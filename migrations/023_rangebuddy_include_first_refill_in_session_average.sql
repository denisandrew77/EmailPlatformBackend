-- Run after 022. Include the first refill in each session's distance-weighted consumption.
begin;

create or replace function public.rangebuddy_session_consumption_on_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    -- Each refill is full; use raw litres and mileage, not rounded per-entry rates.
    -- Departure fuel level is unknown, so the first interval remains an estimate.
    new.average_consumption := (
        select round(sum(e.litres) * 100 / nullif(max(e.current_kms) - new.start_kms, 0), 2)
        from public."FuelEntries" e
        where e.session_id = new.id and e.van_id = new.van_id
    );
    return new;
end;
$$;

drop trigger if exists rangebuddy_session_consumption_update on public."DriverSessions";
create trigger rangebuddy_session_consumption_update
before update of average_consumption, start_kms on public."DriverSessions"
for each row execute function public.rangebuddy_session_consumption_on_update();

-- Recalculate existing active and completed sessions using the same rule.
update public."DriverSessions" set average_consumption = average_consumption;

revoke all on function public.rangebuddy_session_consumption_on_update()
    from public, anon, authenticated;
grant execute on function public.rangebuddy_session_consumption_on_update() to service_role;

notify pgrst, 'reload schema';
commit;
