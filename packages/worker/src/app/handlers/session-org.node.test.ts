import { expect, test, vi } from 'vitest'
import type * as AuthSession from '#app/auth-session.ts'
import { createSessionHandler } from '#app/handlers/session.ts'

const loadSessionInfo = vi.hoisted(() =>
	vi.fn(async () => ({ session: { username: 'kent' }, setCookie: null })),
)

vi.mock('#app/session-info.ts', () => ({ loadSessionInfo }))
vi.mock('#app/auth-session.ts', async (importOriginal) => ({
	...(await importOriginal<typeof AuthSession>()),
	readAuthSessionResult: async () => ({
		session: { stableUserId: 'user-1' },
		setCookie: null,
	}),
}))

const handler = createSessionHandler({} as Env)

test('?org evaluates flags with that org as the page org', async () => {
	for (const [query, pathname] of [
		['?org=kody', '/@kody'],
		['?org=bad/slug', undefined],
		['', undefined],
	] as const) {
		loadSessionInfo.mockClear()
		const response = await handler({
			request: new Request(`https://kody.codes/session${query}`),
		})
		expect(await response.json()).toMatchObject({ ok: true })
		expect(loadSessionInfo).toHaveBeenCalledWith(
			expect.any(Request),
			expect.anything(),
			pathname,
		)
	}
})
