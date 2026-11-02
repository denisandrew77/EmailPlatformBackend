-- Run after 018. Create a private Storage bucket named rangebuddy-van-documents
-- in the Supabase dashboard with a 5 MB limit and PDF/JPEG/PNG MIME types.
begin;

create table if not exists public."RangeBuddyVanDocuments" (
    van_id integer not null references public."Vans"(id) on delete cascade,
    document_type text not null check (document_type in (
        'itp_due_date', 'cmr_insurance_due_date', 'casco_insurance_due_date',
        'license_due_date', 'fire_extinguisher_due_date'
    )),
    storage_path text not null,
    original_name text not null,
    mime_type text not null,
    uploaded_at timestamptz not null default now(),
    primary key (van_id, document_type)
);

alter table public."RangeBuddyVanDocuments" enable row level security;
revoke all on public."RangeBuddyVanDocuments" from public, anon, authenticated;
grant select, insert, update, delete on public."RangeBuddyVanDocuments" to service_role;

notify pgrst, 'reload schema';
commit;
