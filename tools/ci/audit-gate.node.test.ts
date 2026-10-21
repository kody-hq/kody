import { expect, test } from 'vitest'
import {
	formatAuditMarkdown,
	isDependencyManifestPath,
	parseAuditFindings,
	resolveAuditMode,
} from './audit-gate.ts'

test('dependency manifests anywhere in the workspace switch the audit to enforce', () => {
	expect(isDependencyManifestPath('package.json')).toBe(true)
	expect(isDependencyManifestPath('package-lock.json')).toBe(true)
	expect(isDependencyManifestPath('packages/worker/package.json')).toBe(true)
	expect(isDependencyManifestPath('docs/package.json.md')).toBe(false)
	expect(isDependencyManifestPath('tools/ci/audit-gate.ts')).toBe(false)

	expect(
		resolveAuditMode({
			requested: undefined,
			changedPaths: ['packages/cli/package.json', 'README.md'],
		}),
	).toBe('enforce')
	expect(
		resolveAuditMode({ requested: 'auto', changedPaths: ['README.md'] }),
	).toBe('report')
	expect(resolveAuditMode({ requested: undefined, changedPaths: [] })).toBe(
		'report',
	)
	// An unlistable diff fails closed.
	expect(resolveAuditMode({ requested: undefined, changedPaths: null })).toBe(
		'enforce',
	)
	expect(
		resolveAuditMode({ requested: 'report', changedPaths: ['package.json'] }),
	).toBe('report')
	expect(resolveAuditMode({ requested: 'enforce', changedPaths: [] })).toBe(
		'enforce',
	)
})

test('audit findings keep moderate-or-worse entries with their advisories', () => {
	const findings = parseAuditFindings({
		auditReportVersion: 2,
		vulnerabilities: {
			agents: {
				name: 'agents',
				severity: 'high',
				via: ['@modelcontextprotocol/server'],
				fixAvailable: {
					name: 'agents',
					version: '0.29.0',
					isSemVerMajor: true,
				},
			},
			'@modelcontextprotocol/server': {
				name: '@modelcontextprotocol/server',
				severity: 'high',
				via: [
					{
						title: 'Server bearer authentication accepted other tokens',
						url: 'https://github.com/advisories/GHSA-rvq5-wwqv-78pq',
						severity: 'high',
					},
				],
				fixAvailable: false,
			},
			hono: {
				name: 'hono',
				severity: 'moderate',
				via: [
					{
						title: 'serveStatic decodes the request path twice',
						url: 'https://github.com/advisories/GHSA-5r4p-p66f-jhc7',
						severity: 'moderate',
					},
				],
				fixAvailable: true,
			},
			'tiny-low': { name: 'tiny-low', severity: 'low', via: [] },
		},
	})

	expect(findings.map((finding) => [finding.name, finding.severity])).toEqual([
		['@modelcontextprotocol/server', 'high'],
		['agents', 'high'],
		['hono', 'moderate'],
	])
	expect(findings[1]?.advisories).toEqual([
		{ title: 'depends on vulnerable @modelcontextprotocol/server', url: '' },
	])
	expect(formatAuditMarkdown(findings)).toContain(
		'- `@modelcontextprotocol/server` (high) (no automatic fix): [Server bearer authentication accepted other tokens](https://github.com/advisories/GHSA-rvq5-wwqv-78pq)',
	)
	expect(formatAuditMarkdown([])).toBe(
		'No moderate, high, or critical production advisories.\n',
	)
})

test('an npm audit error report is not mistaken for a clean audit', () => {
	expect(() =>
		parseAuditFindings({ error: { code: 'ENOTFOUND', summary: 'registry' } }),
	).toThrow(/npm audit failed/)
	expect(() => parseAuditFindings(null)).toThrow(/no JSON report/)
})
