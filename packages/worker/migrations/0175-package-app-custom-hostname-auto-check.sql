-- Kody re-checks pending custom hostnames on its own and stops after a
-- timeout. verification_errors_json keeps Cloudflare's latest reasons so the
-- package page can say why a hostname is stuck. check_window_started_at
-- anchors the re-check backoff (NULL falls back to created_at), and a manual
-- sync restarts it. needs_attention_at marks a hostname Kody stopped
-- re-checking because it never went active inside the window.

ALTER TABLE package_app_custom_hostnames
	ADD COLUMN verification_errors_json TEXT;

ALTER TABLE package_app_custom_hostnames
	ADD COLUMN check_window_started_at TEXT;

ALTER TABLE package_app_custom_hostnames
	ADD COLUMN needs_attention_at TEXT;
