-- Include the 662 emails sent before the counter was installed.
-- Use tracking_since so this correction belongs to the original tracking period.
-- The fixed ID makes this safe to apply again without counting them twice.
begin;
insert into public.email_send_usage (id, sent_at, recipient_count)
select 'historical-emails-before-counter-662', tracking_since, 662
from public.email_allowance
where id = true
on conflict (id) do nothing;
commit;
