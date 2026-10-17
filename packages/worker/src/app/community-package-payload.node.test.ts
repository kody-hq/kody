import { beforeEach, expect, test, vi } from 'vitest'
import { readmeForPackagePage } from './community-package-payload.ts'

const mocks = vi.hoisted(() => ({ readme: vi.fn(), highlight: vi.fn() }))
vi.mock('#app/package-files-data.ts', () => ({
	loadOwnerPackageReadme: mocks.readme,
	loadPackagePageHasAgentsDocs: vi.fn(),
	resolvePackagePageReadmeImageBaseHref: vi.fn(),
}))
vi.mock('#app/highlight-code.ts', () => ({
	highlightMarkdownFences: mocks.highlight,
}))
const input = {
	env: {} as Env,
	request: new Request('https://example.com/@owner/plain-repo'),
	listingReadme: null,
	ownerSourceId: 'source',
	ownerUserId: 'owner',
	viewerIsOwner: false,
	isPrivate: false,
}
beforeEach(() => {
	vi.clearAllMocks()
	mocks.readme.mockResolvedValue({ content: '# HEAD README', commit: 'head' })
	mocks.highlight.mockResolvedValue([])
})
test('public guests receive plain repository README and its actual commit', async () => {
	expect(await readmeForPackagePage(input)).toEqual({
		readmeContent: '# HEAD README',
		readmeCommit: 'head',
		readmeFences: [],
	})
	expect(mocks.readme).toHaveBeenCalledOnce()
})
test('private repository fallback requires the owner', async () => {
	expect(await readmeForPackagePage({ ...input, isPrivate: true })).toEqual({
		readmeContent: null,
		readmeCommit: null,
		readmeFences: [],
	})
	expect(mocks.readme).not.toHaveBeenCalled()
	await readmeForPackagePage({ ...input, isPrivate: true, viewerIsOwner: true })
	expect(mocks.readme).toHaveBeenCalledOnce()
})
test('listing README remains authoritative instead of loading HEAD', async () => {
	const result = await readmeForPackagePage({
		...input,
		listingReadme: '# Pinned',
	})
	expect(result.readmeContent).toBe('# Pinned')
	expect(result.readmeCommit).toBeNull()
	expect(mocks.readme).not.toHaveBeenCalled()
})
