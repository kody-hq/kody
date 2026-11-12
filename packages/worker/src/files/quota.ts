import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

export async function readFileStorageQuota(
	db: D1Database,
	fallbackBytes: number,
	orgId?: OwnerId,
) {
	const row = await db
		.prepare(
			`SELECT
				(SELECT included_bytes FROM file_storage_default_quota WHERE id = 1) AS defaultBytes,
				(SELECT included_bytes FROM file_storage_quota_overrides WHERE org_id = ?) AS overrideBytes`,
		)
		.bind(orgId ?? null)
		.first<{ defaultBytes: number | null; overrideBytes: number | null }>()
	const defaultBytes =
		row?.defaultBytes ??
		(Number.isSafeInteger(fallbackBytes) && fallbackBytes > 0
			? fallbackBytes
			: 0)
	const overrideBytes = row?.overrideBytes ?? null
	return {
		defaultBytes,
		overrideBytes,
		includedBytes: overrideBytes ?? defaultBytes,
	}
}
