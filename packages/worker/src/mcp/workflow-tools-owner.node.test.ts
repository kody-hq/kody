import {
	ownerIdFromStored,
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { listWorkflowRunsForUser } from '#worker/package-runtime/package-workflows.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createFakeRunLogNamespace } from '#worker/test-support/run-kody-registry.ts'
import { createWorkflowTools } from './run-kody-registry.ts'

// workflows.create must use the same owner as workflowRunList, runList, and
// package lookup (ownerIdFromCaller).

function createOwnerScopedWorkflowEnv(
	savedPackageRows: Array<Record<string, unknown>>,
) {
	const created: Array<WorkflowInstanceCreateOptions<unknown>> = []
	const workflowEnv = {
		// Only return a saved package when the query is bound to its owner, like
		// the real `WHERE ... user_id = ?` lookup.
		APP_DB: {
			prepare(query: string) {
				return {
					bind(...args: Array<unknown>) {
						return {
							async first() {
								if (query.includes('COUNT(*) AS count')) return { count: 0 }
								if (query.includes('FROM saved_packages')) {
									return (
										savedPackageRows.find(
											(row) =>
												args.includes(row.user_id) &&
												(args.includes(row.id) || args.includes(row.kody_id)),
										) ?? null
									)
								}
								return null
							},
							async all() {
								throw new Error(`Unsupported all query: ${query}`)
							},
							async run() {
								throw new Error(`Unsupported run query: ${query}`)
							},
						}
					},
				}
			},
		} as unknown as D1Database,
		RUN_LOG: createFakeRunLogNamespace().namespace,
		DYNAMIC_CALLABLE_WORKFLOWS: {
			get: async () => {
				throw new Error('not found')
			},
			create: async (options?: WorkflowInstanceCreateOptions<unknown>) => {
				if (!options) throw new Error('missing options')
				created.push(options)
				return {
					id: options.id ?? 'generated',
					status: async () => ({ status: 'queued' }),
				} as WorkflowInstance
			},
			createBatch: async () => {
				throw new Error('createBatch is not supported in this test')
			},
			deleteBatch: async () => {
				throw new Error('deleteBatch is not supported in this test')
			},
		} as Workflow<unknown>,
	} as Env
	return { workflowEnv, created }
}

function savedPackageRow(input: {
	id: string
	ownerId: string
	kodyId: string
}) {
	return {
		id: input.id,
		user_id: ownerIdFromStored(input.ownerId),
		name: input.kodyId,
		kody_id: input.kodyId,
		description: 'Workflow package',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${input.id}`,
		has_app: 0,
		created_at: '2026-10-22T00:00:00.000Z',
		updated_at: '2026-10-22T00:00:00.000Z',
	}
}

test('workflows.create keys runs and package lookup to the stamped personal org when it differs from the person id', async () => {
	silenceIncidentalRuntimeWarnings()
	const { workflowEnv, created } = createOwnerScopedWorkflowEnv([
		savedPackageRow({
			id: 'pkg-signup',
			ownerId: 'org-signup-1',
			kodyId: 'factory',
		}),
	])
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://app.example.com',
		user: {
			userId: personIdFromStored('person-1'),
			personalOrgId: ownerIdFromStored('org-signup-1'),
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: null,
		repoContext: null,
	})
	expect(ownerIdFromCaller(callerContext)).toBe('org-signup-1')
	const workflowTools = createWorkflowTools({
		env: workflowEnv,
		callerContext,
		packageContext: null as never,
	})

	const fromPackage = (await workflowTools.create({
		workflowName: 'factory-descriptor',
		packageId: 'pkg-signup',
		exportName: '.',
		idempotencyKey: 'descriptor-key',
	})) as { id: string }
	expect(fromPackage).toMatchObject({ ok: true, package_id: 'pkg-signup' })
	expect(created[0]?.params).toEqual(
		expect.objectContaining({
			userId: 'org-signup-1',
			packageId: 'pkg-signup',
		}),
	)

	// Diagnostics read with the same owner the caller resolves to.
	const listed = await listWorkflowRunsForUser({
		env: workflowEnv,
		userId: ownerIdFromCaller(callerContext),
	})
	expect(listed.map((row) => row.id)).toEqual([fromPackage.id])
	const underDerivedId = await listWorkflowRunsForUser({
		env: workflowEnv,
		userId: personalOrgId(personIdFromStored('person-1')),
	})
	expect(underDerivedId).toEqual([])

	// Replay with the same key returns the same workflow under the same owner.
	const replay = (await workflowTools.create({
		workflowName: 'factory-descriptor',
		packageId: 'pkg-signup',
		exportName: '.',
		idempotencyKey: 'descriptor-key',
	})) as { id: string }
	expect(replay.id).toBe(fromPackage.id)
	expect(created).toHaveLength(1)
})

test('workflows.create in a team org keys to that org and stays invisible to other orgs', async () => {
	silenceIncidentalRuntimeWarnings()
	const { workflowEnv, created } = createOwnerScopedWorkflowEnv([
		savedPackageRow({
			id: 'pkg-team',
			ownerId: 'org-team-1',
			kodyId: 'team-flow',
		}),
	])
	const teamCaller = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://app.example.com',
		user: {
			userId: personIdFromStored('person-1'),
			personalOrgId: ownerIdFromStored('org-signup-1'),
			email: 'me@example.com',
			displayName: 'Me',
		},
		orgBinding: { org: { id: 'org-team-1', slug: 'team' }, role: 'member' },
		storageContext: null,
		repoContext: null,
	})
	const teamTools = createWorkflowTools({
		env: workflowEnv,
		callerContext: teamCaller,
		packageContext: null as never,
	})
	const teamRun = (await teamTools.create({
		workflowName: 'team-flow',
		packageId: 'pkg-team',
		exportName: '.',
		idempotencyKey: 'shared-key',
	})) as { id: string }
	expect(created[0]?.params).toEqual(
		expect.objectContaining({ userId: 'org-team-1', packageId: 'pkg-team' }),
	)

	// The same person in their personal org cannot use the team package and
	// does not see or replay the team run.
	const personalCaller = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://app.example.com',
		user: {
			userId: personIdFromStored('person-1'),
			personalOrgId: ownerIdFromStored('org-signup-1'),
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: null,
		repoContext: null,
	})
	const personalTools = createWorkflowTools({
		env: workflowEnv,
		callerContext: personalCaller,
		packageContext: null as never,
	})
	await expect(
		personalTools.create({
			workflowName: 'team-flow',
			packageId: 'pkg-team',
			exportName: '.',
			idempotencyKey: 'other-key',
		}),
	).rejects.toThrow('was not found or is not owned by the current user')
	const personalRun = (await personalTools.create({
		workflowName: 'inline-probe',
		code: 'export default async function main() { return { ok: true } }',
		idempotencyKey: 'shared-key',
	})) as { id: string }
	expect(personalRun.id).not.toBe(teamRun.id)
	expect(
		(
			await listWorkflowRunsForUser({
				env: workflowEnv,
				userId: ownerIdFromCaller(personalCaller),
			})
		).map((row) => row.id),
	).toEqual([personalRun.id])
	expect(
		(
			await listWorkflowRunsForUser({
				env: workflowEnv,
				userId: ownerIdFromCaller(teamCaller),
			})
		).map((row) => row.id),
	).toEqual([teamRun.id])
})
