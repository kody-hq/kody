import { env } from 'cloudflare:workers'

/**
 * Workers-unit D1 starts empty. Package-app routing and OAuth always look up
 * custom hostnames, so suites that hit those paths need this table (production
 * applies migration 0128).
 */
export async function ensurePackageAppCustomHostnamesTestSchema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_custom_hostnames (
			id TEXT PRIMARY KEY NOT NULL,
			hostname TEXT NOT NULL,
			binding_kind TEXT NOT NULL CHECK (binding_kind IN ('app', 'org')),
			package_id TEXT,
			org_id TEXT,
			cloudflare_hostname_id TEXT,
			cloudflare_zone_id TEXT,
			hostname_status TEXT NOT NULL DEFAULT 'pending',
			ssl_status TEXT NOT NULL DEFAULT 'pending',
			verified_at TEXT,
			dns_missing_since TEXT,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			CHECK (
				(
					binding_kind = 'app'
					AND package_id IS NOT NULL
					AND org_id IS NULL
				)
				OR (
					binding_kind = 'org'
					AND org_id IS NOT NULL
					AND package_id IS NULL
				)
			),
			CHECK (hostname = lower(hostname)),
			FOREIGN KEY (package_id) REFERENCES saved_packages (id) ON DELETE CASCADE,
			FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE UNIQUE INDEX IF NOT EXISTS package_app_custom_hostnames_hostname_idx
			ON package_app_custom_hostnames (hostname)`,
	).run()
}
