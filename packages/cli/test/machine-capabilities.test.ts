import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	ecpSignatureHeader,
	importEd25519PublicKey,
	parseEcpSignatureHeader,
	verifyEcpHttpSignature,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	generateContextKey,
	importContextKey,
	syncContextCapabilities,
} from '../src/execution-context/client.js'
import {
	allowLocalPath,
	readLocalPolicy,
	removeLocalCapability,
	setLocalCapability,
	writeLocalPolicy,
} from '../src/execution-context/fs-access.js'
import {
	MachineCapabilityError,
	parseMachineCommandDefinition,
	parseMachineLanDefinition,
	resolveMachineCommand,
	advertisedMachineCapabilities,
} from '../src/execution-context/machine-capabilities.js'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'

const containerName = '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$'
const kdocker = {
	name: 'kdocker',
	description: 'Inspect and restart containers on the NAS',
	exec: ['node', '/volume1/docker/kody-docker-helper/kdocker.mjs'],
	args: [
		['ps'],
		['logs', { pattern: containerName }],
		['restart', { pattern: containerName }],
		['compose', 'rebuild'],
	],
	background: false,
	timeoutMs: 120000,
}

function refusal(run: () => unknown) {
	try {
		run()
	} catch (error) {
		assert.ok(error instanceof MachineCapabilityError)
		return error
	}
	assert.fail('expected a refusal')
}

test('a named command runs its fixed executable with arguments that match an allowed shape', () => {
	const definition = parseMachineCommandDefinition(kdocker)
	assert.deepEqual(resolveMachineCommand(definition, ['restart', 'plex']), {
		file: 'node',
		args: ['/volume1/docker/kody-docker-helper/kdocker.mjs', 'restart', 'plex'],
		background: false,
		timeoutMs: 120000,
	})
	assert.deepEqual(
		resolveMachineCommand(definition, ['compose', 'rebuild']).args,
		['/volume1/docker/kody-docker-helper/kdocker.mjs', 'compose', 'rebuild'],
	)
})

test('a named command refuses arguments outside its shapes and names what is allowed', () => {
	const definition = parseMachineCommandDefinition(kdocker)
	for (const args of [
		[],
		['rm'],
		['ps', '--all'],
		['restart'],
		['restart', 'plex', 'extra'],
		['restart', 'plex; rm -rf /'],
		['restart', '-f'],
		['restart', 'plex\nps'],
		['compose', 'down'],
		'ps',
		['restart', 5],
	]) {
		const error = refusal(() => resolveMachineCommand(definition, args))
		assert.equal(error.code, 'machine_command_args_refused', String(args))
	}
	assert.match(
		refusal(() => resolveMachineCommand(definition, ['rm'])).message,
		/Allowed: ps \| logs <.*> \| restart <.*> \| compose rebuild/,
	)
})

test('a pattern has to match the whole argument, with or without anchors', () => {
	const definition = parseMachineCommandDefinition({
		...kdocker,
		args: [
			['a', { pattern: '^foo|bar$' }],
			['b', { pattern: '[a-z]+' }],
			['c', { pattern: '^[a-z]+\\\\$' }],
		],
	})
	for (const args of [
		['a', 'foo'],
		['a', 'bar'],
		['b', 'plex'],
		['c', 'plex\\'],
	]) {
		assert.equal(resolveMachineCommand(definition, args).args.at(-1), args[1])
	}
	for (const args of [
		['a', 'foo --bad'],
		['a', '--bad bar'],
		['b', 'plex --bad'],
		['b', '--bad plex'],
		['c', 'plex'],
	]) {
		assert.equal(
			refusal(() => resolveMachineCommand(definition, args)).code,
			'machine_command_args_refused',
			args.join(' '),
		)
	}
})

test('a command that allows no arguments only runs with none', () => {
	const definition = parseMachineCommandDefinition({
		name: 'uptime',
		exec: ['/usr/bin/uptime'],
		args: [[]],
	})
	assert.deepEqual(resolveMachineCommand(definition, []).args, [])
	assert.equal(definition.timeoutMs, 120000)
	assert.equal(
		refusal(() => resolveMachineCommand(definition, ['-s'])).code,
		'machine_command_args_refused',
	)
})

test('command definitions that could not be enforced are rejected', () => {
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ name: 'Bad Name' }, /"name"/],
		[{ exec: [] }, /"exec"/],
		[{ exec: ['./kdocker.mjs'] }, /relative path/],
		[{ args: [] }, /"args"/],
		[{ args: undefined }, /"args"/],
		[{ args: [['logs', { pattern: '' }]] }, /1 to 200 characters/],
		[
			{ args: [['logs', { pattern: 'foo)|(?:bar' }]] },
			/not a valid regular expression/,
		],
		[
			{ args: [['logs', { pattern: '^[a-z$' }]] },
			/not a valid regular expression/,
		],
		[{ args: [['logs', { glob: '*' }]] }, /exact words or/],
		[{ cwd: 'relative' }, /"cwd"/],
		[{ timeoutMs: 10 }, /"timeoutMs"/],
		[{ background: 'yes' }, /"background"/],
		[{ shell: true }, /unknown field\(s\): shell/],
	]
	for (const [change, message] of cases) {
		const error = refusal(() =>
			parseMachineCommandDefinition({ ...kdocker, ...change }),
		)
		assert.equal(error.code, 'machine_capability_invalid')
		assert.match(error.message, message)
	}
})

test('local network definitions take IP addresses and CIDR ranges only', () => {
	assert.deepEqual(
		parseMachineLanDefinition({
			name: 'nas-admin',
			hosts: ['192.168.1.10', '10.0.0.0/24', 'fd00::/8'],
			ports: [5001, 5000, 5000],
		}),
		{
			name: 'nas-admin',
			description: '',
			hosts: ['192.168.1.10', '10.0.0.0/24', 'fd00::/8'],
			ports: [5000, 5001],
		},
	)
	for (const change of [
		{ hosts: ['nas.local'] },
		{ hosts: ['192.168.1.10/33'] },
		{ hosts: ['192.168.1.10/24/1'] },
		{ hosts: [] },
		{ ports: [] },
		{ ports: [0] },
		{ ports: [70000] },
		{ ports: ['443'] },
	]) {
		assert.equal(
			refusal(() =>
				parseMachineLanDefinition({
					name: 'nas-admin',
					hosts: ['192.168.1.10'],
					ports: [443],
					...change,
				}),
			).code,
			'machine_capability_invalid',
			JSON.stringify(change),
		)
	}
})

test('capability definitions live in the local policy and survive other policy edits', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-machine-capabilities-'))
	const policyPath = join(dir, 'policy.json')
	await writeLocalPolicy(policyPath, {
		version: 1,
		fs: [],
		commands: { enabled: true },
		serviceEnv: { HTTPS_PROXY: 'http://proxy.test:8080' },
	})
	const first = await setLocalCapability({
		kind: 'command',
		definition: parseMachineCommandDefinition(kdocker),
		policyPath,
	})
	assert.equal(first.replaced, false)
	const second = await setLocalCapability({
		kind: 'command',
		definition: parseMachineCommandDefinition({ ...kdocker, args: [['ps']] }),
		policyPath,
	})
	assert.equal(second.replaced, true)
	await allowLocalPath({ path: dir, mode: 'ro', policyPath })
	const policy = await readLocalPolicy(policyPath)
	assert.deepEqual(
		policy.capabilities?.commands.map((entry) => entry.args),
		[[['ps']]],
	)
	assert.deepEqual(policy.serviceEnv, { HTTPS_PROXY: 'http://proxy.test:8080' })
	assert.equal(policy.commands?.enabled, true)
	assert.equal(policy.fs.length, 1)
	assert.equal(
		(
			await removeLocalCapability({
				kind: 'command',
				name: 'kdocker',
				policyPath,
			})
		).removed,
		true,
	)
	assert.deepEqual((await readLocalPolicy(policyPath)).capabilities, undefined)
})

test('a policy file with a broken capability is refused with the reason', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-machine-capabilities-'))
	const policyPath = join(dir, 'policy.json')
	writeFileSync(
		policyPath,
		JSON.stringify({
			version: 1,
			fs: [],
			capabilities: {
				commands: [kdocker, kdocker],
			},
		}),
	)
	await assert.rejects(
		readLocalPolicy(policyPath),
		/invalid "capabilities" entry: More than one command is named "kdocker"/,
	)
})

test('kody context capability adds, lists and removes definitions on this machine', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kody-machine-capabilities-'))
	const previous = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		HOME: process.env.HOME,
		APPDATA: process.env.APPDATA,
	}
	process.env.XDG_CONFIG_HOME = join(root, 'xdg')
	process.env.HOME = join(root, 'home')
	process.env.APPDATA = join(root, 'appdata')
	try {
		const run = async (positionals: Array<string>, json = false) => {
			let text = ''
			const code = await runExecutionContextCommand({
				command: 'context',
				positionals: ['capability', ...positionals],
				values: { json },
				apiUrl: 'https://api.kody.test',
				token: async () => 'unused',
				clientVersion: '0.0.0',
				write: (chunk) => {
					text += chunk
				},
			})
			return { code, text }
		}
		assert.match((await run([])).text, /defines no named commands/)
		const commandFile = join(root, 'kdocker.json')
		writeFileSync(commandFile, JSON.stringify(kdocker))
		const added = await run(['add', 'command', commandFile])
		assert.equal(added.code, 0)
		assert.match(added.text, /Added command "kdocker"/)
		assert.match(added.text, /allows compose rebuild/)
		const lanFile = join(root, 'lan.json')
		writeFileSync(
			lanFile,
			JSON.stringify({
				name: 'nas-admin',
				hosts: ['192.168.1.10'],
				ports: [5000],
			}),
		)
		assert.match(
			(await run(['add', 'lan', lanFile])).text,
			/lan nas-admin \(192\.168\.1\.10 ports 5000\)/,
		)
		const listed = JSON.parse((await run(['list'], true)).text)
		assert.deepEqual(
			[
				listed.capabilities.commands.map(
					(entry: { name: string }) => entry.name,
				),
				listed.capabilities.lan.map((entry: { name: string }) => entry.name),
			],
			[['kdocker'], ['nas-admin']],
		)
		assert.match(readFileSync(listed.path, 'utf8'), /kdocker\.mjs/)
		writeFileSync(commandFile, JSON.stringify({ ...kdocker, exec: ['./x'] }))
		await assert.rejects(run(['add', 'command', commandFile]), /relative path/)
		assert.equal((await run(['remove', 'command', 'kdocker'])).code, 0)
		assert.equal((await run(['remove', 'command', 'kdocker'])).code, 1)
		await assert.rejects(
			run(['add', 'shell', commandFile]),
			/Usage: kody context capability/,
		)
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})

test('the machine tells Kody names and argument shapes, never executable paths, signed with its key', async () => {
	const capabilities = advertisedMachineCapabilities({
		commands: [
			parseMachineCommandDefinition({ ...kdocker, cwd: '/volume1/docker' }),
		],
		lan: [
			parseMachineLanDefinition({
				name: 'nas-admin',
				hosts: ['192.168.1.10'],
				ports: [5001],
			}),
		],
	})
	assert.deepEqual(
		capabilities.map((entry) => [entry.kind, entry.name]),
		[
			['command', 'kdocker'],
			['lan', 'nas-admin'],
		],
	)
	assert.deepEqual(Object.keys(capabilities[0]!.summary).sort(), [
		'args',
		'background',
		'timeoutMs',
	])
	assert.doesNotMatch(JSON.stringify(capabilities), /volume1|kdocker\.mjs/)

	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	const seen: Array<{ request: Request; body: string }> = []
	const result = await syncContextCapabilities({
		apiUrl: 'https://api.kody.test',
		ecid: 'ec_test',
		privateKey: await importContextKey(privateKeyJwk),
		capabilities,
		fetchFn: (async (
			resource: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			const request = new Request(resource, init)
			seen.push({ request, body: await request.clone().text() })
			return Response.json({
				id: 'ec_test',
				name: 'family-vault',
				capabilities: [],
				changes: { added: ['command:kdocker'], changed: [], removed: [] },
			})
		}) as typeof fetch,
	})
	assert.deepEqual(result.changes?.added, ['command:kdocker'])
	const [{ request, body }] = seen as [{ request: Request; body: string }]
	assert.deepEqual(JSON.parse(body), { capabilities })
	const signature = parseEcpSignatureHeader(
		request.headers.get(ecpSignatureHeader),
	)
	assert.equal(
		await verifyEcpHttpSignature({
			signature: signature!,
			method: 'POST',
			pathAndQuery: '/v1/execution-contexts/capabilities',
			body,
			publicKey: await importEd25519PublicKey(publicKeyJwk),
		}),
		'ok',
	)
})
