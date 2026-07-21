-- Remove the old VehicleAvailability -> Companies relationship.
--
-- Run once in the Supabase SQL editor before deploying the updated
-- availability code.

begin;

alter table public."VehicleAvailability"
    add column if not exists "companyName" text;

alter table public."VehicleAvailability"
    add column if not exists "emailAddress" text;

-- Preserve names for existing rows that were created while availability still
-- pointed to Companies through companyId.
do $$
begin
    if exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'VehicleAvailability'
          and column_name = 'companyId'
    ) then
        update public."VehicleAvailability" va
        set "companyName" = c.name
        from public."Companies" c
        where va."companyId" = c.id
          and (va."companyName" is null or va."companyName" = '');
    end if;
end $$;

-- Preserve carrier emails for existing rows by using the ExternalUsers bind.
update public."VehicleAvailability" va
set "emailAddress" = eu."emailAddress"
from public."ExternalUsers" eu
where va."createdByExternalUserId" = eu.id
  and (va."emailAddress" is null or va."emailAddress" = '');

-- New external accounts no longer need to match Companies, so new
-- availability rows no longer need companyId.
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
          and att.attname = 'companyId'
    loop
        execute format(
            'alter table public."VehicleAvailability" drop constraint %I',
            constraint_record.conname
        );
    end loop;
end $$;

drop index if exists public.vehicle_availability_company_idx;

alter table public."VehicleAvailability"
    drop column if exists "companyId";

create index if not exists vehicle_availability_company_name_idx
    on public."VehicleAvailability" ("companyName");

create index if not exists vehicle_availability_email_address_idx
    on public."VehicleAvailability" ("emailAddress");

-- Case-insensitive duplicate email protection for new external accounts.
create unique index if not exists external_users_email_address_lower_unique_idx
    on public."ExternalUsers" (lower("emailAddress"));

commit;
