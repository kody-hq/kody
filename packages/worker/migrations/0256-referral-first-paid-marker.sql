-- First qualifying paid Kody invoice seen on an org (stamped by invoice.paid,
-- write-once). Adding a referrer from the billing page is refused once any
-- org the person owns or bills has one, so a late attribution can never reach
-- an account that already paid.
ALTER TABLE orgs ADD COLUMN referral_first_paid_at TEXT;
