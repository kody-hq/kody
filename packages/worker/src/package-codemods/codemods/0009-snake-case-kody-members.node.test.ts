import { expect, test } from 'vitest'
import { snakeCaseKodyMembersCodemod } from './0009-snake-case-kody-members.ts'

const packageContext = { packageName: '@user/demo' }

function manifest() {
	return `${JSON.stringify(
		{
			name: '@user/demo',
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for snake_case kody member recase.',
			},
		},
		null,
		'\t',
	)}\n`
}

test('0009 recases snake_case kody members, brackets, and entity refs, and leaves MCP tools alone', async () => {
	const files = {
		'package.json': manifest(),
		'index.ts': [
			"import { kody } from 'kody:runtime'",
			'',
			'export default async function run() {',
			'\tawait kody.email_send({ subject: "hi" })',
			'\tawait kody["package_get"]({ package_id: "demo" })',
			'\tawait kody.mcp["home"].set_pin({ pin: "1" })',
			'\treturn "capability:email_send"',
			'}',
			'',
		].join('\n'),
		'README.md':
			'Call `kody.secret_list({})` or search `capability:secret_list`.\n',
	}

	expect(
		await snakeCaseKodyMembersCodemod.detect(files, packageContext),
	).toEqual(
		expect.arrayContaining([
			{ path: 'README.md', message: expect.stringContaining('camelCase') },
			{ path: 'index.ts', message: expect.stringContaining('camelCase') },
		]),
	)

	const result = await snakeCaseKodyMembersCodemod.transform(
		files,
		packageContext,
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.needsManual).toEqual([])
	expect(result.files['index.ts']).toContain(
		'kody.emailSend({ subject: "hi" })',
	)
	expect(result.files['index.ts']).toContain(
		'kody.packageGet({ package_id: "demo" })',
	)
	expect(result.files['index.ts']).toContain(
		'kody.mcp["home"].set_pin({ pin: "1" })',
	)
	expect(result.files['index.ts']).toContain('"capability:emailSend"')
	expect(result.files['index.ts']).not.toContain('kody.email_send')
	expect(result.files['index.ts']).not.toContain('kody["package_get"]')
	expect(result.files['README.md']).toContain('kody.secretList({})')
	expect(result.files['README.md']).toContain('capability:secretList')

	const again = await snakeCaseKodyMembersCodemod.transform(
		result.files,
		packageContext,
	)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
	expect(again.needsManual).toEqual([])
})

test('0009 recases leftover ambient kody.foo_bar without a kody:runtime import', async () => {
	const files = {
		'package.json': manifest(),
		'legacy.ts': [
			'export default async function run() {',
			'\treturn await kody.package_get({ package_id: "demo" })',
			'}',
			'',
		].join('\n'),
	}

	expect(
		await snakeCaseKodyMembersCodemod.detect(files, packageContext),
	).toEqual([
		{ path: 'legacy.ts', message: expect.stringContaining('camelCase') },
	])
	const result = await snakeCaseKodyMembersCodemod.transform(
		files,
		packageContext,
	)
	expect(result.changedPaths).toEqual(['legacy.ts'])
	expect(result.files['legacy.ts']).toContain(
		'kody.packageGet({ package_id: "demo" })',
	)
	expect(result.files['legacy.ts']).not.toContain('kody.package_get')
})

test('0009 detect does not skip a later file after a global entity-ref match', async () => {
	const files = {
		'package.json': manifest(),
		'broken.ts': 'export default function broken( {\ncapability:email_send\n',
		'refs.ts': [
			'export default function note() {',
			'\treturn "capability:package_get"',
			'}',
			'',
		].join('\n'),
	}

	expect(
		await snakeCaseKodyMembersCodemod.detect(files, packageContext),
	).toEqual(
		expect.arrayContaining([
			{
				path: 'broken.ts',
				message: expect.stringContaining('could not be parsed'),
			},
			{ path: 'refs.ts', message: expect.stringContaining('camelCase') },
		]),
	)
	const result = await snakeCaseKodyMembersCodemod.transform(
		files,
		packageContext,
	)
	expect(result.files['refs.ts']).toContain('"capability:packageGet"')
	expect(result.needsManual).toEqual([
		{
			path: 'broken.ts',
			message: expect.stringContaining('could not be parsed'),
		},
	])
})

test('0009 flags computed kody[id] for manual recase and does not rewrite it', async () => {
	const files = {
		'package.json': manifest(),
		'dynamic.ts': [
			"import { kody } from 'kody:runtime'",
			'',
			'export default async function run(id) {',
			'\treturn await kody[id]({})',
			'}',
			'',
		].join('\n'),
	}

	expect(
		await snakeCaseKodyMembersCodemod.detect(files, packageContext),
	).toEqual([
		{ path: 'dynamic.ts', message: expect.stringContaining('computed') },
	])
	const result = await snakeCaseKodyMembersCodemod.transform(
		files,
		packageContext,
	)
	expect(result.changed).toBe(false)
	expect(result.files['dynamic.ts']).toContain('kody[id]({})')
	expect(result.needsManual).toEqual([
		{ path: 'dynamic.ts', message: expect.stringContaining('computed') },
	])
})
