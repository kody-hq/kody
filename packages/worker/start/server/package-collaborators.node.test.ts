import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	page: {} as Record<string, unknown>,
	read: vi.fn(),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
	mutation: vi.fn(),
	authenticated: true,
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validator: { parse: (data: unknown) => unknown }
		const builder = {
			validator(value: typeof validator) {
				validator = value
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: validator.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('@tanstack/react-router', () => ({
	redirect: (options: unknown) => ({ redirect: options }),
	notFound: () => ({ notFound: true }),
}))
vi.mock('./mutation-context.ts', () => {
	class WebsiteAuthenticationError extends Error {
		constructor() {
			super('Please sign in again.')
		}
	}
	return {
		WebsiteAuthenticationError,
		withWebsiteMutation: async (
			options: unknown,
			run: (context: unknown) => Promise<unknown>,
		) => {
			state.mutation(options)
			if (!state.authenticated) throw new WebsiteAuthenticationError()
			return run({
				request: new Request('https://kody.test/_serverFn/write', {
					method: 'POST',
				}),
				env: {},
				user: { userId: 'viewer' },
			})
		},
		withWebsiteRead: async (
			_: unknown,
			run: (context: unknown) => Promise<unknown>,
		) => {
			if (!state.authenticated) throw new WebsiteAuthenticationError()
			return run({
				request: new Request('https://kody.test/_serverFn/test'),
				env: {},
				user: { userId: 'viewer' },
			})
		},
	}
})
vi.mock('../../src/app/package-page.ts', () => ({
	loadPackagePage: async () => state.page,
	packagePageIsPrivate: () => true,
}))
vi.mock('../../src/app/handlers/package-collaborators.ts', () => ({
	readPackageCollaborators: state.read,
	createPackageCollaboratorInvite: state.createInvite,
	revokePackageCollaboratorInvite: state.revokeInvite,
}))
vi.mock('./document-head.ts', () => ({ loadDocumentHead: () => ({}) }))
import {
	loadPackageCollaborators,
	createPackageCollaboratorInvite,
	revokePackageCollaboratorInvite,
} from './package-collaborators.ts'
const detail = {
	kind: 'page',
	username: 'acme',
	kodyId: 'release-notes',
	isPrivate: true,
	listing: null,
	ownerProfilePublic: true,
	viewerIsOwner: true,
	viewerCanManage: true,
	viewerCanManageAccess: true,
	ownerPackage: {
		id: 'pkg-1',
		kodyId: 'release-notes',
		name: 'release-notes',
		description: 'Drafts release notes',
		isPrivate: true,
		hasCommunityListing: false,
		publishedCommit: null,
	},
}

const view = {
	ok: true,
	package: { id: 'pkg-1', kodyId: 'release-notes', name: 'release-notes' },
	org: { slug: 'acme', personal: false },
	collaborators: [],
	invites: [],
	options: { teams: [], members: [] },
}

const input = { data: { username: 'acme', kodyId: 'release-notes' } }
beforeEach(() => {
	state.authenticated = true
	state.page = detail
	state.read.mockReset().mockResolvedValue({ status: 200, data: view })
	state.createInvite.mockReset().mockResolvedValue({
		status: 200,
		data: { ok: true, invite: { id: 'invite-1', prompt: 'one-time-token' } },
	})
	state.revokeInvite
		.mockReset()
		.mockResolvedValue({ status: 200, data: { ok: true } })
	state.mutation.mockReset()
})
test('loads package chrome and the collaborators view through shared operations', async () => {
	const result = await loadPackageCollaborators(input)
	expect(result.payload).toMatchObject({
		ok: true,
		shell: {
			username: 'acme',
			kodyId: 'release-notes',
			name: 'release-notes',
			description: 'Drafts release notes',
			isPrivate: true,
			isListed: false,
			listingId: null,
			defaultBranch: null,
			publishedCommit: null,
			ownerProfilePublic: true,
			viewerCanManage: true,
		},
		view,
	})
	expect(state.read).toHaveBeenCalledWith(
		expect.objectContaining({
			username: 'acme',
			kodyId: 'release-notes',
			user: { userId: 'viewer' },
		}),
	)
})
test('without Manage the tab is not found', async () => {
	state.read.mockResolvedValue({
		status: 403,
		data: { ok: false, error: 'You need Manage' },
	})
	await expect(loadPackageCollaborators(input)).rejects.toEqual({
		notFound: true,
	})
})
test('signed-out viewers go to login and come back to the tab', async () => {
	state.authenticated = false
	await expect(loadPackageCollaborators(input)).rejects.toEqual({
		redirect: {
			href: '/login?redirectTo=%2F%40acme%2Frelease-notes%2Fcollaborators',
		},
	})
	expect(state.read).not.toHaveBeenCalled()
})
test('a moved package redirects to its new collaborators tab', async () => {
	state.page = { kind: 'redirect', to: '/@acme/changelog' }
	await expect(loadPackageCollaborators(input)).rejects.toEqual({
		redirect: { href: '/@acme/changelog/collaborators', statusCode: 302 },
	})
	expect(state.read).not.toHaveBeenCalled()
})
test('package page access blocks collaborator reads before loading grants', async () => {
	state.page = { ...detail, viewerCanManageAccess: false }
	await expect(loadPackageCollaborators(input)).rejects.toEqual({
		notFound: true,
	})
	expect(state.read).not.toHaveBeenCalled()
})

test('addressed invite mutations use the authenticated shared write context and return one-time handoff only from creation', async () => {
	state.read.mockRejectedValue(new Error('Confirming read unavailable'))
	const created = await createPackageCollaboratorInvite({
		data: { ...input.data, invitee: ' @outside ', preset: 'contribute' },
	})
	expect(state.mutation).toHaveBeenCalledWith({})
	expect(state.createInvite).toHaveBeenCalledWith(
		expect.objectContaining({
			...input.data,
			invitee: '@outside',
			preset: 'contribute',
			user: { userId: 'viewer' },
		}),
	)
	expect(state.createInvite.mock.calls[0]?.[0].request.method).toBe('POST')
	expect(created.invite).toMatchObject({
		id: 'invite-1',
		prompt: 'one-time-token',
	})
	const revoked = await revokePackageCollaboratorInvite({
		data: { ...input.data, inviteId: ' invite-1 ' },
	})
	expect(state.revokeInvite).toHaveBeenCalledWith(
		expect.objectContaining({
			...input.data,
			inviteId: 'invite-1',
			user: { userId: 'viewer' },
		}),
	)
	expect(revoked).not.toHaveProperty('invite')
	expect(revoked).toEqual({ ok: true })
	expect(created).not.toHaveProperty('collaborators')
	expect(state.read).not.toHaveBeenCalled()
})

test('invite mutation validation and shared authorization failures do not produce successful handoffs', async () => {
	await expect(
		createPackageCollaboratorInvite({
			data: { ...input.data, invitee: '', preset: 'use' },
		}),
	).rejects.toThrow('Too small')
	expect(state.createInvite).not.toHaveBeenCalled()
	state.authenticated = false
	await expect(
		revokePackageCollaboratorInvite({
			data: { ...input.data, inviteId: 'invite-1' },
		}),
	).rejects.toThrow('Please sign in again.')
	expect(state.revokeInvite).not.toHaveBeenCalled()
	state.authenticated = true
	state.createInvite.mockResolvedValue({
		status: 403,
		data: { ok: false, error: 'Manage is required' },
	})
	await expect(
		createPackageCollaboratorInvite({
			data: { ...input.data, invitee: 'outside', preset: 'use' },
		}),
	).rejects.toThrow('Manage is required')
})
