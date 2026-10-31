import { expect, test } from 'vitest'
import {
	detectPackageAppVisitorAuthorityCodemod,
	packageAppVisitorAuthorityPatternFromMessage,
} from './0017-detect-package-app-visitor-authority.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown>) {
	return JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: { description: 'Demo package.', ...kody },
	})
}

function patterns(kody: Record<string, unknown>, source: string) {
	return detectPackageAppVisitorAuthorityCodemod
		.detect(
			{ 'package.json': manifest(kody), 'index.ts': source },
			packageContext,
		)
		.map((finding) => ({
			path: finding.path,
			pattern: packageAppVisitorAuthorityPatternFromMessage(finding.message),
		}))
}

const app = { entry: './index.ts' }

test('0017 ignores packages that are not apps', () => {
	expect(
		patterns(
			{},
			"import { kody } from 'kody:runtime'\nexport default async () => kody.secretList({})",
		),
	).toEqual([])
})

test('0017 flags capabilities missing from kody.app.capabilities', () => {
	const source = [
		"import { kody as k } from 'kody:runtime'",
		'export default async function fetch(request, name) {',
		'\tawait k.secretList({})',
		'\tawait k.jobList({})',
		'\tawait k.metaGetCurrentUser({})',
		"\tawait k.visitorNeed({ need: 'calendar' })",
		'\tawait k.mcp.github.listIssues({})',
		'\treturn await k[name]({})',
		'}',
	].join('\n')
	expect(patterns({ app }, source)).toEqual([
		{ path: 'index.ts', pattern: 'undeclared capability' },
		{ path: 'index.ts', pattern: 'computed capability' },
		{ path: 'index.ts', pattern: 'kody.mcp' },
	])
	expect(
		patterns(
			{ app: { ...app, capabilities: ['secretList', 'jobList'] } },
			source
				.replace('\tawait k.mcp.github.listIssues({})\n', '')
				.replace(
					'\treturn await k[name]({})',
					"\treturn await k['jobList']({})",
				),
		),
	).toEqual([])
})

test('0017 flags apps whose signed-in visitors now get the publisher’s credentials', () => {
	const source = [
		"import { credential } from 'kody:runtime'",
		'export default async function fetch() {',
		"\tconst github = await credential('github')",
		"\treturn await github.fetch('https://api.github.com/user')",
		'}',
	].join('\n')
	const credentials = { github: { kind: 'oauth', description: 'GitHub' } }
	expect(patterns({ app, credentials }, source)).toEqual([
		{ path: 'index.ts', pattern: 'visitor credential' },
	])
	expect(
		patterns(
			{
				app,
				credentials: {
					github: { ...credentials.github, ownerCredentialForVisitors: true },
				},
			},
			source,
		),
	).toEqual([{ path: 'index.ts', pattern: 'visitor credential' }])
	expect(
		patterns(
			{
				app: {
					...app,
					visitorNeeds: {
						github: { description: 'Read your GitHub', credential: 'github' },
					},
				},
				credentials,
			},
			source,
		),
	).toEqual([])
	expect(
		patterns(
			{ app },
			"export default async () => fetch('https://x.test', { headers: { a: '{{secret:token}}' } })",
		),
	).toEqual([{ path: 'index.ts', pattern: 'visitor credential' }])
})

test('0017 flags apps that read the visitor’s email', () => {
	expect(
		patterns(
			{ app },
			[
				"import { kody } from 'kody:runtime'",
				'export default async () => {',
				'\tconst { email } = await kody.metaGetCurrentUser({})',
				'\treturn email',
				'}',
			].join('\n'),
		),
	).toEqual([{ path: 'index.ts', pattern: 'identity email' }])
	expect(
		patterns(
			{ app },
			"import { kody } from 'kody:runtime'\nexport default async () => (await kody.metaGetCurrentUser({})).username",
		),
	).toEqual([])
})

test('0017 findings never carry names from the package', () => {
	const findings = detectPackageAppVisitorAuthorityCodemod.detect(
		{
			'package.json': manifest({ app }),
			'index.ts':
				"import { kody } from 'kody:runtime'\nexport default async () => kody.superSecretCapability({})",
		},
		packageContext,
	)
	expect(findings).toHaveLength(1)
	expect(JSON.stringify(findings)).not.toContain('superSecretCapability')
	expect(
		detectPackageAppVisitorAuthorityCodemod.transform(
			{ 'package.json': manifest({ app }) },
			packageContext,
		).changed,
	).toBe(false)
})
