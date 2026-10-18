import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { addEmailNotificationDestination } from './destinations.ts'
import {
	type AdminEmailDestinationVerificationError,
	markAdminEmailDestinationVerified,
} from './destination-verification-admin.ts'

function createOwnerDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const email = 'owner@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at
		) VALUES (
			1, 'owner', ${quoteSqlString(email)}, ${quoteSqlString(stableUserId)},
			'test-password-hash', CURRENT_TIMESTAMP
		);
	`)
	sqlite.exec(`INSERT INTO user_roles (user_id, role_id) VALUES (1, 1)`)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
		email,
		stableUserId,
	}
}

test('admin mark destination verified ignores the new-account verification wait', async () => {
	const { sqlite, db, stableUserId } = createOwnerDb()
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'pager@example.com',
	})
	sqlite
		.prepare(
			`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (1, ?, 'pending-hash', ?)`,
		)
		.run(added.destination.id, Date.now() + 60_000)

	const marked = await markAdminEmailDestinationVerified({
		db,
		target: { stableUserId },
		destinationEmail: 'Pager@Example.com',
	})
	expect(marked.destination).toMatchObject({
		id: added.destination.id,
		email: 'pager@example.com',
		verified: true,
	})
	expect(
		sqlite
			.prepare(
				`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations WHERE id = ?`,
			)
			.get(added.destination.id),
	).toEqual({ verified: 1 })
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get(),
	).toEqual({ count: 0 })

	await expect(
		markAdminEmailDestinationVerified({
			db,
			target: { stableUserId },
			destinationEmail: 'pager@example.com',
		}),
	).rejects.toMatchObject({
		code: 'already_verified',
	} satisfies Partial<AdminEmailDestinationVerificationError>)

	await expect(
		markAdminEmailDestinationVerified({
			db,
			target: { stableUserId },
			destinationEmail: 'missing@example.com',
		}),
	).rejects.toMatchObject({ code: 'not_found' })
})
