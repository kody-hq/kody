import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	needs: vi.fn(),
	mappings: vi.fn(),
	credentials: vi.fn(),
	suppliersEnabled: vi.fn(),
	approval: vi.fn(),
	sources: vi.fn(),
}))

vi.mock('#worker/request-context.ts', () => ({
	memoizePerRequest: <Value>(input: { load: () => Promise<Value> }) =>
		input.load(),
}))
vi.mock('#worker/credentials/credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: (...args: Array<unknown>) =>
		mocks.needs(...args),
}))
vi.mock('#worker/credentials/credential-mappings.ts', () => ({
	loadAllCredentialMappingsForPackage: (...args: Array<unknown>) =>
		mocks.mappings(...args),
}))
vi.mock('#worker/credentials/credential-ids.ts', () => ({
	listOrgCredentialsByIds: (...args: Array<unknown>) =>
		mocks.credentials(...args),
}))
vi.mock('#worker/credentials/credential-suppliers-flag.ts', () => ({
	isPackageCredentialSuppliersEnabled: (...args: Array<unknown>) =>
		mocks.suppliersEnabled(...args),
}))
vi.mock('#worker/package-capabilities/capability-approvals-repo.ts', () => ({
	getLatestPackageCapabilityApproval: (...args: Array<unknown>) =>
		mocks.approval(...args),
}))
vi.mock('#worker/package-capabilities/capability-set.ts', () => ({
	visitorCredentialIdsByNeedKey: (json: string) =>
		new Map(Object.entries(JSON.parse(json) as Record<string, Array<string>>)),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIds: (...args: Array<unknown>) => mocks.sources(...args),
}))

const {
	describeUnmappableCredentials,
	isUnmappableNeed,
	loadOnePackageUnmappableCredentials,
	unmappableCredentialOwnerNotice,
	unmappableCredentialShareWarning,
} = await import('./package-unmappable-credentials.ts')

const db = {
	prepare: () => ({
		bind: () => ({
			all: async () => ({ results: [{ id: 'pkg-1', source_id: 'src-1' }] }),
		}),
	}),
}
const env = { APP_DB: db } as unknown as Env

beforeEach(() => {
	mocks.sources.mockResolvedValue([
		{ id: 'src-1', published_commit: 'commit-1' },
	])
	mocks.suppliersEnabled.mockResolvedValue(true)
	mocks.mappings.mockResolvedValue([])
	mocks.credentials.mockResolvedValue(new Map())
	mocks.approval.mockResolvedValue(null)
	mocks.needs.mockResolvedValue([])
})

const load = () =>
	loadOnePackageUnmappableCredentials({
		env,
		orgId: 'org-1',
		packageId: 'pkg-1',
	})

test('a publisher-supplied need is unmappable only while suppliers are on; visitor sharing always is', () => {
	expect(isUnmappableNeed({ supplier: 'publisher' }, true)).toBe(true)
	expect(isUnmappableNeed({ supplier: 'publisher' }, false)).toBe(false)
	expect(isUnmappableNeed({ supplier: 'executor' }, true)).toBe(false)
	expect(isUnmappableNeed({ ownerCredentialForVisitors: true }, false)).toBe(
		true,
	)
})

test('names the org-mapped credential of a publisher-supplied need, never its id', async () => {
	mocks.needs.mockResolvedValue([
		{ key: 'rooms-db', supplier: 'publisher' },
		{ key: 'my-token', supplier: 'executor' },
	])
	mocks.mappings.mockResolvedValue([
		{
			needKey: 'rooms-db',
			target: { target: 'org' },
			credentialIds: ['cred_1'],
		},
		{
			needKey: 'rooms-db',
			target: { target: 'mine', personId: 'p' },
			credentialIds: ['cred_2'],
		},
	])
	mocks.credentials.mockResolvedValue(
		new Map([['cred_1', { name: 'Prod DB', live: true }]]),
	)
	const credentials = await load()
	expect(credentials).toEqual([
		{ needKey: 'rooms-db', credentialName: 'Prod DB', reason: 'publisher' },
	])
	expect(mocks.credentials).toHaveBeenCalledWith(db, 'org-1', ['cred_1'])
	const text = describeUnmappableCredentials(credentials)
	expect(text).toBe('"Prod DB" (need "rooms-db")')
	expect(text).not.toContain('cred_1')
})

test('a need shared with visitors names the credentials the current approval shares', async () => {
	mocks.suppliersEnabled.mockResolvedValue(false)
	mocks.needs.mockResolvedValue([
		{ key: 'calendar', ownerCredentialForVisitors: true },
		{ key: 'rooms-db', supplier: 'publisher' },
	])
	mocks.approval.mockResolvedValue({
		publishedCommit: 'commit-1',
		capabilitySetJson: JSON.stringify({ calendar: ['cred_9'] }),
	})
	mocks.credentials.mockResolvedValue(
		new Map([['cred_9', { name: 'Team calendar', live: true }]]),
	)
	expect(await load()).toEqual([
		{
			needKey: 'calendar',
			credentialName: 'Team calendar',
			reason: 'visitors',
		},
	])
})

test('a credential that becomes unmappable after sharing locks on the next read', async () => {
	mocks.needs.mockResolvedValue([{ key: 'rooms-db', supplier: 'executor' }])
	expect(await load()).toEqual([])
	mocks.needs.mockResolvedValue([{ key: 'rooms-db', supplier: 'publisher' }])
	expect(await load()).toEqual([
		{ needKey: 'rooms-db', credentialName: null, reason: 'publisher' },
	])
})

test('an unpublished package has none, and a failed read fails closed', async () => {
	mocks.sources.mockResolvedValue([{ id: 'src-1', published_commit: null }])
	mocks.needs.mockResolvedValue([{ key: 'rooms-db', supplier: 'publisher' }])
	expect(await load()).toEqual([])
	mocks.sources.mockResolvedValue([
		{ id: 'src-1', published_commit: 'commit-1' },
	])
	mocks.needs.mockRejectedValue(new Error('KV down'))
	const credentials = await load()
	expect(credentials).toEqual([
		{ needKey: '', credentialName: null, reason: 'unchecked' },
	])
	expect(describeUnmappableCredentials(credentials)).toContain(
		'could not be checked',
	)
})

test('warnings and the owner notice name the credentials and say how to allow one collaborator', () => {
	const credentials = [
		{
			needKey: 'rooms-db',
			credentialName: 'Prod DB',
			reason: 'publisher' as const,
		},
	]
	const locked = unmappableCredentialShareWarning({
		packageLabel: 'Package "demo"',
		credentials,
		changesAllowed: false,
	})
	expect(locked).toContain('"Prod DB"')
	expect(locked).toContain("could make the package's code use them")
	expect(locked).toContain('cannot push, publish, or otherwise change it')
	const allowed = unmappableCredentialShareWarning({
		packageLabel: 'Package "demo"',
		credentials,
		changesAllowed: true,
	})
	expect(allowed).toContain('This grant allows changes')
	const notice = unmappableCredentialOwnerNotice({
		packageLabel: 'Package "demo"',
		credentials,
	})
	expect(notice).toContain('changes are owner-only')
	expect(notice).toContain('--allow-changes-despite-unmappable-credentials')
	expect(notice).toContain('Allow changes despite unmappable credentials')
})
