-- Webhook on/off state lives in enablements since 0180; the Worker no longer
-- reads or writes webhook_endpoints.enabled (#4311).
ALTER TABLE webhook_endpoints DROP COLUMN enabled;
