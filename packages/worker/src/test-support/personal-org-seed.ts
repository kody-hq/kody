import type { DatabaseSync } from 'node:sqlite'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

/** Provision personal org rows after a raw SQLite user insert in migrated DB tests. */
export async function provisionPersonalOrgForSqliteUser(
	sqlite: DatabaseSync,
	input: { stableUserId: string; username: string; createdAt?: string },
) {
	await provisionPersonalOrg(createD1FromSqlite(sqlite), {
		stableUserId: input.stableUserId,
		username: input.username,
		createdAt: input.createdAt,
	})
}
