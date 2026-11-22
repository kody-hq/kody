CREATE INDEX idx_org_audit_legacy_fill_time
	ON org_audit_events(created_at)
	WHERE action = 'credential.legacy_fill';
