import { beforeEach, expect, test, vi } from 'vitest'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
const mocks = vi.hoisted(() => ({ record: vi.fn(), rpc: vi.fn() }))
vi.mock('#worker/run-records/service.ts', () => ({ runLogRpc: mocks.rpc }))
import {
	recordSkillFileRead,
	issueSkillReadReceipt,
	verifySkillReadReceipt,
} from './skill-read-events.ts'
const user = {
	userId: personIdFromStored('person-1'),
	username: 'jane',
	email: 'jane@example.com',
	displayName: 'Jane',
}
const callerContext: McpCallerContext = {
	baseUrl: 'https://kody.test',
	executionOrigin: undefined,
	storageContext: undefined,
	repoContext: undefined,
	user,
	request: deriveRequestContext({
		user,
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored('team-1'), slug: 'team' },
			role: 'member',
		},
	}),
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.rpc.mockReturnValue({ recordSkillRead: mocks.record })
})
test('logs authenticated organization, actor and content digest without the instructions', async () => {
	const input = {
		env: {} as Env,
		callerContext,
		channel: 'search' as const,
		packageId: 'pkg',
		packageName: '@team/docs',
		packageOwnerId: 'team-1',
		publishedCommit: 'commit',
		path: 'skills/writing/SKILL.md',
		content: 'private instructions',
		hasManifest: true,
	}
	await recordSkillFileRead(input)
	expect(mocks.rpc).toHaveBeenCalledWith({ env: {}, userId: 'team-1' })
	expect(mocks.record).toHaveBeenCalledWith(
		expect.objectContaining({
			actorId: 'person-1',
			actorUsername: 'jane',
			orgId: 'team-1',
			kind: 'instructions',
			channel: 'search',
			skillUri: 'skill://team/docs/writing/SKILL.md',
		}),
	)
	expect(JSON.stringify(mocks.record.mock.calls)).not.toContain(
		'private instructions',
	)
	await recordSkillFileRead({
		...input,
		path: 'skills/writing/references/a.md',
	})
	expect(mocks.record).toHaveBeenLastCalledWith(
		expect.objectContaining({ kind: 'supporting-file' }),
	)
})
test('does not log unrelated files, missing manifests or anonymous reads', async () => {
	const input = {
		env: {} as Env,
		callerContext,
		channel: 'search' as const,
		packageId: 'pkg',
		packageName: '@team/docs',
		packageOwnerId: 'team-1',
		publishedCommit: null,
		path: 'README.md',
		content: 'text',
		hasManifest: true,
	}
	await recordSkillFileRead(input)
	await recordSkillFileRead({
		...input,
		path: 'skills/a/SKILL.md',
		hasManifest: false,
	})
	await recordSkillFileRead({
		...input,
		path: 'skills/a/SKILL.md',
		callerContext: { ...callerContext, request: null },
	})
	expect(mocks.record).not.toHaveBeenCalled()
})
test('view receipts bind the snapshot and reader and reject tampering', async () => {
	const resource = {
		packageId: 'pkg',
		packageName: '@team/docs',
		packageOwnerId: 'team-1',
		publishedCommit: 'old-version',
		skillName: 'writing',
		skillUri: 'skill://team/docs/writing/SKILL.md',
		filePath: 'skills/writing/SKILL.md',
		digest: 'sha256:a',
		kind: 'instructions' as const,
	}
	const token = await issueSkillReadReceipt('secret', {
		resource,
		actorId: 'person-1',
		orgId: 'team-1',
		channel: 'skills-page',
	})
	expect(await verifySkillReadReceipt('secret', token)).toMatchObject({
		resource,
		actorId: 'person-1',
		orgId: 'team-1',
	})
	await expect(
		verifySkillReadReceipt('different-secret', token),
	).rejects.toThrow('Invalid')
	vi.useFakeTimers()
	vi.setSystemTime(Date.now() + 25 * 3600000)
	await expect(verifySkillReadReceipt('secret', token)).rejects.toThrow(
		'expired',
	)
	vi.useRealTimers()
})
