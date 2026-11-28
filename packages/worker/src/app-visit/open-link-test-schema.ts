/** The `appOpenLink` redemption table for tests that start from an empty D1. */
export async function ensureOpenLinkTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_app_open_link_redemptions (
				jti TEXT PRIMARY KEY NOT NULL,
				expires_at TEXT NOT NULL
			)`,
		)
		.run()
}
