-- Add a "None" filter without changing the existing six-argument directory RPC.
begin;

create function public.get_company_directory(
    p_search text,
    p_three_tonn boolean,
    p_seven_tonn boolean,
    p_caddy boolean,
    p_limit integer,
    p_offset integer,
    p_none boolean
)
returns table (
    id bigint,
    name text,
    country text,
    "fiscalCode" text,
    "emailAddress" text,
    created_at timestamptz,
    "threeTonnCategory" boolean,
    "sevenTonnCategory" boolean,
    "caddyCategory" boolean,
    unsubscribed boolean,
    "phoneNumber" text,
    "recordType" text,
    "rowKey" text,
    total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
    with filtered as (
        select
            c.id::bigint as id,
            coalesce(c.name, '')::text as name,
            coalesce(c.country, '')::text as country,
            coalesce(c."fiscalCode", '')::text as "fiscalCode",
            coalesce(c."emailAddress", '')::text as "emailAddress",
            c.created_at::timestamptz as created_at,
            coalesce(c."threeTonnCategory", false) as "threeTonnCategory",
            coalesce(c."sevenTonnCategory", false) as "sevenTonnCategory",
            coalesce(c."caddyCategory", false) as "caddyCategory",
            c.unsubscribed,
            coalesce(c."phoneNumber", '')::text as "phoneNumber",
            'company'::text as "recordType",
            ('company-' || c.id)::text as "rowKey"
        from public."Companies" c
        where (
            nullif(trim(p_search), '') is null
            or concat_ws(
                ' ', c.id::text, c.name, c.country, c."fiscalCode",
                c."emailAddress", coalesce(c."phoneNumber", '')
            ) ilike ('%' || trim(p_search) || '%')
        )
        and (
            (not p_three_tonn and not p_seven_tonn and not p_caddy and not p_none)
            or (p_three_tonn and coalesce(c."threeTonnCategory", false))
            or (p_seven_tonn and coalesce(c."sevenTonnCategory", false))
            or (p_caddy and coalesce(c."caddyCategory", false))
            or (p_none and not coalesce(c."threeTonnCategory", false)
                and not coalesce(c."sevenTonnCategory", false)
                and not coalesce(c."caddyCategory", false))
        )
    )
    select
        f.id, f.name, f.country, f."fiscalCode", f."emailAddress", f.created_at,
        f."threeTonnCategory", f."sevenTonnCategory", f."caddyCategory",
        f.unsubscribed, f."phoneNumber", f."recordType", f."rowKey",
        count(*) over() as total_count
    from filtered f
    order by lower(f.name), lower(f."emailAddress"), f.id
    limit greatest(1, least(coalesce(p_limit, 30), 30))
    offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer, boolean)
    from public, anon, authenticated;
grant execute on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer, boolean)
    to service_role;

notify pgrst, 'reload schema';
commit;
