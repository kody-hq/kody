import { expect, test, vi } from 'vitest'

const packageSourceMocks = vi.hoisted(() => ({
	listSavedPackagesPage: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: packageSourceMocks.listSavedPackagesPage,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: packageSourceMocks.loadPackageSourceBySourceId,
}))

import {
	addPackageCredentialSupplierCounts,
	analyzePackageCredentialSupplierSource,
	scanPackageCredentialSupplierReportStep,
} from './admin-package-credential-supplier-report.ts'

test('credential supplier report counts package sources without returning identifiers', () => {
	const analysis = analyzePackageCredentialSupplierSource({
		manifestPath: 'package.json',
		files: {
			'package.json': JSON.stringify({
				name: 'private-fixture-package',
				kody: {
					app: { visitorNeeds: { calendar: { provider: 'example' } } },
					credentials: {
						calendar: {
							provider: 'example',
							ownerCredentialForVisitors: true,
						},
					},
				},
			}),
			'src/index.ts': `
				import { credential } from 'kody:runtime'
				await credential.visitor('calendar')
			`,
		},
	})
	const counts = {
		packagesCallingCredentialVisitor: 0,
		appsWithVisitorNeeds: 0,
		packagesWithOwnerCredentialForVisitorsNeeds: 0,
		ownerCredentialForVisitorsNeeds: 0,
		packagesSkipped: 0,
		personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
	}

	addPackageCredentialSupplierCounts(counts, analysis, [
		{ target: 'mine', count: 2 },
		{ target: 'enablement', count: 3 },
		{ target: 'org', count: 8 },
	])
	const output = JSON.stringify({ counts })

	expect(counts).toEqual({
		packagesCallingCredentialVisitor: 1,
		appsWithVisitorNeeds: 1,
		packagesWithOwnerCredentialForVisitorsNeeds: 1,
		ownerCredentialForVisitorsNeeds: 1,
		packagesSkipped: 0,
		personalMappingsOnOwnerCredentialForVisitorsNeeds: 2,
		enablementMappingsOnOwnerCredentialForVisitorsNeeds: 3,
	})
	expect(output).not.toContain('private-fixture-package')
	expect(output).not.toContain('calendar')
	expect(output).not.toContain('example')
})

test('credential supplier report recognizes multiple owner needs but no visitor call', () => {
	const analysis = analyzePackageCredentialSupplierSource({
		manifestPath: 'package.json',
		files: {
			'package.json': JSON.stringify({
				kody: {
					credentials: {
						first: { ownerCredentialForVisitors: true },
						second: { ownerCredentialForVisitors: true },
					},
				},
			}),
			'src/index.ts': 'export const value = 1',
		},
	})
	const counts = {
		packagesCallingCredentialVisitor: 0,
		appsWithVisitorNeeds: 0,
		packagesWithOwnerCredentialForVisitorsNeeds: 0,
		ownerCredentialForVisitorsNeeds: 0,
		packagesSkipped: 0,
		personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
	}

	addPackageCredentialSupplierCounts(counts, analysis)

	expect(counts.packagesCallingCredentialVisitor).toBe(0)
	expect(counts.appsWithVisitorNeeds).toBe(0)
	expect(counts.packagesWithOwnerCredentialForVisitorsNeeds).toBe(1)
	expect(counts.ownerCredentialForVisitorsNeeds).toBe(2)
})

test('credential supplier report skips a failed package and advances the page cursor', async () => {
	packageSourceMocks.listSavedPackagesPage.mockReset()
	packageSourceMocks.loadPackageSourceBySourceId.mockReset()
	const state = {
		cursor: null as string | null,
		complete: false,
		counts: {
			packagesCallingCredentialVisitor: 0,
			appsWithVisitorNeeds: 0,
			packagesWithOwnerCredentialForVisitorsNeeds: 0,
			ownerCredentialForVisitorsNeeds: 0,
			packagesSkipped: 0,
			personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
			enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		},
	}
	const savedPackage = (id: string) => ({
		id,
		userId: `owner-${id}`,
		sourceId: `source-${id}`,
	})
	packageSourceMocks.listSavedPackagesPage
		.mockResolvedValueOnce([savedPackage('failed'), savedPackage('next')])
		.mockResolvedValueOnce([savedPackage('next')])
	packageSourceMocks.loadPackageSourceBySourceId
		.mockRejectedValueOnce(new Error('source unavailable'))
		.mockResolvedValueOnce({
			files: {
				'package.json': JSON.stringify({
					kody: {
						app: { visitorNeeds: {} },
					},
				}),
			},
			source: { manifest_path: 'package.json' },
		})

	const input = {
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://app.example.test',
		state,
		limit: 1,
	}
	await scanPackageCredentialSupplierReportStep(input)

	expect(state.cursor).toBe('failed')
	expect(state.counts.packagesSkipped).toBe(1)

	await scanPackageCredentialSupplierReportStep(input)

	expect(state.cursor).toBe('next')
	expect(state.counts.packagesSkipped).toBe(1)
	expect(state.counts.appsWithVisitorNeeds).toBe(1)
	expect(JSON.stringify(state.counts)).not.toContain('failed')
	expect(JSON.stringify(state.counts)).not.toContain('next')
})

test('credential supplier mapping queries chunk need keys for D1 parameter limits', async () => {
	packageSourceMocks.listSavedPackagesPage.mockReset()
	packageSourceMocks.loadPackageSourceBySourceId.mockReset()
	packageSourceMocks.listSavedPackagesPage.mockResolvedValueOnce([
		{ id: 'pkg', userId: 'owner', sourceId: 'source' },
	])
	const credentials = Object.fromEntries(
		Array.from({ length: 120 }, (_, index) => [
			`need-${index}`,
			{ ownerCredentialForVisitors: true },
		]),
	)
	packageSourceMocks.loadPackageSourceBySourceId.mockResolvedValueOnce({
		files: {
			'package.json': JSON.stringify({ kody: { credentials } }),
		},
		source: { manifest_path: 'package.json' },
	})
	const boundCounts: Array<number> = []
	const db = {
		prepare() {
			return {
				bind(...args: Array<unknown>) {
					boundCounts.push(args.length)
					return { all: async () => ({ results: [] }) }
				},
			}
		},
	}
	const state = {
		cursor: null as string | null,
		complete: false,
		counts: {
			packagesCallingCredentialVisitor: 0,
			appsWithVisitorNeeds: 0,
			packagesWithOwnerCredentialForVisitorsNeeds: 0,
			ownerCredentialForVisitorsNeeds: 0,
			packagesSkipped: 0,
			personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
			enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		},
	}

	await scanPackageCredentialSupplierReportStep({
		env: { APP_DB: db } as unknown as Env,
		baseUrl: 'https://app.example.test',
		state,
		limit: 1,
	})

	expect(boundCounts).toEqual([92, 32])
	expect(state.counts.ownerCredentialForVisitorsNeeds).toBe(120)
})

test('credential supplier report counts an explicitly declared empty visitor needs object', () => {
	const analysis = analyzePackageCredentialSupplierSource({
		manifestPath: 'package.json',
		files: {
			'package.json': JSON.stringify({
				kody: { app: { visitorNeeds: {} } },
			}),
		},
	})

	expect(analysis.visitorNeeds).toBe(true)
})
