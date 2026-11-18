-- Admin seat comp on a manual paid plan grant. NULL means no cap (every live
-- seat is covered). A whole number caps how many live Owner, Admin, and Member
-- seats the manual grant covers while the org has no paid Stripe plan; seat
-- additions past it are refused.
ALTER TABLE orgs ADD COLUMN comped_seats INTEGER;
