-- Consolidate email recipients and carrier login accounts in Companies.

begin;

alter table public."Companies"
    add column if not exists password text,
    add column if not exists "phoneNumber" text;

-- These may already exist if the earlier external-user category migration was run.
alter table if exists public."ExternalUsers"
    add column if not exists "phoneNumber" text,
    add column if not exists "threeTonnCategory" boolean not null default false,
    add column if not exists "sevenTonnCategory" boolean not null default false,
    add column if not exists "caddyCategory" boolean not null default false;

do $$
declare
    external_account record;
    target_company_id bigint;
begin
    if to_regclass('public."ExternalUsers"') is null then
        return;
    end if;

    for external_account in execute
        'select * from public."ExternalUsers" order by id'
    loop
        select c.id
        into target_company_id
        from public."Companies" c
        where lower(c."emailAddress") = lower(external_account."emailAddress")
        order by c.id
        limit 1;

        if target_company_id is null then
            insert into public."Companies" (
                name,
                country,
                "fiscalCode",
                "emailAddress",
                password,
                "phoneNumber",
                "threeTonnCategory",
                "sevenTonnCategory",
                "caddyCategory",
                created_at
            ) values (
                external_account."companyName",
                '',
                '',
                lower(external_account."emailAddress"),
                external_account.password,
                external_account."phoneNumber",
                external_account."threeTonnCategory",
                external_account."sevenTonnCategory",
                external_account."caddyCategory",
                external_account."createdAt"
            )
            returning id into target_company_id;
        else
            update public."Companies"
            set password = external_account.password,
                "phoneNumber" = coalesce(
                    nullif(external_account."phoneNumber", ''),
                    "Companies"."phoneNumber"
                ),
                "threeTonnCategory" = coalesce("Companies"."threeTonnCategory", false)
                    or external_account."threeTonnCategory",
                "sevenTonnCategory" = coalesce("Companies"."sevenTonnCategory", false)
                    or external_account."sevenTonnCategory",
                "caddyCategory" = coalesce("Companies"."caddyCategory", false)
                    or external_account."caddyCategory"
            where id = target_company_id;
        end if;
    end loop;
end $$;

-- A company is a carrier login account when password is populated.
create unique index if not exists companies_account_email_lower_unique_idx
    on public."Companies" (lower("emailAddress"))
    where password is not null;

-- Replace the old ExternalUsers relationship with the consolidated company id.
do $$
declare
    constraint_record record;
begin
    for constraint_record in
        select con.conname
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
        join unnest(con.conkey) as cols(attnum) on true
        join pg_attribute att on att.attrelid = rel.oid and att.attnum = cols.attnum
        where nsp.nspname = 'public'
          and rel.relname = 'VehicleAvailability'
          and con.contype = 'f'
          and att.attname = 'createdByExternalUserId'
    loop
        execute format(
            'alter table public."VehicleAvailability" drop constraint %I',
            constraint_record.conname
        );
    end loop;
end $$;

alter table public."VehicleAvailability"
    add column if not exists "companyId" bigint;

do $$
begin
    if to_regclass('public."ExternalUsers"') is not null and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'VehicleAvailability'
          and column_name = 'createdByExternalUserId'
    ) then
        execute $update_availability$
            update public."VehicleAvailability" availability
            set "companyId" = matched_account.company_id
            from (
                select
                    external_account.id as external_user_id,
                    (
                        select company.id
                        from public."Companies" company
                        where lower(company."emailAddress") = lower(external_account."emailAddress")
                        order by company.id
                        limit 1
                    ) as company_id
                from public."ExternalUsers" external_account
            ) matched_account
            where availability."createdByExternalUserId" = matched_account.external_user_id
              and matched_account.company_id is not null
        $update_availability$;
    end if;
end $$;

-- Also repairs a partially run migration by matching the contact email copied
-- onto historical availability rows.
update public."VehicleAvailability" availability
set "companyId" = company.id
from public."Companies" company
where availability."companyId" is null
  and nullif(trim(availability."emailAddress"), '') is not null
  and lower(company."emailAddress") = lower(availability."emailAddress");

alter table public."VehicleAvailability"
    drop column if exists "createdByExternalUserId";

alter table public."VehicleAvailability"
    drop constraint if exists vehicle_availability_company_fk;

alter table public."VehicleAvailability"
    add constraint vehicle_availability_company_fk
    foreign key ("companyId")
    references public."Companies"(id)
    on delete set null;

drop index if exists public.vehicle_availability_external_user_idx;
create index if not exists vehicle_availability_company_idx
    on public."VehicleAvailability" ("companyId");

drop table if exists public."ExternalUsers";

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
            (not p_three_tonn and not p_seven_tonn and not p_caddy)
            or (p_three_tonn and c."threeTonnCategory")
            or (p_seven_tonn and c."sevenTonnCategory")
            or (p_caddy and c."caddyCategory")
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

revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from public;
revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from anon;
revoke all on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) from authenticated;
grant execute on function public.get_company_directory(text, boolean, boolean, boolean, integer, integer) to service_role;

commit;
