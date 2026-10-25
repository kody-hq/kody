import { expect, test } from 'vitest'
import {
	addPackageCredentialSupplierCounts,
	analyzePackageCredentialSupplierSource,
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
		personalMappingsOnOwnerCredentialForVisitorsNeeds: 0,
		enablementMappingsOnOwnerCredentialForVisitorsNeeds: 0,
	}

	addPackageCredentialSupplierCounts(counts, analysis)

	expect(counts.packagesCallingCredentialVisitor).toBe(0)
	expect(counts.appsWithVisitorNeeds).toBe(0)
	expect(counts.packagesWithOwnerCredentialForVisitorsNeeds).toBe(1)
	expect(counts.ownerCredentialForVisitorsNeeds).toBe(2)
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
