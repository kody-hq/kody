import { expect, test } from 'vitest'
import { type ExecutionContextGrantSummary } from './execution-contexts.ts'
import {
	optInCopy,
	presetLabels,
	registerCopy,
	shareCopy,
	sharingLevelHelp,
	sharingLevelLabels,
} from './execution-context-trust-copy.ts'

const grants: Record<string, ExecutionContextGrantSummary> = {
	locked: {
		fs: 0,
		egress: { mode: 'none' },
		credentials: 'none',
		runtime: 'none',
		timeoutMs: 90_000,
	},
	publicDefault: {
		fs: 0,
		egress: { mode: 'public' },
		credentials: 'none',
		runtime: 'all',
		timeoutMs: 90_000,
	},
	lanWithFiles: {
		fs: 2,
		fsMode: 'write',
		egress: { mode: 'public-and-lan' },
		credentials: { count: 1 },
		runtime: { mode: 'allowlist', count: 3 },
		timeoutMs: 300_000,
	},
	allowlist: {
		fs: 1,
		fsMode: 'read',
		egress: { mode: 'allowlist', hosts: 4 },
		credentials: 'none',
		runtime: { mode: 'allowlist', count: 0 },
		timeoutMs: 60_000,
	},
}

test('opt-in copy for every access combination', () => {
	for (const [key, grant] of Object.entries(grants)) {
		expect(
			optInCopy({ name: 'buildbox', operator: 'sam', grant }),
		).toMatchSnapshot(key)
	}
})

test('share copy for every access combination, as operator and as manager', () => {
	for (const [key, grant] of Object.entries(grants)) {
		for (const viewerIsOperator of [true, false]) {
			expect(
				shareCopy({
					name: 'buildbox',
					operator: 'sam',
					viewerIsOperator,
					grant,
				}),
			).toMatchSnapshot(`${key}:${viewerIsOperator ? 'operator' : 'manager'}`)
		}
	}
})

test('sharing levels and presets', () => {
	const levels = Object.keys(sharingLevelLabels) as Array<
		keyof typeof sharingLevelLabels
	>
	expect(
		levels.map((level) => ({
			label: sharingLevelLabels[level],
			help: sharingLevelHelp({ level, orgSlug: 'acme', team: 'build' }),
		})),
	).toMatchSnapshot()
	expect(presetLabels).toMatchSnapshot()
})

test('register copy, personal and team, names kody login', () => {
	const personal = registerCopy({ orgSlug: null })
	const team = registerCopy({ orgSlug: 'acme' })
	expect(personal).toMatchSnapshot('personal')
	expect(team).toMatchSnapshot('team')
	expect(team.commands).toContain(
		'kody context register --name my-machine --org acme',
	)
	for (const copy of [personal, team]) {
		expect(copy.login).toContain('`kody login`')
	}
})

test('LAN line appears only when local network access is on', () => {
	expect(
		optInCopy({ name: 'x', operator: 'sam', grant: grants.publicDefault! }).lan,
	).toBeNull()
	expect(
		optInCopy({ name: 'x', operator: 'sam', grant: grants.lanWithFiles! }).lan,
	).toContain('Local network access is on')
})

test('credential copy depends on oauthClientCredentials returning only a handle', () => {
	// If credential values could reach a context, every "stay on Kody" line is false.
	expect(
		optInCopy({ name: 'x', operator: 'sam', grant: grants.locked! })
			.paragraphs[0],
	).toContain('Your credential values stay on Kody.')
})
