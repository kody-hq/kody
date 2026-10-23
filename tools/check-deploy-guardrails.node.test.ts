import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import {
	checkDurableObjectConfig,
	checkPreviewCleanupSource,
	checkWorkflowSource,
	defaultPreviewResourcesScriptPath,
	type DurableObjectBaseline,
	type DurableObjectDeletionAllowlist,
} from './check-deploy-guardrails.ts'

const configPath = 'packages/worker/wrangler.jsonc'
const baseline = {
	path: configPath,
	protected_migrations: [{ tag: 'v1', new_sqlite_classes: ['Mailbox'] }],
	protected_binding_sets: [
		{
			location: 'env.production.durable_objects',
			bindings: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
		},
	],
} satisfies DurableObjectBaseline['configs'][number]

function createConfig(
	deletedClasses: Array<string> | undefined,
	deletionTag = 'v2',
) {
	return {
		migrations: [
			{ tag: 'v1', new_sqlite_classes: ['Mailbox'] },
			...(deletedClasses
				? [{ tag: deletionTag, deleted_classes: deletedClasses }]
				: []),
		],
		env: {
			production: {
				durable_objects: {
					bindings: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
				},
			},
		},
	}
}

const emptyAllowlist = {
	version: 1,
	deletions: [],
} satisfies DurableObjectDeletionAllowlist

test('Durable Object guard rejects unreviewed deletion and accepts its exact allowlist entry', () => {
	expect(
		checkDurableObjectConfig(
			configPath,
			createConfig(['Mailbox']),
			baseline,
			emptyAllowlist,
		),
	).toEqual([
		expect.stringContaining(
			'destructive deletion v2 [Mailbox] is not an exact entry',
		),
	])

	const reviewedAllowlist = {
		version: 1,
		deletions: [{ config: configPath, tag: 'v2', classes: ['Mailbox'] }],
	} satisfies DurableObjectDeletionAllowlist
	expect(
		checkDurableObjectConfig(
			configPath,
			createConfig(['Mailbox']),
			baseline,
			reviewedAllowlist,
		),
	).toEqual([])
	expect(
		checkDurableObjectConfig(
			configPath,
			createConfig(['Mailbox', 'RunLog']),
			baseline,
			reviewedAllowlist,
		),
	).toEqual([expect.stringContaining('is not an exact entry')])
})

test('Durable Object guard protects migration tags and bound classes', () => {
	type Config = ReturnType<typeof createConfig>
	const cases: Array<[(config: Config) => void, Array<string>]> = [
		[
			(config) => {
				config.migrations[0] = {
					tag: 'renamed-v1',
					new_sqlite_classes: ['Mailbox'],
				}
			},
			[
				'was removed, renamed, or changed',
				'new_sqlite_classes migration "renamed-v1" at migrations is not recorded',
			],
		],
		[
			(config) => {
				config.env.production.durable_objects.bindings = []
			},
			['protected Durable Object class "Mailbox" was removed'],
		],
		[
			(config) => {
				config.env.production.durable_objects.bindings[0] = {
					name: 'RENAMED_MAILBOX',
					class_name: 'Mailbox',
				}
			},
			['binding identities'],
		],
		[
			(config) => {
				Object.assign(config.env.production.durable_objects.bindings[0] ?? {}, {
					script_name: 'external-worker',
					environment: 'production',
				})
			},
			['binding identities'],
		],
	]
	for (const [mutate, expected] of cases) {
		const config = createConfig(undefined)
		mutate(config)
		expect(
			checkDurableObjectConfig(configPath, config, baseline, emptyAllowlist),
		).toEqual(expected.map((message) => expect.stringContaining(message)))
	}
})

test('Durable Object guard protects transferred_classes migrations', () => {
	const transfer = { from: 'RunLog', from_script: 'kody', to: 'RunLog' }
	const transferBaseline = {
		path: configPath,
		protected_migrations: [],
		protected_transfer_migrations: [
			{ tag: 'v1', transferred_classes: [transfer] },
		],
		protected_binding_sets: [],
	} satisfies DurableObjectBaseline['configs'][number]
	const check = (migrations: Array<unknown>) =>
		checkDurableObjectConfig(
			configPath,
			{ migrations },
			transferBaseline,
			emptyAllowlist,
		)

	expect(check([{ tag: 'v1', transferred_classes: [transfer] }])).toEqual([])
	expect(
		check([
			{
				tag: 'v1',
				transferred_classes: [{ ...transfer, from_script: 'other-worker' }],
			},
		]),
	).toEqual([
		expect.stringContaining(
			'protected transferred_classes migration "v1" at migrations was removed, renamed, or changed',
		),
	])
	expect(
		check([
			{ tag: 'v1', transferred_classes: [transfer] },
			{ tag: 'v2', transferred_classes: [transfer] },
		]),
	).toEqual([
		expect.stringContaining(
			'transferred_classes migration "v2" at migrations is not recorded',
		),
	])
})

test('Durable Object guard covers environment-specific migration lists', () => {
	const transfer = { from: 'RunLog', from_script: 'kody', to: 'RunLog' }
	const envBaseline = {
		path: configPath,
		protected_migrations: [
			{
				tag: 'v1',
				location: 'env.preview.migrations',
				new_sqlite_classes: ['RunLog'],
			},
		],
		protected_transfer_migrations: [
			{ tag: 'v1', transferred_classes: [transfer] },
		],
		protected_binding_sets: [],
	} satisfies DurableObjectBaseline['configs'][number]
	// The same tag may exist at the top level and in an env override.
	const check = (previewMigrations: Array<unknown>) =>
		checkDurableObjectConfig(
			configPath,
			{
				migrations: [{ tag: 'v1', transferred_classes: [transfer] }],
				env: { preview: { migrations: previewMigrations } },
			},
			envBaseline,
			emptyAllowlist,
		)
	const runLogV1 = { tag: 'v1', new_sqlite_classes: ['RunLog'] }

	expect(check([runLogV1])).toEqual([])
	expect(check([{ tag: 'v1', new_sqlite_classes: ['SomethingElse'] }])).toEqual(
		[
			expect.stringContaining(
				'protected new_sqlite_classes migration "v1" at env.preview.migrations was removed, renamed, or changed',
			),
		],
	)
	expect(
		check([runLogV1, { tag: 'v2', new_sqlite_classes: ['Unrecorded'] }]),
	).toEqual([
		expect.stringContaining(
			'new_sqlite_classes migration "v2" at env.preview.migrations is not recorded',
		),
	])
	expect(check([runLogV1, runLogV1])).toContainEqual(
		expect.stringContaining(
			'duplicate Durable Object migration tag "v1" in env.preview.migrations',
		),
	)
	expect(
		check([runLogV1, { tag: 'v2', deleted_classes: ['RunLog'] }]),
	).toContainEqual(
		expect.stringContaining(
			'destructive deletion v2 [RunLog] is not an exact entry',
		),
	)
})

test('workflow guard permits destructive commands only in operator-dispatched jobs', () => {
	const automaticWorkflow = `on:
  push:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler d1 delete production
`
	expect(checkWorkflowSource('automatic.yml', automaticWorkflow)).toEqual([
		expect.stringContaining(
			'invokes a destructive Cloudflare CLI operation outside a job',
		),
	])

	const manualWorkflow = `on:
  workflow_dispatch:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: npx wrangler r2 bucket delete old-backups
`
	expect(checkWorkflowSource('manual.yml', manualWorkflow)).toEqual([])

	const explicitlyGuardedMixedWorkflow = `on:
  push:
  workflow_dispatch:
jobs:
  cleanup:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: node ./wrangler-env.ts kv namespace delete old-cache
`
	expect(
		checkWorkflowSource('mixed.yml', explicitlyGuardedMixedWorkflow),
	).toEqual([])

	const bypassableMixedWorkflow = explicitlyGuardedMixedWorkflow.replace(
		"github.event_name == 'workflow_dispatch'",
		"github.event_name == 'workflow_dispatch' || github.event_name == 'push'",
	)
	expect(
		checkWorkflowSource('bypassable.yml', bypassableMixedWorkflow),
	).toEqual([expect.stringContaining('outside a job explicitly restricted')])
})

const guardedCleanupScript = `import {
	deleteWorkerScript,
	removeCloudflareQueueConsumers,
	runWrangler,
} from './resource-utils.ts'

export function assertPreviewResourceName(name: string, kind: string) {
	if (!/^kody-pr-\\d+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error(\`Refusing to delete \${kind} "\${name}"\`)
	}
}

function deletePreviewWorkerScript(name: string) {
	assertPreviewResourceName(name, 'worker')
	deleteWorkerScript({ name, dryRun: false })
}

async function removePreviewQueueConsumers(name: string) {
	// Comments mentioning 'delete' or --force are not call sites.
	assertPreviewResourceName(name, 'queue')
	await removeCloudflareQueueConsumers({ name })
}

function deletePreviewD1Database(name: string) {
	assertPreviewResourceName(name, 'd1')
	const exists = runWrangler(['d1', 'list', '--json'])
	if (!exists) return
	runWrangler(['d1', 'delete', name, '--skip-confirmation'])
}

async function deletePreviewQueue(queueId: string, name: string) {
	assertPreviewResourceName(name, 'queue')
	await cloudflareApiRequest({
		pathname: \`/queues/\${queueId}\`,
		method: 'DELETE',
	})
}
`

test('preview cleanup guard accepts guarded deletes and flags each delete call site not preceded by the guard', () => {
	expect(
		checkPreviewCleanupSource('preview-resources.ts', guardedCleanupScript),
	).toEqual([])

	const unguardedWorkerDelete = guardedCleanupScript.replace(
		"\tassertPreviewResourceName(name, 'worker')\n",
		'',
	)
	expect(
		checkPreviewCleanupSource('preview-resources.ts', unguardedWorkerDelete),
	).toEqual([
		expect.stringMatching(
			/preview-resources\.ts:14 performs a destructive Cloudflare operation without a preceding assertPreviewResourceName\(name, kind\) call in the same function: deleteWorkerScript\(/,
		),
	])

	const unguardedWranglerDelete = guardedCleanupScript.replace(
		"\tassertPreviewResourceName(name, 'd1')\n",
		'',
	)
	expect(
		checkPreviewCleanupSource('preview-resources.ts', unguardedWranglerDelete),
	).toEqual([
		expect.stringContaining(
			"runWrangler(['d1', 'delete', name, '--skip-confirmation'])",
		),
	])

	const unguardedRestDelete = guardedCleanupScript.replace(
		"\tassertPreviewResourceName(name, 'queue')\n\tawait cloudflareApiRequest",
		'\tawait cloudflareApiRequest',
	)
	expect(
		checkPreviewCleanupSource('preview-resources.ts', unguardedRestDelete),
	).toEqual([expect.stringContaining("method: 'DELETE'")])

	// A guard in a different function does not cover this one.
	const guardMovedToCaller = guardedCleanupScript.replace(
		"async function removePreviewQueueConsumers(name: string) {\n\t// Comments mentioning 'delete' or --force are not call sites.\n\tassertPreviewResourceName(name, 'queue')\n",
		"function checkFirst(name: string) {\n\tassertPreviewResourceName(name, 'queue')\n}\n\nasync function removePreviewQueueConsumers(name: string) {\n\tcheckFirst(name)\n",
	)
	expect(
		checkPreviewCleanupSource('preview-resources.ts', guardMovedToCaller),
	).toEqual([expect.stringContaining('removeCloudflareQueueConsumers(')])

	// A newly imported destructive helper is covered without editing the check.
	const newDestructiveImport = guardedCleanupScript
		.replace(
			'\tdeleteWorkerScript,\n',
			'\tdeleteWorkerScript,\n\tpurgeCache as purgeEverything,\n',
		)
		.replace(
			'function deletePreviewWorkerScript(name: string) {\n',
			'function purgeAll(name: string) {\n\tpurgeEverything({ name })\n}\n\nfunction deletePreviewWorkerScript(name: string) {\n',
		)
	expect(
		checkPreviewCleanupSource('preview-resources.ts', newDestructiveImport),
	).toEqual([expect.stringContaining('purgeEverything({ name })')])

	// Deleting at module top level has no enclosing function to guard it.
	const topLevelDelete = `${guardedCleanupScript}\ndeleteWorkerScript({ name: 'kody', dryRun: false })\n`
	expect(
		checkPreviewCleanupSource('preview-resources.ts', topLevelDelete),
	).toEqual([expect.stringContaining('outside any function')])
})

test('preview cleanup guard fails closed when the guard or the deletes disappear', () => {
	expect(
		checkPreviewCleanupSource(
			'preview-resources.ts',
			"import { deleteWorkerScript } from './resource-utils.ts'\n\nfunction cleanup() {\n\tdeleteWorkerScript({ name: 'kody-pr-1', dryRun: false })\n}\n",
		),
	).toEqual([
		expect.stringContaining('does not define assertPreviewResourceName()'),
	])

	const noDeletes = `export function assertPreviewResourceName(name: string) {
	if (!name) throw new Error('bad')
}

function cleanup(name: string) {
	assertPreviewResourceName(name)
}
`
	expect(checkPreviewCleanupSource('preview-resources.ts', noDeletes)).toEqual([
		expect.stringContaining('found no destructive Cloudflare operations'),
	])

	const definedButNeverCalled = `import { deleteWorkerScript } from './resource-utils.ts'

export function assertPreviewResourceName(name: string) {
	if (!name) throw new Error('bad')
}

function cleanup() {
	deleteWorkerScript({ name: 'kody-pr-1', dryRun: false })
}
`
	expect(
		checkPreviewCleanupSource('preview-resources.ts', definedButNeverCalled),
	).toEqual([
		expect.stringContaining('without a preceding assertPreviewResourceName'),
		expect.stringContaining('never calls assertPreviewResourceName()'),
	])
})

test('the committed preview cleanup script routes every delete through the name guard', async () => {
	const source = await readFile(defaultPreviewResourcesScriptPath, 'utf8')
	expect(
		checkPreviewCleanupSource(defaultPreviewResourcesScriptPath, source),
	).toEqual([])
	// Removing any single guard call must be caught, so no delete depends on
	// a guard placed elsewhere.
	const guardCalls = [
		...source.matchAll(/^\tassertPreviewResourceName\(.*\)\n/gm),
	]
	expect(guardCalls.length).toBeGreaterThanOrEqual(6)
	for (const guardCall of guardCalls) {
		const withoutGuard =
			source.slice(0, guardCall.index) +
			source.slice(guardCall.index + guardCall[0].length)
		expect(
			checkPreviewCleanupSource(
				defaultPreviewResourcesScriptPath,
				withoutGuard,
			),
			`removing ${guardCall[0].trim()} went unnoticed`,
		).not.toEqual([])
	}
})
