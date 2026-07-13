-- Run once in the Supabase SQL editor when using the app-managed username/password auth.
-- Existing plain-text passwords will be upgraded to scrypt hashes automatically
-- the next time each user signs in successfully.

alter table public."Users"
    alter column password type text;
