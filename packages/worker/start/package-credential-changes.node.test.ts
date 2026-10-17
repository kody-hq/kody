import { QueryClient } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import {
	verifyDocumentActor,
	documentActorHeader,
	documentDestinationHeader,
} from './session-identity.ts'
import { expect, test, vi } from 'vitest'
const { save } = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('#start/server/credential-approval-mutation', () => ({
	savePackageCredentialMappings: save,
}))
import { postPackageCredentialChanges } from './package-credential-changes.ts'
const input = {
	username: 'team',
	kodyId: 'repo',
	changes: [
		{
			target: { type: 'default' as const, layer: 'mine' as const },
			needKey: 'github',
			credentials: [{ id: 'credential' }],
		},
	],
}
test('mapping writes preserve success, refusal, stale conflict, and session expiry', async () => {
	save.mockResolvedValue({ ok: true, needs: [] })
	expect(await postPackageCredentialChanges(input)).toEqual({
		kind: 'saved',
		view: { ok: true, needs: [] },
	})
	expect(save).toHaveBeenCalledWith({ data: input })
	const errors = [{ code: 'forbidden', needKey: 'github', message: 'Denied' }]
	save.mockResolvedValue({ ok: false, errors })
	expect(await postPackageCredentialChanges(input)).toEqual({
		kind: 'refused',
		errors,
	})
	save.mockResolvedValue({ ok: false, error: 'Mapping changed' })
	expect(await postPackageCredentialChanges(input)).toEqual({
		kind: 'error',
		message: 'Mapping changed',
	})
	save.mockRejectedValue(new Error('Please sign in again.'))
	expect(await postPackageCredentialChanges(input)).toEqual({
		kind: 'unauthorized',
	})
})

test('mapping identity change reaches native Query redirect handling without reporting a saved result', async () => {
	const queryClient = new QueryClient()
	const root = createRootRoute()
	const router = createRouter({
		origin: 'https://kody.test',
		isServer: false,
		history: createMemoryHistory({ initialEntries: ['/'] }),
		routeTree: root.addChildren([
			createRoute({ getParentRoute: () => root, path: '/' }),
		]),
	})
	setupRouterSsrQueryIntegration({ router, queryClient })
	await router.load()
	// Reloading a document is the browser boundary, not available in Node.
	const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined)
	save.mockImplementationOnce(async () =>
		verifyDocumentActor({
			headers: new Headers({
				[documentActorHeader]: JSON.stringify('old-user'),
				[documentDestinationHeader]: '/@team/repo',
			}),
			actor: null,
			requestUrl: 'https://kody.test/_serverFn/save',
		}),
	)
	const onSuccess = vi.fn()
	const mutation = queryClient.getMutationCache().build(queryClient, {
		retry: false,
		mutationFn: postPackageCredentialChanges,
		onSuccess,
	})
	try {
		await expect(mutation.execute(input)).rejects.toMatchObject({
			options: { href: '/@team/repo', reloadDocument: true, replace: true },
		})
		expect(mutation.state.status).toBe('error')
		expect(onSuccess).not.toHaveBeenCalled()
		expect(navigate).toHaveBeenCalledTimes(1)
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				href: '/@team/repo',
				reloadDocument: true,
				replace: true,
			}),
		)
	} finally {
		navigate.mockRestore()
		queryClient.clear()
	}
})

test('native trigger writes forward additive instance and specific disable actions without mapping changes', async () => {
	const enablements = [
		{
			trigger: { kind: 'cron' as const, name: 'daily' },
			state: 'on' as const,
			createInstance: true,
		},
		{
			trigger: { kind: 'cron' as const, name: 'daily' },
			state: 'off' as const,
			enablementId: 'original',
		},
	]
	save.mockResolvedValue({ ok: true, needs: [] })
	await postPackageCredentialChanges({
		username: 'team',
		kodyId: 'repo',
		enablements,
	})
	expect(save).toHaveBeenLastCalledWith({
		data: { username: 'team', kodyId: 'repo', enablements },
	})
})
