import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { UpgradeRequiredError } from '#mcp/upgrade-required-error.ts'
import { toApiError } from '#worker/open-api/errors.ts'

const mockModule = vi.hoisted(() => ({
	resolvePackageOwnerContext: vi.fn(),
	dispatchDurableRun: vi.fn(),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
	packageOwnerEntitlementEmail: (input: { ownerEmail: string }) =>
		input.ownerEmail,
}))

vi.mock('#mcp/capabilities/durable-escalation.ts', () => ({
	dispatchDurableRun: (...args: Array<unknown>) =>
		mockModule.dispatchDurableRun(...args),
}))

const {
	minimumPackageCheckCliVersion,
	packageCheckCapability,
	packageCheckUploadCreateCapability,
} = await import('./package-check.ts')

const owner = {
	ownerUserId: ownerIdFromStored('user-1'),
	ownerScope: 'acme',
	ownerEmail: 'user-1@example.com',
	actorUserId: 'user-1',
}
const uploadId = `pcu_${'a'.repeat(32)}`
const handle = {
	status: 'dispatched',
	workflow_id: 'dynwf-check-1',
	workflow_name: 'packageCheck',
	idempotency_key: 'user-1:packageCheck',
	run_status: 'queued',
	message: 'Dispatched.',
}

function callerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.test',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
}

function setup(staged: Record<string, { etag: string }> = {}) {
	mockModule.resolvePackageOwnerContext.mockReset()
	mockModule.dispatchDurableRun.mockReset()
	mockModule.resolvePackageOwnerContext.mockResolvedValue(owner)
	mockModule.dispatchDurableRun.mockResolvedValue({
		kind: 'dispatched',
		handle,
	})
	const head = vi.fn(async (key: string) => staged[key] ?? null)
	const env = { APP_DB: {}, REPO_SESSION_BLOBS: { head } } as unknown as Env
	return { env, head }
}

test('reserving an upload returns a staging key under the caller account', async () => {
	const { env } = setup()
	const reserved = (await packageCheckUploadCreateCapability.handler(
		{},
		{ env, callerContext: callerContext() },
	)) as { upload_id: string; object_key: string; max_bytes: number }
	expect(reserved.upload_id).toMatch(/^pcu_[0-9a-f]{32}$/)
	expect(reserved.object_key).toBe(
		`package-runs/uploads/user-1/${reserved.upload_id}.json`,
	)
	expect(reserved.max_bytes).toBe(24 * 1024 * 1024)
})

test('packageCheck dispatches a durable run keyed on the caller upload and its content hash', async () => {
	const { env } = setup({
		[`package-runs/uploads/user-1/${uploadId}.json`]: { etag: 'etag-1' },
	})
	const result = await packageCheckCapability.handler(
		{ upload_id: uploadId },
		{ env, callerContext: callerContext() },
	)
	expect(result).toEqual(handle)
	expect(mockModule.dispatchDurableRun).toHaveBeenCalledTimes(1)
	expect(mockModule.dispatchDurableRun).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: owner.ownerUserId,
			workflowName: 'packageCheck',
			idempotencyParts: ['packageCheck', 'v1', 'etag-1', uploadId],
			rerunComplete: true,
			durableParams: {
				upload_id: uploadId,
				owner_scope: 'acme',
				owner_email: 'user-1@example.com',
				base_url: 'https://kody.test',
			},
		}),
	)
})

test('packageCheck with an inline tree is refused with upgrade_required and the minimum CLI version', async () => {
	const { env, head } = setup()
	const error = await packageCheckCapability
		.handler(
			{ files: { 'package.json': '{}' } },
			{ env, callerContext: callerContext() },
		)
		.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(UpgradeRequiredError)
	expect(toApiError(error)).toMatchObject({
		status: 426,
		code: 'upgrade_required',
		details: { minimum_cli_version: minimumPackageCheckCliVersion },
	})
	expect((error as Error).message).toContain(minimumPackageCheckCliVersion)
	expect(head).not.toHaveBeenCalled()
	expect(mockModule.dispatchDurableRun).not.toHaveBeenCalled()
})

test('packageCheck refuses an upload it cannot find, including one staged by another account', async () => {
	const { env } = setup({
		[`package-runs/uploads/user-2/${uploadId}.json`]: { etag: 'etag-2' },
	})
	await expect(
		packageCheckCapability.handler(
			{ upload_id: uploadId },
			{ env, callerContext: callerContext() },
		),
	).rejects.toThrow(/No uploaded tree for this upload_id/)
	await expect(
		packageCheckCapability.handler(
			{ upload_id: '../other' },
			{ env, callerContext: callerContext() },
		),
	).rejects.toThrow(/upload_id is not valid/)
	expect(mockModule.dispatchDurableRun).not.toHaveBeenCalled()
})

test('packageCheck surfaces a dispatch failure instead of a handle', async () => {
	const { env } = setup({
		[`package-runs/uploads/user-1/${uploadId}.json`]: { etag: 'etag-1' },
	})
	const failure = new Error('Missing DYNAMIC_CALLABLE_WORKFLOWS binding.')
	mockModule.dispatchDurableRun.mockResolvedValue({
		kind: 'failed',
		error: failure,
	})
	await expect(
		packageCheckCapability.handler(
			{ upload_id: uploadId },
			{ env, callerContext: callerContext() },
		),
	).rejects.toBe(failure)
})
