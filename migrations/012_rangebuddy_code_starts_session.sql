-- Run after 011. First phone activation starts the first session at the van's initial kms.
begin;

create or replace function public.rangebuddy_redeem_code(p_code_hash text, p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_van public."Vans"%rowtype;
    v_code public."RangeBuddyActivationCodes"%rowtype;
    v_session public."DriverSessions"%rowtype;
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
    if not found or v_code.expires_at <= clock_timestamp() then
        raise sqlstate 'PT401' using message = 'RB_INVALID_CODE';
    end if;

    if v_van.current_session_id is null then
        -- Only the first activation starts from initial mileage. Later sessions are admin-controlled.
        if v_van.last_kms = v_van.initial_kms
           and not exists (select 1 from public."DriverSessions" where van_id = v_van_id) then
            insert into public."DriverSessions" (van_id, start_kms)
            values (v_van_id, v_van.initial_kms) returning * into v_session;
            update public."Vans" set current_session_id = v_session.id where id = v_van_id;
        end if;
    else
        select * into v_session from public."DriverSessions"
        where id = v_van.current_session_id and van_id = v_van_id and is_active;
        if not found then raise sqlstate 'PT409' using message = 'RB_SESSION_NOT_CURRENT'; end if;
    end if;

    update public."RangeBuddyActivationCodes" set consumed_at = clock_timestamp() where id = v_code.id;
    update public."Vans" set token_hash = p_token_hash where id = v_van_id returning * into v_van;
    return jsonb_build_object(
        'van', jsonb_build_object(
            'id', v_van.id, 'license_plate', v_van.license_plate,
            'activation_date', v_van.activation_date,
            'initial_kms', v_van.initial_kms, 'last_kms', v_van.last_kms
        ),
        'session', to_jsonb(v_session)
    );
end;
$$;

notify pgrst, 'reload schema';
commit;
