import { expect, test } from 'vitest'
import type { ExecutionContextGrantSummary } from './execution-contexts.ts'
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
		runtime: 'none',
		timeoutMs: 90_000,
	},
	publicDefault: {
		fs: 0,
		egress: { mode: 'public' },
		runtime: 'all',
		timeoutMs: 90_000,
	},
	lanWithFiles: {
		fs: 2,
		fsMode: 'write',
		egress: { mode: 'public-and-lan' },
		runtime: { mode: 'allowlist', count: 3 },
		timeoutMs: 300_000,
	},
	allowlist: {
		fs: 1,
		fsMode: 'read',
		egress: { mode: 'allowlist', hosts: 4 },
		runtime: { mode: 'allowlist', count: 0 },
		timeoutMs: 60_000,
	},
}

test('opt-in copy names the machine and interpolates each access combination', () => {
	for (const grant of Object.values(grants)) {
		const copy = optInCopy({ name: 'buildbox', operator: 'sam', grant })
		const text = copy.paragraphs.join(' ')
		expect(copy.title).toContain('buildbox')
		expect(text).toContain('@sam')
		expect(text).toMatch(/files:.*local network:.*internet:.*Kody APIs:/)
		expect(copy.lan === null).toBe(grant.egress.mode !== 'public-and-lan')
		expect(
			text.includes("Host folders are for the operator's own runs only"),
		).toBe(grant.fs > 0)
	}
})

test('share copy distinguishes the operator from a manager on every access combination', () => {
	for (const grant of Object.values(grants)) {
		const asOperator = shareCopy({
			name: 'buildbox',
			operator: 'sam',
			viewerIsOperator: true,
			grant,
		})
		const asManager = shareCopy({
			name: 'buildbox',
			operator: 'sam',
			viewerIsOperator: false,
			grant,
		})
		expect(asOperator.title).toContain('buildbox')
		expect(asOperator.paragraphs.join(' ')).toContain('You will')
		expect(asOperator.paragraphs.join(' ')).not.toContain('@sam will')
		expect(asManager.paragraphs.join(' ')).toContain('@sam will')
		expect(asManager.lan === null).toBe(grant.egress.mode !== 'public-and-lan')
		expect(
			asOperator.paragraphs
				.join(' ')
				.includes("Host folders are for the operator's own runs only"),
		).toBe(grant.fs > 0)
	}
})

test('sharing levels interpolate org and team; presets keep Use/Contribute/Manage', () => {
	expect(Object.keys(sharingLevelLabels).sort()).toEqual(
		['only_me', 'org', 'people', 'team'].sort(),
	)
	expect(sharingLevelHelp({ level: 'people', orgSlug: 'acme' })).toContain(
		'@acme',
	)
	expect(
		sharingLevelHelp({ level: 'team', orgSlug: 'acme', team: 'build' }),
	).toMatch(/team build.*@acme/)
	expect(sharingLevelHelp({ level: 'org', orgSlug: 'acme' })).toContain('@acme')
	expect(presetLabels.use).toMatch(/^Use:/)
	expect(presetLabels.contribute).toMatch(/^Contribute:/)
	expect(presetLabels.manage).toMatch(/^Manage:/)
})

test('register copy, personal and team, names kody login', () => {
	const personal = registerCopy({ orgSlug: null })
	const team = registerCopy({ orgSlug: 'acme' })
	expect(personal.commands).toEqual([
		'npm install -g @kodycodes/cli',
		'kody login',
		'kody connect --name my-machine',
	])
	expect(team.commands).toEqual([
		'npm install -g @kodycodes/cli',
		'kody login',
		'kody connect --name my-machine --org acme',
	])
	for (const copy of [personal, team]) {
		expect(copy.login).toContain('`kody login`')
		expect(copy.trust.join(' ')).toContain(
			'Host folders apply only to your own runs',
		)
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

test('opt-in copy discloses that the machine can use your credentials and read the responses', () => {
	const copy = optInCopy({ name: 'x', operator: 'sam', grant: grants.locked! })
	const text = copy.paragraphs.join(' ')
	expect(text).toContain(
		"can use your credentials (GitHub, email and any others you've connected) and read the responses",
	)
	expect(text).toContain('Your credential values stay in Kody cloud')
	expect(text).toContain('Opting in is your consent to this.')
})

test('share and opt-in copy mark host folders as operator-only when the grant lists paths', () => {
	const withFiles = shareCopy({
		name: 'x',
		operator: 'sam',
		viewerIsOperator: true,
		grant: grants.lanWithFiles!,
	})
	expect(withFiles.paragraphs.join(' ')).toContain(
		'files: none (machine has 2 paths, write for operator runs only)',
	)
	expect(withFiles.paragraphs.join(' ')).toContain(
		"Host folders are for the operator's own runs only. Shared runs do not mount them.",
	)
	const withoutFiles = shareCopy({
		name: 'x',
		operator: 'sam',
		viewerIsOperator: true,
		grant: grants.locked!,
	})
	expect(withoutFiles.paragraphs.join(' ')).not.toContain(
		'Host folders are for the operator',
	)
	const optIn = optInCopy({
		name: 'x',
		operator: 'sam',
		grant: grants.allowlist!,
	})
	expect(optIn.paragraphs.join(' ')).toContain(
		'files: none (machine has 1 path, read for operator runs only)',
	)
	expect(optIn.paragraphs.join(' ')).toContain('Shared runs do not mount them.')
})
