-- Paginate and filter Companies and ExternalUsers as one alphabetical directory.

create or replace function public.get_company_directory(
    p_search text default '',
    p_three_tonn boolean default false,
    p_seven_tonn boolean default false,
    p_caddy boolean default false,
    p_limit integer default 30,
    p_offset integer default 0
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
    with directory as (
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
            ''::text as "phoneNumber",
            'company'::text as "recordType",
            ('company-' || c.id)::text as "rowKey"
        from public."Companies" c

        union all

        select
            eu.id::bigint,
            coalesce(eu."companyName", '')::text,
            ''::text,
            ''::text,
            coalesce(eu."emailAddress", '')::text,
            eu."createdAt"::timestamptz,
            false,
            false,
            false,
            null::boolean,
            coalesce(eu."phoneNumber", '')::text,
            'externalUser'::text,
            ('external-user-' || eu.id)::text
        from public."ExternalUsers" eu
    ),
    filtered as (
        select *
        from directory d
        where (
            nullif(trim(p_search), '') is null
            or concat_ws(
                ' ', d.id::text, d.name, d.country, d."fiscalCode",
                d."emailAddress", coalesce(d."phoneNumber", '')
            ) ilike ('%' || trim(p_search) || '%')
        )
        and (
            (not p_three_tonn and not p_seven_tonn and not p_caddy)
            or (p_three_tonn and d."threeTonnCategory")
            or (p_seven_tonn and d."sevenTonnCategory")
            or (p_caddy and d."caddyCategory")
        )
    )
    select
        f.id, f.name, f.country, f."fiscalCode", f."emailAddress", f.created_at,
        f."threeTonnCategory", f."sevenTonnCategory", f."caddyCategory",
        f.unsubscribed, f."phoneNumber", f."recordType", f."rowKey",
        count(*) over() as total_count
    from filtered f
    order by lower(f.name), lower(f."emailAddress"), f."recordType", f.id
    limit greatest(1, least(coalesce(p_limit, 30), 30))
    offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from public;
revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from anon;
revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from authenticated;
grant execute on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) to service_role;
