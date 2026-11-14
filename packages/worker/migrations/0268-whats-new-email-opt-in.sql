ALTER TABLE users ADD COLUMN whats_new_email_opt_in INTEGER NOT NULL DEFAULT 0
	CHECK (whats_new_email_opt_in IN (0, 1));
ALTER TABLE users ADD COLUMN whats_new_email_opt_in_updated_at TEXT;
ALTER TABLE users ADD COLUMN whats_new_email_opt_in_source TEXT
	CHECK (whats_new_email_opt_in_source IN ('signup', 'settings', 'email_link', 'admin'));
