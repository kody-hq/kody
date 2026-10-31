export type PackageFile = { path: string; content: string }

export const personalPackageLeaf = 'rehearsal-notes'
export const userSecretName = 'rehearsalUserSecret'
export const packageSecretName = 'rehearsalPackageSecret'
export const integrationName = 'rehearsal-mock'
export const appMarker = 'kody-rehearsal-app'

function readme(title: string, intent: string) {
	return `# ${title}\n\nSynthetic package for the Kody preview migration rehearsal.\n\n## Intent\n\n${intent}\n`
}

const agentsMd =
	'# Agents\n\nSynthetic rehearsal data. Import `./ping` to smoke test.\n'

/**
 * A person's package covering §12.2 "data per user": an app, a recurring job,
 * a webhook, a package-scoped secret, and an export that proves that secret
 * still decrypts by fetching the mock echo route with the placeholder.
 */
export function personalPackageFiles(input: {
	username: string
	echoUrl: string
}): Array<PackageFile> {
	const packageJson = {
		name: `@${input.username}/${personalPackageLeaf}`,
		version: '1.0.0',
		description: `Rehearsal notes for ${input.username}`,
		exports: {
			'.': './src/index.ts',
			'./ping': './src/ping.ts',
			'./set-package-secret': './src/set-package-secret.ts',
			'./secret-proof': './src/secret-proof.ts',
			'./on-hook': './src/on-hook.ts',
		},
		kody: {
			description:
				'Rehearsal package with an app, jobs, a webhook, and a package secret',
			app: { entry: './app/router.ts' },
			jobs: {
				'daily-digest': {
					entry: './src/daily.ts',
					schedule: { type: 'interval', every: '1d' },
					enabled: true,
				},
			},
			webhooks: [{ name: 'inbound', export: './on-hook', responseMode: 'ack' }],
		},
	}
	return [
		{
			path: 'package.json',
			content: `${JSON.stringify(packageJson, null, 2)}\n`,
		},
		{
			path: 'README.md',
			content: readme(
				'Rehearsal notes',
				'Exercise package apps, jobs, webhooks, and package secrets across the Teams migration.',
			),
		},
		{ path: 'AGENTS.md', content: agentsMd },
		{
			path: 'src/index.ts',
			content: `export function owner() {\n\treturn ${JSON.stringify(input.username)}\n}\n`,
		},
		{
			path: 'src/ping.ts',
			content: `export default async function ping() {\n\treturn { pong: true, owner: ${JSON.stringify(input.username)} }\n}\n`,
		},
		{
			path: 'src/daily.ts',
			content:
				'export default async function daily() {\n\treturn { ran: new Date().toISOString() }\n}\n',
		},
		{
			path: 'src/on-hook.ts',
			content:
				'export default async function onHook() {\n\treturn { ok: true }\n}\n',
		},
		{
			path: 'src/set-package-secret.ts',
			content: [
				"import { kody } from 'kody:runtime'",
				'',
				'export default async function setPackageSecret(params: { value: string }) {',
				'\treturn kody.secretSet({',
				`\t\tname: ${JSON.stringify(packageSecretName)},`,
				'\t\tvalue: params.value,',
				"\t\tscope: 'package',",
				"\t\tdescription: 'Rehearsal package-scoped secret',",
				'\t})',
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'src/secret-proof.ts',
			content: [
				'export default async function secretProof() {',
				`\tconst response = await fetch(${JSON.stringify(input.echoUrl)}, {`,
				`\t\theaders: { 'x-rehearsal-secret': '{{secret:${packageSecretName}}}' },`,
				'\t})',
				'\tconst body = (await response.json()) as { sha256?: Record<string, string | null> }',
				"\treturn { status: response.status, sha256: body.sha256?.['x-rehearsal-secret'] ?? null }",
				'}',
				'',
			].join('\n'),
		},
		{
			path: 'app/router.ts',
			content: `export default {\n\tasync fetch() {\n\t\treturn new Response('<h1 data-marker="${appMarker}">${input.username} notes</h1>', {\n\t\t\theaders: { 'content-type': 'text/html' },\n\t\t})\n\t},\n}\n`,
		},
	]
}

/** An org package (`@<org>/<leaf>`), published by an org Owner. */
export function orgPackageFiles(input: {
	scope: string
	leaf: string
	description: string
}): Array<PackageFile> {
	const packageJson = {
		name: `@${input.scope}/${input.leaf}`,
		version: '1.0.0',
		description: input.description,
		license: 'MIT',
		exports: { '.': './src/index.ts' },
		kody: { description: input.description },
	}
	return [
		{
			path: 'package.json',
			content: `${JSON.stringify(packageJson, null, 2)}\n`,
		},
		{ path: 'README.md', content: readme(input.leaf, input.description) },
		{ path: 'AGENTS.md', content: agentsMd },
		{
			path: 'src/index.ts',
			content: `export default async function main() {\n\treturn { org: ${JSON.stringify(input.scope)}, leaf: ${JSON.stringify(input.leaf)} }\n}\n`,
		},
	]
}

export type OrgPackageVisibility = 'public' | 'private' | 'hidden'

export const orgPackages: ReadonlyArray<{
	leaf: string
	visibility: OrgPackageVisibility
	description: string
}> = [
	{
		leaf: 'rehearsal-public-tools',
		visibility: 'public',
		description: 'Public org package with a community listing',
	},
	{
		leaf: 'rehearsal-private-tools',
		visibility: 'private',
		description: 'Private org package',
	},
	{
		leaf: 'rehearsal-hidden-tools',
		visibility: 'hidden',
		description: 'Org package hidden from search discovery',
	},
]

/** Memories per role; the snapshot replays `memoryQueries` against them. */
export const rehearsalMemories: ReadonlyArray<{
	category: string
	subject: string
	summary: string
	tags: Array<string>
}> = [
	{
		category: 'preference',
		subject: 'Coffee order',
		summary: 'Prefers a flat white with oat milk, no sugar.',
		tags: ['coffee', 'food'],
	},
	{
		category: 'project',
		subject: 'Garden irrigation',
		summary: 'Drip irrigation on the tomato beds runs at 6am for 20 minutes.',
		tags: ['garden', 'home'],
	},
	{
		category: 'fact',
		subject: 'Bike tire pressure',
		summary: 'Road bike tires go to 80 psi front and 85 psi rear.',
		tags: ['bike'],
	},
	{
		category: 'preference',
		subject: 'Meeting hours',
		summary: 'No meetings before 10am or after 4pm Mountain time.',
		tags: ['work', 'calendar'],
	},
]

export const memoryQueries: ReadonlyArray<string> = [
	'what coffee do I like',
	'when does the garden get watered',
	'what pressure for the bike tires',
	'when can I take meetings',
]
