import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	type InventoryItemResult,
	summarizeCredentialInventory,
	getCredentialInventoryReport,
	runCredentialBackfill,
	runCredentialInventoryScanStep,
} from './credential-inventory.ts'

type FakeSource = {
	published: boolean
	files: Record<string, string>
	credentials?: Record<
		string,
		{ kind: 'secret' | 'oauth' | 'mcp'; provider: string; description: string }
	>
}

const sources = vi.hoisted(() => new Map<string, FakeSource | 'broken'>())

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: async (input: { sourceId: string }) => {
		const source = sources.get(input.sourceId)
		if (!source || source === 'broken') throw new Error('source unavailable')
		return {
			source: { published_commit: source.published ? 'commit-1' : null },
			manifest: { kody: { credentials: source.credentials } },
			files: source.files,
		}
	},
}))

const slot = (kind: 'secret' | 'oauth', provider: string) => ({
	kind,
	provider,
	description: 'Used by the package.',
})

function seedFleet() {
	sources.clear()
	sources.set('source-pkg-1', {
		published: true,
		files: {
			'index.ts': `
				const stripeKey = '{{secret:STRIPE_KEY}}'
				await fetch('https://api.stripe.com/v1/charges', {
					headers: {
						'X-Api-Key': stripeKey,
						Authorization: 'Bearer {{integration-token:orgGitHub}}',
					},
				})
				await fetch('https://api.weather.com/v1?appid={{secret:WEATHER_KEY}}')
				await fetch('https://x.example.com', {
					headers: { Authorization: 'Bearer {{secret:MIXED_KEY}}' },
				})
				export const note = '{{secret:SHADOWED}}'
			`,
		},
		credentials: {
			RESEND_API_KEY: slot('secret', 'resend'),
			STRIPE_KEY: slot('secret', 'stripe'),
			orgGitHub: slot('oauth', 'github'),
		},
	})
	sources.set('source-pkg-2', {
		published: true,
		files: {
			'index.ts': `await fetch('https://y.example.com/v1?key={{secret:MIXED_KEY}}')`,
		},
		credentials: {
			RESEND_API_KEY: slot('secret', 'resend'),
			WEATHER_KEY: slot('secret', 'Open Weather'),
		},
	})
	sources.set('source-pkg-3', { published: false, files: {} })
	sources.set('source-pkg-4', 'broken')

	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES
			('pkg-1', 'org-a', '@a/one', 'one', '', 'source-pkg-1'),
			('pkg-2', 'org-a', '@a/two', 'two', '', 'source-pkg-2'),
			('pkg-3', 'org-a', '@a/three', 'three', '', 'source-pkg-3'),
			('pkg-4', 'org-a', '@a/four', 'four', '', 'source-pkg-4');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES
			('b-org-a', 'org-a', 'user', ''),
			('b-pkg-1-a', 'org-a', 'package', 'pkg-1'),
			('b-pkg-1-b', 'org-b', 'package', 'pkg-1');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
		VALUES
			('s-stripe', 'b-org-a', 'STRIPE_KEY', 'ct'),
			('s-resend', 'b-org-a', 'RESEND_API_KEY', 'ct'),
			('s-mixed', 'b-org-a', 'MIXED_KEY', 'ct'),
			('s-weather', 'b-org-a', 'WEATHER_KEY', 'ct'),
			('s-shadow-org', 'b-org-a', 'SHADOWED', 'ct'),
			('s-shadow-pkg', 'b-pkg-1-a', 'SHADOWED', 'ct'),
			('s-stripe-b', 'b-pkg-1-b', 'STRIPE_KEY', 'ct');
		UPDATE secret_entries SET inject_json = '{"kind":"query","param":"token"}'
		WHERE id = 's-stripe-b';
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES ('org-a', 'my-github', 'github', 'client', 'https://github.com/token', 'confidential');
		INSERT INTO user_integrations (id, user_id, name, app_slug, access_token_encrypted)
		VALUES ('i-github', 'org-a', 'orgGitHub', 'my-github', 'ct');
	`)
	const env = { APP_DB: createD1FromSqlite(sqlite) } as Env
	return { sqlite, env }
}

async function scanFleet(env: Env) {
	const scan = (runId?: string) =>
		runCredentialInventoryScanStep({
			env,
			baseUrl: 'https://heykody.dev',
			initiatedByUserId: 'admin-1',
			runId,
			limit: 2,
		})
	const first = await scan()
	expect(first).toEqual({
		runId: expect.any(String),
		complete: false,
		page: { scanned: 2, unpublished: 0, failed: 0 },
	})
	await expect(
		runCredentialBackfill({ env, runId: first.runId, dryRun: true }),
	).rejects.toThrow('still scanning')
	expect((await scan(first.runId)).page).toEqual({
		scanned: 0,
		unpublished: 1,
		failed: 1,
	})
	expect(await scan(first.runId)).toEqual({
		runId: first.runId,
		complete: true,
		page: { scanned: 0, unpublished: 0, failed: 0 },
	})
	return first.runId
}

function credentialFields(sqlite: DatabaseSync) {
	const rows = sqlite
		.prepare(
			`SELECT id, provider, inject_json FROM secret_entries
			UNION ALL SELECT id, provider, inject_json FROM user_integrations
			ORDER BY id`,
		)
		.all() as Array<{
		id: string
		provider: string | null
		inject_json: string
	}>
	return Object.fromEntries(
		rows.map((row) => [
			row.id,
			{ provider: row.provider, inject: JSON.parse(row.inject_json) },
		]),
	)
}

const noPlacements = {
	header: 0,
	query: 0,
	'header-custom': 0,
	basic: 0,
	path: 0,
	url: 0,
	body: 0,
	signing: 0,
	binding: 0,
	other: 0,
}

test('the inventory counts every placeholder and attributes it to credential ids without storing names', async () => {
	const { sqlite, env } = seedFleet()
	const runId = await scanFleet(env)

	const { report } = await getCredentialInventoryReport(env.APP_DB, runId)
	expect(report).toEqual({
		packages: {
			scanned: 2,
			unpublished: 1,
			failed: 1,
			withPlaceholders: 2,
			withSlots: 2,
			withRequestPlacement: { body: 0, query: 2, path: 0, url: 0, any: 2 },
		},
		placeholders: {
			secret: 5,
			'secret-basic': 0,
			'integration-token': 1,
			vault: 0,
			computed: 0,
		},
		unparsedModules: 0,
		references: {
			total: 7,
			attributed: 7,
			unattributed: 0,
			byPlacement: { ...noPlacements, header: 3, query: 2, binding: 2 },
			unattributedByPlacement: noPlacements,
			otherByContext: expect.objectContaining({ other: 0 }),
			bodyByEndpoint: { login: 0, other: 0, unknown: 0 },
			bodyFields: [],
			sdkOptions: [],
			argumentCallees: [],
		},
		vault: { byPlacement: noPlacements },
		signing: { placeholderKeys: 0, jwtSignCalls: 0, packagesWithSigning: 0 },
		slots: {
			total: 5,
			attributed: 5,
			byKind: { secret: 4, oauth: 1, mcp: 0 },
		},
		credentialsReferenced: 6,
		failures: [{ packageId: 'pkg-4', error: 'source unavailable' }],
	})

	const stored = sqlite
		.prepare(
			`SELECT package_id, status, result_json FROM credential_inventory_items
			WHERE run_id = ? ORDER BY package_id`,
		)
		.all(runId) as Array<{
		package_id: string
		status: string
		result_json: string
	}>
	expect(stored.map((row) => [row.package_id, row.status])).toEqual([
		['pkg-1', 'scanned'],
		['pkg-2', 'scanned'],
		['pkg-3', 'unpublished'],
		['pkg-4', 'failed'],
	])
	const items = stored.map((row) => row.result_json).join('\n')
	for (const name of ['STRIPE_KEY', 'WEATHER_KEY', 'MIXED_KEY', 'SHADOWED']) {
		expect(items).not.toContain(name)
	}
	const pkg1 = JSON.parse(stored[0]!.result_json)
	expect(
		pkg1.references.map(
			(reference: { credentialIds: Array<string> }) => reference.credentialIds,
		),
	).toEqual([
		// Another org's package row for this package, plus the owner org's row,
		// for the binding and for its read.
		['s-stripe-b', 's-stripe'],
		['s-stripe-b', 's-stripe'],
		['i-github'],
		['s-weather'],
		['s-mixed'],
		// The owner org's package row shadows its org row.
		['s-shadow-pkg'],
	])
})

test('the backfill fills only unset provider and inject columns from consistent usage', async () => {
	const { sqlite, env } = seedFleet()
	const runId = await scanFleet(env)
	const before = credentialFields(sqlite)

	const withFailure = await runCredentialBackfill({
		env,
		runId,
		dryRun: true,
	})
	expect(withFailure.counts.failedPackages).toBe(1)
	await expect(
		runCredentialBackfill({ env, runId, dryRun: false }),
	).rejects.toThrow('failed to scan 1 package(s)')
	expect(credentialFields(sqlite)).toEqual(before)

	sources.set('source-pkg-4', { published: false, files: {} })
	const cleanRunId = (
		await runCredentialInventoryScanStep({
			env,
			baseUrl: 'https://heykody.dev',
			initiatedByUserId: 'admin-1',
			limit: 10,
		})
	).runId
	const dryRun = await runCredentialBackfill({
		env,
		runId: cleanRunId,
		dryRun: true,
	})
	expect(dryRun).toEqual({
		runId: cleanRunId,
		dryRun: true,
		counts: {
			failedPackages: 0,
			credentials: 7,
			missingRows: 0,
			provider: {
				write: 4,
				alreadySet: 0,
				none: 2,
				conflicting: 0,
				invalid: 1,
			},
			inject: {
				write: 2,
				header: 1,
				query: 1,
				alreadySet: 1,
				default: 1,
				mixed: 1,
				unsupported: 0,
				unused: 2,
			},
		},
		writtenRows: 0,
	})
	expect(credentialFields(sqlite)).toEqual(before)

	const applied = await runCredentialBackfill({
		env,
		runId: cleanRunId,
		dryRun: false,
	})
	expect(applied.counts).toEqual(dryRun.counts)
	expect(applied.writtenRows).toBe(6)
	const bearer = {
		kind: 'header',
		name: 'Authorization',
		format: 'Bearer {value}',
	}
	expect(credentialFields(sqlite)).toEqual({
		'i-github': { provider: 'github', inject: bearer },
		's-mixed': { provider: null, inject: bearer },
		's-resend': { provider: 'resend', inject: bearer },
		's-shadow-org': { provider: null, inject: bearer },
		's-shadow-pkg': { provider: null, inject: bearer },
		's-stripe': {
			provider: 'stripe',
			inject: { kind: 'header', name: 'x-api-key', format: '{value}' },
		},
		's-stripe-b': {
			provider: 'stripe',
			inject: { kind: 'query', param: 'token' },
		},
		's-weather': { provider: null, inject: { kind: 'query', param: 'appid' } },
	})

	const again = await runCredentialBackfill({
		env,
		runId: cleanRunId,
		dryRun: false,
	})
	expect(again.writtenRows).toBe(0)
	expect(again.counts.provider).toMatchObject({ write: 0, alreadySet: 4 })
	expect(again.counts.inject).toMatchObject({ write: 0, alreadySet: 3 })
})

test('an apply with failed packages proceeds only when it acknowledges exactly those packages', async () => {
	const { sqlite, env } = seedFleet()
	const runId = await scanFleet(env)
	const before = credentialFields(sqlite)
	const failed = (
		sqlite
			.prepare(
				`SELECT package_id FROM credential_inventory_items WHERE run_id = ? AND status = 'failed'`,
			)
			.all(runId) as Array<{ package_id: string }>
	).map((row) => row.package_id)
	expect(failed).toHaveLength(1)

	for (const acknowledgedFailedPackageIds of [
		[],
		['some-other-package'],
		[...failed, 'some-other-package'],
	]) {
		await expect(
			runCredentialBackfill({
				env,
				runId,
				dryRun: false,
				acknowledgedFailedPackageIds,
			}),
		).rejects.toThrow('acknowledgedFailedPackageIds')
	}
	expect(credentialFields(sqlite)).toEqual(before)

	const applied = await runCredentialBackfill({
		env,
		runId,
		dryRun: false,
		acknowledgedFailedPackageIds: failed,
	})
	expect(applied.counts.failedPackages).toBe(1)
	expect(applied.writtenRows).toBeGreaterThan(0)
	expect(credentialFields(sqlite)).not.toEqual(before)
})

test('the report breaks down body, other, vault, and signing placements, and reads items from the earlier scan format', () => {
	const reference = (
		placement: InventoryItemResult['references'][number]['placement'],
		credentialIds: Array<string> = ['secret-1'],
	) => ({ table: 'secret' as const, credentialIds, scope: null, placement })
	const result = (
		references: InventoryItemResult['references'],
		extra: Partial<InventoryItemResult> = {},
	): InventoryItemResult => ({
		placeholders: {
			secret: references.length,
			'secret-basic': 0,
			'integration-token': 0,
			vault: 0,
			computed: 0,
		},
		unparsedModules: 0,
		references,
		slots: [],
		...extra,
	})
	const report = summarizeCredentialInventory([
		{
			packageId: 'pkg-new',
			status: 'scanned',
			result: result(
				[
					reference({ type: 'body', field: 'password', endpoint: 'login' }),
					reference({ type: 'body', field: 'password', endpoint: 'login' }, []),
					reference({
						type: 'other',
						context: 'sdk-option',
						key: 'apiKey',
						callee: 'OpenAI',
					}),
					reference({
						type: 'other',
						context: 'argument',
						key: null,
						callee: 'connect',
					}),
					reference({ type: 'signing' }),
				],
				{ vaultPlacements: [{ type: 'path' }], jwtSignCalls: 2 },
			),
		},
		{
			packageId: 'pkg-old',
			status: 'scanned',
			// Stored before body and other detail existed.
			result: result([
				reference({ type: 'body' } as never),
				reference({ type: 'other' } as never),
			]),
		},
	])
	expect(report.references.byPlacement).toMatchObject({
		body: 3,
		other: 3,
		signing: 1,
	})
	expect(report.references.unattributedByPlacement.body).toBe(1)
	expect(report.references.bodyByEndpoint).toEqual({
		login: 2,
		other: 0,
		unknown: 1,
	})
	expect(report.references.bodyFields).toEqual([{ name: 'password', count: 2 }])
	expect(report.references.otherByContext).toMatchObject({
		'sdk-option': 1,
		argument: 1,
		other: 1,
	})
	expect(report.references.sdkOptions).toEqual([
		{ name: 'OpenAI.apiKey', count: 1 },
	])
	expect(report.references.argumentCallees).toEqual([
		{ name: 'connect', count: 1 },
	])
	expect(report.vault.byPlacement.path).toBe(1)
	expect(report.signing).toEqual({
		placeholderKeys: 1,
		jwtSignCalls: 2,
		packagesWithSigning: 1,
	})
})
