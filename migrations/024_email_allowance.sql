begin;

create table public.email_allowance (
    id boolean primary key default true check (id),
    monthly_limit integer check (monthly_limit >= 0),
    reset_date date,
    tracking_since timestamptz not null default now()
);
insert into public.email_allowance (id) values (true);

create table public.email_send_usage (
    id text primary key,
    sent_at timestamptz not null default now(),
    recipient_count integer not null check (recipient_count > 0)
);
create index email_send_usage_sent_at_idx on public.email_send_usage (sent_at);

alter table public.email_allowance enable row level security;
alter table public.email_send_usage enable row level security;
revoke all on public.email_allowance, public.email_send_usage from anon, authenticated;
grant select, update on public.email_allowance to service_role;
grant select, insert on public.email_send_usage to service_role;

create function public.email_usage_total(p_start timestamptz, p_end timestamptz)
returns bigint language sql stable security invoker set search_path = public
as $$
    select coalesce(sum(recipient_count), 0)::bigint
    from public.email_send_usage where sent_at >= p_start and sent_at < p_end;
$$;
revoke all on function public.email_usage_total(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.email_usage_total(timestamptz, timestamptz) to service_role;

commit;
