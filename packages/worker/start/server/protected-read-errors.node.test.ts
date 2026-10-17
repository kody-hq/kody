import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	status: vi.fn(),
	access: vi.fn(),
	read: vi.fn(),
	usage: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		const builder = {
			validator: (_schema: unknown) => builder,
			handler: (run: (input: { data: unknown }) => unknown) => run,
		}
		return builder
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: state.status,
}))
vi.mock('./collection-context.ts', () => ({
	loadPersonalCollection: async () => ({
		bindings: { APP_DB: {} },
		request: new Request('https://kody.test'),
		user: { mcpUser: { userId: 'person' } },
	}),
	loadScopedCollection: async () => ({
		bindings: { APP_DB: {} },
		request: new Request('https://kody.test'),
		user: { mcpUser: { userId: 'person' } },
	}),
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: async () => ({ org: { id: 'team' } }),
}))
vi.mock('#worker/request-context/request-context.ts', () => ({
	deriveRequestContext: () => ({}),
}))
vi.mock('../../src/app/org-management-access.ts', () => ({
	resolveOrgManagementAccess: state.access,
}))
vi.mock('../../src/app/handlers/org-members.ts', () => ({
	loadOrgMembersData: state.read,
}))
vi.mock('../../src/app/handlers/org-settings.ts', () => ({
	loadOrgSettingsData: state.read,
}))
vi.mock('../../src/app/handlers/org-teams.ts', () => ({
	loadOrgTeamsData: state.read,
}))
vi.mock('../../src/app/handlers/org-grants.ts', () => ({
	loadOrgGrantsData: state.read,
}))
vi.mock('../../src/app/handlers/org-collaborators.ts', () => ({
	loadOrgCollaboratorsData: state.read,
}))
vi.mock('../../src/app/handlers/org-billing.ts', () => ({
	resolveOrgBillingAccess: state.access,
	loadOrgBillingPageData: state.read,
}))
vi.mock('../../src/app/handlers/org-usage.ts', () => ({
	loadOrgUsagePageResult: state.usage,
}))
vi.mock('./document-head.ts', () => ({
	loadDocumentHead: () => ({ title: 'Page' }),
}))
import {
	loadOrgMembers,
	loadOrgSettings,
	loadOrgTeams,
	loadOrgGrants,
	loadOrgCollaborators,
} from './org-management.ts'
import { loadBillingPage, loadUsagePage } from './account-collections.ts'

beforeEach(() => {
	vi.resetAllMocks()
	state.access.mockResolvedValue({ ok: true, org: { id: 'team' } })
	state.read.mockResolvedValue({ items: ['visible'] })
	state.usage.mockResolvedValue({
		kind: 'loaded',
		payload: { items: ['visible'] },
	})
})
const reads = [
	['members', () => loadOrgMembers({ data: { slug: 'team' } })],
	['settings', () => loadOrgSettings({ data: { slug: 'team' } })],
	['teams', () => loadOrgTeams({ data: { slug: 'team' } })],
	['grants', () => loadOrgGrants({ data: { slug: 'team' } })],
	['collaborators', () => loadOrgCollaborators({ data: { slug: 'team' } })],
	[
		'billing',
		() =>
			loadBillingPage({
				data: { orgSlug: 'team', billing: null, error: null },
			}),
	],
	[
		'usage',
		() =>
			loadUsagePage({
				data: {
					orgSlug: 'team',
					credits: null,
					error: null,
					topup: null,
					sessionId: null,
				},
			}),
	],
] as const

test.each(reads)(
	'%s rejects permission errors as serializable Error, with HTTP status',
	async (_name, read) => {
		state.access.mockResolvedValue({
			ok: false,
			status: 403,
			error: 'Permission required',
		})
		state.usage.mockResolvedValue({
			kind: 'denied',
			status: 403,
			error: 'Permission required',
		})
		const pending = read()
		await expect(pending).rejects.toBeInstanceOf(Error)
		await expect(pending).rejects.toThrow('Permission required')
		expect(state.status).toHaveBeenCalledWith(403)
		expect(state.read).not.toHaveBeenCalled()
	},
)
test.each(reads)(
	'%s preserves native not-found for inaccessible organizations',
	async (_name, read) => {
		state.access.mockResolvedValue({
			ok: false,
			status: 404,
			error: 'Organization unavailable',
		})
		state.usage.mockResolvedValue({
			kind: 'denied',
			status: 404,
			error: 'Organization unavailable',
		})
		await expect(read()).rejects.toMatchObject({ isNotFound: true })
		expect(state.read).not.toHaveBeenCalled()
	},
)
test.each(reads)(
	'%s keeps authorized payloads unchanged',
	async (name, read) => {
		const value = await read()
		expect(value).toEqual(
			name === 'billing' || name === 'usage'
				? { payload: { items: ['visible'] }, head: { title: 'Page' } }
				: { items: ['visible'] },
		)
		expect(state.status).not.toHaveBeenCalled()
	},
)

test('billing plan disappearing after access resolution becomes native not-found', async () => {
	state.read.mockResolvedValue(null)
	await expect(
		loadBillingPage({ data: { orgSlug: 'team', billing: null, error: null } }),
	).rejects.toMatchObject({ isNotFound: true })
	expect(state.status).not.toHaveBeenCalledWith(500)
})
