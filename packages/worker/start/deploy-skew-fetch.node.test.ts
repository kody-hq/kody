import { afterEach, expect, test, vi } from 'vitest'
import type * as ReloadOnDeploySkew from '#client/reload-on-deploy-skew.ts'

const getRouterInstance = vi.fn()
const reloadOnDeploySkew = vi.fn()
const readClientBuildId = vi.fn()

const sameSha = 'c'.repeat(40)
const oldSha = 'a'.repeat(40)
const newSha = 'b'.repeat(40)

vi.mock('@tanstack/react-start', () => ({
	getRouterInstance: (...args: Array<unknown>) => getRouterInstance(...args),
}))

vi.mock('#client/reload-on-deploy-skew.ts', async () => {
	const actual = await vi.importActual<typeof ReloadOnDeploySkew>(
		'#client/reload-on-deploy-skew.ts',
	)
	return {
		...actual,
		readClientBuildId: (...args: Array<unknown>) => readClientBuildId(...args),
		reloadOnDeploySkew: (...args: Array<unknown>) =>
			reloadOnDeploySkew(...args),
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	getRouterInstance.mockReset()
	reloadOnDeploySkew.mockReset()
	readClientBuildId.mockReset()
})

test('fetchWithDeploySkewCheck returns the response when builds match', async () => {
	readClientBuildId.mockReturnValue(sameSha)
	reloadOnDeploySkew.mockReturnValue(false)
	const response = new Response('ok', {
		headers: { 'X-Kody-Build': sameSha },
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response),
	)
	const { fetchWithDeploySkewCheck } = await import('./deploy-skew-fetch.ts')
	await expect(fetchWithDeploySkewCheck('/_serverFn/x')).resolves.toBe(response)
	expect(reloadOnDeploySkew).not.toHaveBeenCalled()
})

test('fetchWithDeploySkewCheck hard-navigates and throws on mismatch', async () => {
	readClientBuildId.mockReturnValue(oldSha)
	reloadOnDeploySkew.mockReturnValue(true)
	getRouterInstance.mockResolvedValue({
		latestLocation: { href: '/blog' },
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response('payload', {
					headers: { 'X-Kody-Build': newSha },
				}),
		),
	)
	const { fetchWithDeploySkewCheck } = await import('./deploy-skew-fetch.ts')
	await expect(fetchWithDeploySkewCheck('/_serverFn/x')).rejects.toMatchObject({
		name: 'DeploySkewRecovery',
	})
	expect(reloadOnDeploySkew).toHaveBeenCalledWith({
		serverBuild: newSha,
		href: '/blog',
	})
})

test('fetchWithDeploySkewCheck still throws when reload is spent so sibling fetches cannot leak payloads', async () => {
	readClientBuildId.mockReturnValue(oldSha)
	reloadOnDeploySkew.mockReturnValue(false)
	getRouterInstance.mockResolvedValue({
		latestLocation: { href: '/blog' },
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response('payload', {
					headers: { 'X-Kody-Build': newSha },
				}),
		),
	)
	const { fetchWithDeploySkewCheck } = await import('./deploy-skew-fetch.ts')
	await expect(fetchWithDeploySkewCheck('/_serverFn/x')).rejects.toMatchObject({
		name: 'DeploySkewRecovery',
	})
	expect(reloadOnDeploySkew).toHaveBeenCalledWith({
		serverBuild: newSha,
		href: '/blog',
	})
})
