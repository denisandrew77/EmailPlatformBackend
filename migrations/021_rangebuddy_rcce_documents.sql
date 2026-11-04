-- Run after 019. Reuse the existing private rangebuddy-van-documents Storage bucket.
begin;

create table if not exists public."RangeBuddyDocuments" (
    document_type text primary key check (document_type in (
        'rcce_policy', 'rcce_payment_confirmation'
    )),
    storage_path text not null,
    original_name text not null,
    mime_type text not null check (mime_type = 'application/pdf'),
    uploaded_at timestamptz not null default now()
);

alter table public."RangeBuddyDocuments" enable row level security;
revoke all on public."RangeBuddyDocuments" from public, anon, authenticated;
grant select, insert, update on public."RangeBuddyDocuments" to service_role;

notify pgrst, 'reload schema';
commit;
