-- Run after 017 in the existing Supabase project.
begin;

alter table public."Vans"
    add column if not exists itp_due_date date,
    add column if not exists cmr_insurance_due_date date,
    add column if not exists casco_insurance_due_date date,
    add column if not exists license_due_date date,
    add column if not exists fire_extinguisher_due_date date;

notify pgrst, 'reload schema';
commit;
