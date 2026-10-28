-- Why a job is off: set when a person or Kody turns it off (scheduler
-- auto-disable, expiry, a finished one-time job, member removal, or a manual
-- turn-off with or without a stated reason). Cleared when the job turns on.
-- Null for jobs that are on and for jobs turned off before this column.

ALTER TABLE jobs ADD COLUMN disabled_reason TEXT;
