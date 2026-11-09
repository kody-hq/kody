-- Server-side pause for an execution context: routing skips it (chains
-- record "was paused", automations skip instead of queueing) while the
-- daemon stays connected. Survives offline periods and reboots.
ALTER TABLE execution_contexts ADD COLUMN paused_at TEXT;
ALTER TABLE execution_contexts ADD COLUMN paused_by_user_id TEXT;
ALTER TABLE execution_contexts ADD COLUMN pause_reason TEXT;
