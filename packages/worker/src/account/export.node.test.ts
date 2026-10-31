import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	type AccountExportD1Table,
	type AccountExportFile,
	createAccountExport,
	createAccountExportManifest,
	getAccountExportD1UserColumnCoverage,
	readAccountExportSection,
	resolveAccountExportDbUserId,
} from './export.ts'
import {
	createMigratedDb,
	createMigratedDbWithUser,
	createMailboxBinding,
	createStubNamespace,
	insertTestUser,
	rawMimeReference,
} from '#worker/test-support/account-export.ts'
import { accountUserDataPendingDropTables } from '#worker/account/data-targets.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const exportFor = (env: Env, dbUserId = 1, mcpUserId = 'user-aaa') =>
	createAccountExport({
		env,
		dbUserId,
		mcpUserId: ownerIdFromStored(mcpUserId),
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

function d1Table(
	accountExport: AccountExportFile,
	table: string,
): AccountExportD1Table {
	const section = accountExport.d1[table]
	expect(section, `d1.${table} export section`).toBeDefined()
	if (!section) throw new Error(`Missing d1.${table} export section`)
	return section
}

test('account export D1 coverage includes every live user-owned schema column', () => {
	const db = new DatabaseSync(':memory:')
	// Coverage tracks APP_DB only; jobs tables live in the jobs worker's
	// database and are exported through the JOBS service (ADR 0016).
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	const liveUserColumns = new Set<string>()
	for (const table of tables) {
		if (
			(accountUserDataPendingDropTables as ReadonlyArray<string>).includes(
				table.name,
			)
		) {
			continue
		}
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		for (const column of columns) {
			if (column.name === 'user_id' || column.name.endsWith('_user_id')) {
				liveUserColumns.add(`${table.name}.${column.name}`)
			}
		}
	}
	const coveredColumns = getAccountExportD1UserColumnCoverage()
	const missing = [...liveUserColumns].filter(
		(column) => !coveredColumns.has(column),
	)
	const stale = [...coveredColumns].filter(
		(column) => !liveUserColumns.has(column),
	)
	expect(missing, 'user-owned D1 columns missing from account export').toEqual(
		[],
	)
	expect(stale, 'account export references stale D1 columns').toEqual([])
})

test('account export documents and excludes operator-owned system email rows', async () => {
	const { db } = createMigratedDbWithUser()

	const accountExport = await exportFor({
		APP_DB: db,
		MAILBOX: createMailboxBinding({
			blobReferences: () => [rawMimeReference('user-message')],
		}),
	} as Env)

	for (const table of [
		'email_messages',
		'email_threads',
		'email_attachments',
		'email_delivery_events',
		'entitlement_daily_counters',
	]) {
		expect(accountExport.d1).not.toHaveProperty(table)
	}
	expect(accountExport.manifest.sections.r2_object?.count).toBe(1)
	expect(accountExport.manifest.excludedD1Surfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'system_email_inboxes',
				reason: expect.stringContaining('Operator-owned inbound mail'),
			}),
			expect.objectContaining({
				name: 'system_email_messages',
				reason: expect.stringContaining('operator-owned system email'),
			}),
		]),
	)
})

test('account export includes submitted feedback but excludes reviewer-only relationships', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email,
			category, summary, details, status, reviewed_by_user_id,
			reviewed_at, admin_note, created_at, updated_at
		) VALUES
			('feedback-submitted-by-a', 'user-aaa', 'user-a', 'a@example.com',
				'friction', 'Setup is confusing', 'The setup flow needs clearer guidance.',
				'triaged', 'admin-other', '2026-07-05', 'Needs setup review.',
				'2026-07-04', '2026-07-05'),
			('feedback-reviewed-by-a', 'user-bbb', 'user-b', 'b@example.com',
				'bug', 'Private feedback from B', 'This record belongs only in user B exports.',
				'triaged', 'user-aaa', '2026-07-05', 'Reviewer-only relationship.',
				'2026-07-04', '2026-07-05');
	`)

	const accountExport = await exportFor({ APP_DB: db } as Env)

	const feedbackRows = d1Table(accountExport, 'platform_feedback').rows
	expect(feedbackRows).toEqual([
		expect.objectContaining({
			id: 'feedback-submitted-by-a',
			submitter_user_id: 'user-aaa',
			submitter_username: 'user-a',
			submitter_email: 'a@example.com',
			category: 'friction',
			summary: 'Setup is confusing',
			details: 'The setup flow needs clearer guidance.',
			status: 'triaged',
			created_at: '2026-07-04',
			updated_at: '2026-07-05',
		}),
	])
	const reviewerColumns = ['admin_note', 'reviewed_at', 'reviewed_by_user_id']
	for (const column of reviewerColumns) {
		expect(feedbackRows[0]).not.toHaveProperty(column)
	}
	expect(d1Table(accountExport, 'platform_feedback').redactedColumns).toEqual(
		reviewerColumns,
	)
	expect(
		accountExport.manifest.sections['d1.platform_feedback']?.redactedColumns,
	).toEqual(reviewerColumns)
})

test('account export includes profile fields and social graph edges for either side', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, display_name, bio, profile_visibility
		) VALUES
			(1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05', '2026-07-05',
				'2026-07-05', 'user-aaa', 'User A', 'Builds packages', 'public'),
			(2, 'user-b', 'b@example.com', 'password-hash-b', '2026-07-05', '2026-07-05',
				'2026-07-05', 'user-bbb', 'User B', NULL, 'private');

		INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, published_at
		) VALUES
			('listing-a', 'user-aaa', 'pkg-a', 'src-a', 'demo', '@user-a/demo',
				'Demo listing', '[]', 'MIT', 'commit-a', 'active', '2026-07-05'),
			('listing-b', 'user-bbb', 'pkg-b', 'src-b', 'other', '@user-b/other',
				'Other listing', '[]', 'MIT', 'commit-b', 'active', '2026-07-05');

		INSERT INTO community_activity_events (
			id, actor_user_id, event_type, listing_id, created_at
		) VALUES
			('evt-a', 'user-aaa', 'listing_published', 'listing-b', '2026-07-05'),
			('evt-b', 'user-bbb', 'listing_updated', 'listing-a', '2026-07-05'),
			('evt-c', 'user-bbb', 'listing_published', 'listing-b', '2026-07-05');
	`)

	const accountExport = await exportFor({ APP_DB: db } as Env)

	expect(d1Table(accountExport, 'users').rows).toEqual([
		expect.objectContaining({
			id: 1,
			username: 'user-a',
			email: 'a@example.com',
			display_name: 'User A',
			bio: 'Builds packages',
			profile_visibility: 'public',
		}),
	])
	expect(d1Table(accountExport, 'users').rows[0]).not.toHaveProperty(
		'password_hash',
	)

	expect(d1Table(accountExport, 'community_activity_events').rows).toEqual([
		expect.objectContaining({
			id: 'evt-a',
			actor_user_id: 'user-aaa',
			event_type: 'listing_published',
		}),
	])
	expect(
		accountExport.manifest.sections['d1.community_activity_events']?.count,
	).toBe(1)
})

test('account export separates listing-owner deletion cascades from participant ownership', async () => {
	const { sqlite, db } = createMigratedDb()
	insertTestUser(sqlite, {
		id: 1,
		username: 'owner',
		stableUserId: ownerIdFromStored('user-owner'),
	})
	insertTestUser(sqlite, {
		id: 2,
		username: 'participant',
		stableUserId: ownerIdFromStored('user-participant'),
	})
	sqlite.exec(`
		INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, published_at
		) VALUES (
			'listing-owner', 'user-owner', 'pkg-owner', 'src-owner', 'owned',
			'@owner/owned', 'Owned listing', '[]', 'MIT', 'commit-owner', 'active',
			'2026-07-05'
		);
		INSERT INTO community_ratings (
			id, listing_id, user_id, stars, adaptation_effort, note
		) VALUES (
			'rating-private', 'listing-owner', 'user-participant', 4, 3,
			'private rating note'
		);
		INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id, adoption_note
		) VALUES (
			'fork-private', 'listing-owner', 'user-participant', 'commit-owner',
			'pkg-fork', 'src-fork', 'forked', 'private adoption note'
		);
		INSERT INTO community_reports (
			id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
			reason, resolved_by_user_id
		) VALUES (
			'report-private', 'listing-owner', '@owner/owned', 'user-owner',
			'user-participant', 'private report reason', 'user-moderator'
		);
	`)
	const ownerExport = await exportFor({ APP_DB: db } as Env, 1, 'user-owner')
	expect(d1Table(ownerExport, 'community_ratings').rows).toEqual([])
	expect(d1Table(ownerExport, 'community_forks').rows).toEqual([])
	expect(d1Table(ownerExport, 'community_reports').rows).toEqual([])

	const participantExport = await exportFor(
		{ APP_DB: db } as Env,
		2,
		'user-participant',
	)
	expect(d1Table(participantExport, 'community_ratings').rows).toEqual([
		expect.objectContaining({
			id: 'rating-private',
			note: 'private rating note',
		}),
	])
	expect(d1Table(participantExport, 'community_forks').rows).toEqual([
		expect.objectContaining({
			id: 'fork-private',
			adoption_note: 'private adoption note',
		}),
	])
	expect(d1Table(participantExport, 'community_reports').rows).toEqual([
		expect.objectContaining({
			id: 'report-private',
			reason: 'private report reason',
			reporter_user_id: 'user-participant',
			listing_owner_user_id: '[redacted]',
			resolved_by_user_id: '[redacted]',
		}),
	])
})

test('account write lease repair export redacts the foreign party for both perspectives', async () => {
	const { sqlite, db } = createMigratedDb()
	insertTestUser(sqlite, {
		id: 1,
		username: 'target',
		stableUserId: ownerIdFromStored('user-target'),
	})
	insertTestUser(sqlite, {
		id: 2,
		username: 'admin',
		stableUserId: ownerIdFromStored('user-admin'),
	})
	sqlite.exec(`
		INSERT INTO account_write_lease_repairs (
			id, target_user_id, lease_token, lease_holder, lease_acquired_at,
			repaired_by_user_id, reason, created_at
		) VALUES (
			'repair-a', 'user-target', 'token-a', 'job:run', '2026-07-05',
			'user-admin', 'Confirmed crashed worker', '2026-07-05'
		);
	`)
	const targetExport = await exportFor({ APP_DB: db } as Env, 1, 'user-target')
	expect(d1Table(targetExport, 'account_write_lease_repairs').rows).toEqual([
		expect.objectContaining({
			target_user_id: 'user-target',
			repaired_by_user_id: '[redacted]',
		}),
	])
	const adminExport = await exportFor({ APP_DB: db } as Env, 2, 'user-admin')
	expect(d1Table(adminExport, 'account_write_lease_repairs').rows).toEqual([
		expect.objectContaining({
			target_user_id: '[redacted]',
			repaired_by_user_id: 'user-admin',
		}),
	])
})

test('visitor attribution export keeps the owner-paid sentinel and redacts foreign payers', async () => {
	const { sqlite, db } = createMigratedDbWithUser()
	sqlite.exec(`
		INSERT INTO package_app_visitor_attribution_daily (
			user_id, day, package_id, visitor_user_id, billed_org_id, meter, units
		) VALUES
			('user-aaa', '2026-07-05', 'pkg-a', 'user-ccc', '', 'dynamic_worker_day', 1),
			('user-aaa', '2026-07-05', 'pkg-a', 'user-ccc', 'org-visitor', 'rows_read', 5);
	`)
	const rows = d1Table(
		await exportFor({ APP_DB: db } as Env),
		'package_app_visitor_attribution_daily',
	).rows
	expect(rows.map((row) => row.billed_org_id).sort()).toEqual([
		'',
		'[redacted]',
	])
})

test('createAccountExport redacts secrets and credential-equivalent hashes', async () => {
	const { sqlite, db } = createMigratedDbWithUser()
	insertTestUser(sqlite, {
		id: 2,
		username: 'user-b',
		stableUserId: ownerIdFromStored('user-bbb'),
	})
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('secret-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO secret_entries (
			bucket_id, name, description, encrypted_value, allowed_hosts,
			allowed_packages, lookup_hash, created_at, updated_at
		) VALUES (
			'secret-bucket-a', 'api-key', 'API key', 'encrypted-secret-value',
			'["api.example.com"]', '["@user/pkg"]', 'lookup-hash', '2026-07-05', '2026-07-05'
		);

		INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
		VALUES (1, 1, 'reset-token-hash-a', 2000000000, '2026-07-05');

		INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES
			('memory-a', 'user-aaa', 'Favorite color', 'Blue', 'Likes navy.'),
			('memory-b', 'user-bbb', 'Favorite color', 'Green', 'Likes moss.');
	`)
	const accountExport = await exportFor({
		APP_DB: db,
		STORAGE_RUNNER: createStubNamespace({
			exportStorage: async () => ({
				entries: [],
				truncated: false,
				nextStartAfter: null,
			}),
		}),
	} as unknown as Env)

	expect(accountExport.manifest.security.secretValuesExported).toBe(false)
	expect(d1Table(accountExport, 'users').rows).toEqual([
		expect.not.objectContaining({ password_hash: expect.anything() }),
	])
	expect(d1Table(accountExport, 'secret_entries').rows).toEqual([
		expect.objectContaining({
			bucket_id: 'secret-bucket-a',
			name: 'api-key',
			allowed_hosts: '["api.example.com"]',
			allowed_packages: '["@user/pkg"]',
		}),
	])
	expect(d1Table(accountExport, 'secret_entries').rows[0]).not.toHaveProperty(
		'encrypted_value',
	)
	expect(d1Table(accountExport, 'secret_entries').rows[0]).not.toHaveProperty(
		'lookup_hash',
	)
	expect(d1Table(accountExport, 'password_resets').rows[0]).not.toHaveProperty(
		'token_hash',
	)
	expect(d1Table(accountExport, 'mcp_memories').rows).toEqual([
		expect.objectContaining({ id: 'memory-a', summary: 'Blue' }),
	])
	expect(
		accountExport.manifest.sections['d1.secret_entries']?.redactedColumns,
	).toEqual(['encrypted_value', 'lookup_hash'])
})

test('createAccountExport records partial-failure warnings and section pagination works', async () => {
	const { sqlite, db } = createMigratedDbWithUser()
	sqlite.exec(`
		INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (
			'package-job:pkg-a:job-a', 'user-aaa', 'Archive stand-in', 'source-a',
			'job:archive-a', '{}', 'UTC', '{}', '2026-07-05', '2026-07-05',
			'2026-08-05'
		);
		INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES
			('memory-first', 'user-aaa', 'first', '', ''),
			('memory-second', 'user-aaa', 'second', '', '');
	`)
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: createStubNamespace({
			exportStorage: vi.fn(async () => {
				throw new Error('storage unavailable')
			}),
		}),
		OAUTH_PROVIDER: {
			async listUserGrants() {
				throw new Error('oauth unavailable')
			},
		},
	} as unknown as Env

	const accountExport = await exportFor(env)
	expect(accountExport.manifest.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('Storage runner export failed for job:archive-a'),
			expect.stringContaining('OAuth grant listing failed'),
		]),
	)

	const readMemories = (startAfter?: string) =>
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: ownerIdFromStored('user-aaa'),
			section: 'd1_table',
			table: 'mcp_memories',
			pageSize: 1,
			startAfter,
		})
	const page = await readMemories()
	expect(page.items).toEqual([expect.objectContaining({ subject: 'first' })])
	expect(page.truncated).toBe(true)
	expect(page.nextStartAfter).not.toBeNull()
	const nextPage = await readMemories(page.nextStartAfter ?? undefined)
	expect(nextPage.items).toEqual([
		expect.objectContaining({ subject: 'second' }),
	])
	expect(nextPage.truncated).toBe(false)
	expect(nextPage.nextStartAfter).toBeNull()
})

test('D1 export reads large tables in bounded keyset pages', async () => {
	const rowCounts: Array<number> = []
	const queries: Array<string> = []
	const { sqlite, db } = createMigratedDbWithUser({
		onQueryRows: (rowCount) => rowCounts.push(rowCount),
		onQuery: (query) => queries.push(query),
	})
	const totalRows = 502
	const insert = sqlite.prepare(
		`INSERT INTO mcp_memories (
			id, user_id, subject, summary, details, created_at, updated_at
		) VALUES (?, 'user-aaa', ?, 'Summary', '', '2026-07-05', '2026-07-05')`,
	)
	for (let index = 0; index < totalRows; index += 1) {
		insert.run(`memory-${String(index).padStart(4, '0')}`, `Memory ${index}`)
	}
	sqlite.exec(`
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-aaa', 'package:pkg%3A1', 'package', '2026-07-05', '2026-07-05'
		);
	`)

	const env = { APP_DB: db, MAILBOX: createMailboxBinding() } as Env
	const accountExport = await exportFor(env)
	expect(d1Table(accountExport, 'mcp_memories').rows).toHaveLength(totalRows)
	expect(accountExport.manifest.sections['d1.mcp_memories']?.count).toBe(
		totalRows,
	)
	// The keyset page size is 500 (+1 lookahead row), so no single query may
	// return the whole table.
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(501)

	rowCounts.length = 0
	const seenIds = new Set<string>()
	let startAfter: string | undefined
	let pages = 0
	while (true) {
		const page = await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: ownerIdFromStored('user-aaa'),
			section: 'd1_table',
			table: 'mcp_memories',
			pageSize: 500,
			startAfter,
		})
		pages += 1
		for (const item of page.items as Array<{ id: string }>) {
			seenIds.add(item.id)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(pages).toBe(2)
	expect(seenIds.size).toBe(totalRows)
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(501)

	rowCounts.length = 0
	queries.length = 0
	let oauthPage = 0
	const manifest = await createAccountExportManifest({
		env: {
			APP_DB: db,
			MAILBOX: createMailboxBinding(),
			OAUTH_PROVIDER: {
				async listUserGrants() {
					oauthPage += 1
					return {
						items: [{ id: `grant-${oauthPage}`, clientId: 'client' }],
						cursor: oauthPage < 100 ? String(oauthPage) : undefined,
					}
				},
			},
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
	expect(manifest.sections['d1.mcp_memories']?.count).toBe(totalRows)
	expect(manifest.sections).not.toHaveProperty('d1.email_messages')
	expect(manifest.sections.oauth_grants?.count).toBe(100)
	expect(manifest.sections.storage_runners?.count).toBe(1)
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(1)
	expect(
		queries.some((query) => query.includes('__account_export_rowid')),
	).toBe(false)
})

test('account export reads OAuth grant metadata from OAUTH_KV when the provider helpers are absent', async () => {
	const { db } = createMigratedDbWithUser()
	const storedGrant = (userId: string, grantId: string) =>
		JSON.stringify({
			id: grantId,
			clientId: 'host-client',
			userId,
			scope: ['mcp'],
			metadata: { label: grantId },
			createdAt: 1_700_000_000,
			redirectUri: 'https://host.example/callback',
			encryptedProps: 'ciphertext',
			refreshTokenId: 'refresh-secret',
			refreshTokenWrappedKey: 'wrapped-key',
			previousRefreshTokenId: 'previous-refresh-secret',
			previousRefreshTokenWrappedKey: 'previous-wrapped-key',
			authCodeId: 'auth-code-secret',
			authCodeWrappedKey: 'auth-code-wrapped-key',
			codeChallenge: 'challenge',
			codeChallengeMethod: 'S256',
		})
	const { kv } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': storedGrant('user-aaa', 'grant-1'),
		'grant:user-aaa:grant-2': storedGrant('user-aaa', 'grant-2'),
		'grant:user-bbb:grant-9': storedGrant('user-bbb', 'grant-9'),
		'token:user-aaa:grant-1:tok-1': JSON.stringify({
			id: 'tok-1',
			grantId: 'grant-1',
			userId: ownerIdFromStored('user-aaa'),
			wrappedEncryptionKey: 'token-wrapped-key',
		}),
	})
	const env = {
		APP_DB: db,
		MAILBOX: createMailboxBinding(),
		OAUTH_KV: kv,
	} as Env
	const expectedGrants = ['grant-1', 'grant-2'].map((id) => ({
		id,
		clientId: 'host-client',
		userId: ownerIdFromStored('user-aaa'),
		scope: ['mcp'],
		metadata: { label: id },
		createdAt: 1_700_000_000,
		expiresAt: undefined,
		redirectUri: 'https://host.example/callback',
	}))
	const oauthUnavailableWarning = expect.arrayContaining([
		expect.stringContaining('OAuth grant metadata was not exported'),
	])

	const accountExport = await exportFor(env)
	expect(accountExport.oauthGrants).toEqual(expectedGrants)
	expect(accountExport.manifest.sections.oauth_grants?.count).toBe(2)
	expect(accountExport.manifest.warnings).not.toEqual(oauthUnavailableWarning)
	expect(JSON.stringify(accountExport.oauthGrants)).not.toMatch(
		/ciphertext|refresh-secret|wrapped-key|auth-code-secret|challenge/,
	)

	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
	expect(manifest.sections.oauth_grants?.count).toBe(2)
	expect(manifest.warnings).not.toEqual(oauthUnavailableWarning)

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
		section: 'oauth_grants',
	})
	expect(section.items).toEqual(expectedGrants)
	expect(section.warnings).not.toEqual(oauthUnavailableWarning)

	const withoutOAuthSurface = await exportFor({
		APP_DB: db,
		MAILBOX: createMailboxBinding(),
	} as Env)
	expect(withoutOAuthSurface.oauthGrants).toEqual([])
	expect(withoutOAuthSurface.manifest.warnings).toContain(
		'OAuth provider binding and OAUTH_KV were unavailable; OAuth grant metadata was not exported.',
	)
})

test('distinct personal org resolves export identity and splits oauth vs inventory ids', async () => {
	const { db } = createMigratedDb()
	const email = 'distinct-export@example.com'
	const personStable = testStableUserIdFromEmail(email)
	const personUserId = personIdFromStored(personStable)
	const ownerUserId = ownerIdFromStored('d'.repeat(64))
	expect(ownerUserId).not.toBe(personUserId)

	await db
		.prepare(
			`INSERT INTO users (
				id, username, email, password_hash, created_at, updated_at,
				email_verified_at, stable_user_id, personal_org_id
			) VALUES (1, 'distinctexp', ?, 'hash', '2026-07-05', '2026-07-05',
				'2026-07-05', ?, ?)`,
		)
		.bind(email, personStable, ownerUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: personStable,
		orgId: ownerUserId,
		username: 'distinctexp',
		createdAt: '2026-07-05T00:00:00.000Z',
	})

	await db
		.prepare(
			`INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (?, 'storage-org-1', 'package', '2026-07-05', '2026-07-05')`,
		)
		.bind(ownerUserId)
		.run()

	const listedGrantUserIds: Array<string> = []
	const env = {
		APP_DB: db,
		MAILBOX: createMailboxBinding(),
		OAUTH_PROVIDER: {
			async listUserGrants(userId: string) {
				listedGrantUserIds.push(userId)
				return {
					items:
						userId === personStable
							? [{ id: 'grant-person-1', clientId: 'client' }]
							: [],
					cursor: undefined,
				}
			},
		},
	} as unknown as Env

	const dbUserId = await resolveAccountExportDbUserId({
		env,
		personUserId,
		email,
	})
	expect(dbUserId).toBe(1)
	await expect(
		resolveAccountExportDbUserId({
			env,
			personUserId: personIdFromStored(ownerUserId as string),
			email,
		}),
	).rejects.toThrow(/identity did not match/)

	const manifest = await createAccountExportManifest({
		env,
		dbUserId,
		ownerUserId,
		personUserId,
	})
	expect(manifest.user.userId).toBe(ownerUserId)
	expect(manifest.sections.oauth_grants?.count).toBe(1)
	expect(manifest.sections.storage_runners?.count).toBe(1)
	expect(listedGrantUserIds).toEqual([personStable])

	const oauthSection = await readAccountExportSection({
		env,
		dbUserId,
		ownerUserId,
		personUserId,
		section: 'oauth_grants',
	})
	expect(oauthSection.items).toEqual([
		{ id: 'grant-person-1', clientId: 'client' },
	])
})
