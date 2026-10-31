import { expect, test, type Mock } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type RepoSession } from '../repo/repo-session-do.ts'
import {
	repoSessionMockModule as mockModule,
	setCommonSessionFixtures,
} from '#worker/test-support/repo-session-do.ts'

export function registerSkillRestoreTests({
	repoSession,
	seedWorkspace,
	skillSnapshot,
}: {
	repoSession: () => InstanceType<typeof RepoSession>
	seedWorkspace: (files: Record<string, string>) => void
	skillSnapshot: Mock
}) {
	const session = {
		sessionId: 'session-1',
		userId: ownerIdFromStored('user-1'),
	}
	test('skill restore keeps binary bytes, deletes later files, and leaves other skills alone', async () => {
		setCommonSessionFixtures()
		seedWorkspace({
			'skills/writing/SKILL.md': 'new',
			'skills/writing/later.md': 'later',
			'skills/other/SKILL.md': 'keep',
		})
		mockModule.workspaceReadFileBytes.mockImplementation(async (path: string) =>
			new TextEncoder().encode(path.endsWith('SKILL.md') ? 'new' : 'later'),
		)
		skillSnapshot.mockResolvedValue({
			files: {
				'skills/writing/SKILL.md': 'old',
				'skills/writing/icon.png': '\u0089PNG\u0000\u00ff',
				'skills/other/SKILL.md': 'old other',
			},
		})
		await repoSession().restorePublishedSkill({
			...session,
			name: 'writing',
			commit: 'old',
		})
		expect(mockModule.workspaceWriteFileBytes).toHaveBeenCalledWith(
			'/session/skills/writing/icon.png',
			new Uint8Array([137, 80, 78, 71, 0, 255]),
		)
		expect(mockModule.workspaceRm).toHaveBeenCalledWith(
			'/session/skills/writing/later.md',
			{ force: true },
		)
		expect(
			mockModule.workspaceWriteFileBytes.mock.calls.map(([path]) => path),
		).not.toContain('/session/skills/other/SKILL.md')
		expect(skillSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ sourceId: 'source-1', publishedCommit: 'old' }),
		)
	})
}
