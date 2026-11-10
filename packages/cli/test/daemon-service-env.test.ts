import assert from 'node:assert/strict'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { mock, test } from 'node:test'

const configHome = mkdtempSync(join(tmpdir(), 'kody-daemon-env-'))
mock.method(os, 'homedir', () => configHome)
syncBuiltinESMExports()
process.env.XDG_CONFIG_HOME = configHome
process.env.APPDATA = configHome
delete process.env.KODY_CONTEXT_KEY_PASSPHRASE

const { generateContextKey } =
	await import('../src/execution-context/client.js')
const keystore = await import('../src/execution-context/keystore.js')
const service = await import('../src/execution-context/service.js')
const serviceCommands =
	await import('../src/execution-context/service-commands.js')
const serviceEnv = await import('../src/execution-context/service-env.js')
const { localPolicyPath, readLocalPolicy } =
	await import('../src/execution-context/fs-access.js')

const apiUrl = 'https://api.kody.test'
const entry = join(configHome, 'cli', 'dist', 'bin.js')
mkdirSync(join(configHome, 'cli', 'dist'), { recursive: true })
writeFileSync(entry, '')
const program = { node: process.execPath, entry, version: '1.2.3' }

function unitInput(
	manager: 'systemd' | 'launchd' | 'taskscheduler',
	extraEnv?: Record<string, string>,
) {
	return {
		ecid: 'ec_env',
		contextName: 'Build box',
		apiUrl,
		program,
		paths: service.servicePaths({ apiUrl, ecid: 'ec_env', manager }),
		platform:
			manager === 'systemd'
				? 'linux'
				: manager === 'launchd'
					? 'darwin'
					: 'win32',
		...(extraEnv ? { extraEnv, managedEnvKeys: Object.keys(extraEnv) } : {}),
	} as const
}

async function storeContext(ecid: string) {
	const { publicKeyJwk, privateKeyJwk } = await generateContextKey()
	await keystore.saveContext({
		context: {
			version: 1,
			ecid,
			name: 'Build box',
			apiUrl,
			orgSlug: null,
			publicKeyJwk,
		},
		privateJwk: privateKeyJwk,
		wrapping: keystore.fileWrappingKey({ apiUrl, ecid, create: true }),
	})
}

function fakeSystemd() {
	const state = { active: false, enabled: false }
	const calls: Array<Array<string>> = []
	const run: import('../src/execution-context/service.js').CommandRunner = (
		command,
		args,
	) => {
		calls.push([command, ...args])
		if (command === 'loginctl') return { ok: true, stdout: 'yes\n', stderr: '' }
		if (args[1] === 'show') {
			return {
				ok: true,
				stdout: `ActiveState=${state.active ? 'active' : 'inactive'}\nUnitFileState=${state.enabled ? 'enabled' : 'disabled'}\nMainPID=${state.active ? 4242 : 0}\n`,
				stderr: '',
			}
		}
		if (args[1] === 'is-active')
			return { ok: state.active, stdout: '', stderr: '' }
		if (args[1] === 'start' || args[1] === 'restart') state.active = true
		if (args[1] === 'enable') state.enabled = true
		return { ok: true, stdout: '', stderr: '' }
	}
	return { run, calls }
}

function commandEnv(
	run: import('../src/execution-context/service.js').CommandRunner,
) {
	const lines: Array<string> = []
	return {
		lines,
		env: {
			apiUrl,
			clientVersion: '1.2.3',
			write: (text: string) => lines.push(text),
			platform: 'linux' as const,
			isRoot: false,
			entryPath: entry,
			tmpDir: null,
			run,
			startupWaitMs: 0,
		},
	}
}

test('KEY=VALUE parsing refuses bad names, kody-owned names, and line breaks', () => {
	assert.deepEqual(
		serviceEnv.parseServiceEnvAssignment('NODE_OPTIONS=--use-system-ca'),
		{ key: 'NODE_OPTIONS', value: '--use-system-ca' },
	)
	assert.deepEqual(serviceEnv.parseServiceEnvAssignment('A=b=c'), {
		key: 'A',
		value: 'b=c',
	})
	assert.throws(
		() => serviceEnv.parseServiceEnvAssignment('NOVALUE'),
		/KEY=VALUE/,
	)
	assert.throws(
		() => serviceEnv.parseServiceEnvAssignment('1A=x'),
		/valid variable name/,
	)
	for (const key of ['PATH', 'KODY_DAEMON_SERVICE', 'XDG_CONFIG_HOME']) {
		assert.throws(
			() => serviceEnv.parseServiceEnvAssignment(`${key}=x`),
			/set by kody/,
		)
	}
	assert.throws(
		() => serviceEnv.parseServiceEnvAssignment('A=x\ny'),
		/line breaks/,
	)
	assert.equal(serviceEnv.looksSecret('GITHUB_TOKEN'), true)
	assert.equal(serviceEnv.looksSecret('NODE_OPTIONS'), false)
})

test('install --env and env set persist in the CLI config; unset removes them', async () => {
	const policyPath = localPolicyPath()
	assert.deepEqual(
		await serviceEnv.saveServiceEnvAssignments([
			'NODE_OPTIONS=--use-system-ca',
			'NODE_EXTRA_CA_CERTS=/etc/ssl/corp.pem',
		]),
		['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'],
	)
	assert.deepEqual((await readLocalPolicy(policyPath)).serviceEnv, {
		NODE_OPTIONS: '--use-system-ca',
		NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
	})
	assert.deepEqual(serviceEnv.readServiceEnvSync(policyPath), {
		NODE_OPTIONS: '--use-system-ca',
		NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
	})
	await serviceEnv.updateServiceEnv({
		unset: ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'],
	})
	assert.equal((await readLocalPolicy(policyPath)).serviceEnv, undefined)
})

for (const manager of ['systemd', 'launchd', 'taskscheduler'] as const) {
	test(`${manager}: the service file carries configured env and the outdated check ignores it`, () => {
		const extraEnv = {
			NODE_OPTIONS: '--use-system-ca',
			NODE_EXTRA_CA_CERTS: '/Users/k/corp\'s "ca" & 100%.pem',
		}
		const plain = service.unitFor(unitInput(manager))
		const unit = service.unitFor(unitInput(manager, extraEnv))
		const parsed = serviceEnv.envInUnit(unit)
		assert.equal(parsed.NODE_OPTIONS, extraEnv.NODE_OPTIONS)
		assert.equal(parsed.NODE_EXTRA_CA_CERTS, extraEnv.NODE_EXTRA_CA_CERTS)
		assert.equal(parsed.KODY_DAEMON_SERVICE, manager)
		const keys = Object.keys(extraEnv)
		assert.equal(
			serviceEnv.unitWithoutEnv(unit, keys),
			serviceEnv.unitWithoutEnv(plain, keys),
		)
		// A hand-added key is kept on regeneration, never stripped.
		const plan = serviceEnv.serviceEnvPlan({
			existing: unit,
			configured: { NODE_OPTIONS: '--use-system-ca' },
		})
		assert.deepEqual(plan.handAdded, [])
		assert.equal(plan.extraEnv.NODE_EXTRA_CA_CERTS, undefined)
		const handEdited = service.unitFor({
			...unitInput(manager),
			extraEnv: { HTTPS_PROXY: 'http://proxy.corp:3128' },
		})
		const handPlan = serviceEnv.serviceEnvPlan({
			existing: handEdited,
			configured: {},
		})
		assert.deepEqual(handPlan.handAdded, ['HTTPS_PROXY'])
		assert.equal(handPlan.extraEnv.HTTPS_PROXY, 'http://proxy.corp:3128')
		assert.match(
			serviceEnv.handAddedWarning(handPlan.handAdded),
			/Kept HTTPS_PROXY.*kody daemon env set/,
		)
		assert.doesNotMatch(
			serviceEnv.handAddedWarning(handPlan.handAdded),
			/proxy\.corp/,
		)
	})
}

test('install, env set, status and reinstall keep configured and hand-added keys without flagging unit-outdated', async () => {
	const ecid = 'ec_envinstall'
	await storeContext(ecid)
	const systemd = fakeSystemd()
	const { env, lines } = commandEnv(systemd.run)
	await serviceEnv.saveServiceEnvAssignments(['NODE_OPTIONS=--use-system-ca'])
	await serviceCommands.installDaemonService(env, { ecid })
	const paths = service.servicePaths({ apiUrl, ecid, manager: 'systemd' })
	const installed = readFileSync(paths.unitPath, 'utf8')
	assert.match(installed, /^Environment="NODE_OPTIONS=--use-system-ca"$/m)

	// Someone adds a key by hand: status warns, but does not call it outdated.
	writeFileSync(
		paths.unitPath,
		installed.replace(
			/^(Environment="NODE_OPTIONS=.*)$/m,
			'$1\nEnvironment="HTTPS_PROXY=http://proxy.corp:3128"',
		),
	)
	lines.length = 0
	const status = service.serviceStatus({
		apiUrl,
		ecid,
		cliVersion: '1.2.3',
		expectedUnit: service.unitFor({
			...unitInput('systemd'),
			ecid,
			paths,
		}),
		ignoreEnvKeys: ['NODE_OPTIONS', 'HTTPS_PROXY'],
		keyWrap: 'file',
		run: systemd.run,
		platform: 'linux',
		isRoot: false,
		tmpDir: null,
	})
	assert.ok(!status.problems.some((p) => p.code === 'unit-outdated'))
	await serviceCommands.runDaemonServiceCommand(env, {
		sub: 'status',
		context: ecid,
		revoke: async () => {},
	})
	assert.match(lines.join(''), /Kept HTTPS_PROXY/)
	assert.doesNotMatch(lines.join(''), /unit-outdated|proxy\.corp/)

	// Reinstall (also what an upgrade runs) keeps both keys.
	lines.length = 0
	await serviceCommands.installDaemonService(env, { ecid })
	const reinstalled = readFileSync(paths.unitPath, 'utf8')
	assert.match(reinstalled, /^Environment="NODE_OPTIONS=--use-system-ca"$/m)
	assert.match(
		reinstalled,
		/^Environment="HTTPS_PROXY=http:\/\/proxy\.corp:3128"$/m,
	)
	assert.match(lines.join(''), /Kept HTTPS_PROXY/)

	// env set rewrites the installed unit and restarts it; unset removes only its key.
	systemd.calls.length = 0
	lines.length = 0
	await serviceCommands.runDaemonEnvCommand(env, {
		action: 'set',
		args: ['NODE_EXTRA_CA_CERTS=/etc/ssl/corp.pem', 'GITHUB_TOKEN=x'],
		context: ecid,
	})
	assert.match(
		lines.join(''),
		/GITHUB_TOKEN looks like a secret.*Kody credentials/,
	)
	assert.match(lines.join(''), /restarted the daemon/)
	assert.ok(systemd.calls.some((c) => c[2] === 'restart' || c[2] === 'start'))
	assert.match(
		readFileSync(paths.unitPath, 'utf8'),
		/^Environment="NODE_EXTRA_CA_CERTS=\/etc\/ssl\/corp\.pem"$/m,
	)
	await serviceCommands.runDaemonEnvCommand(env, {
		action: 'unset',
		args: ['NODE_EXTRA_CA_CERTS', 'GITHUB_TOKEN'],
		context: ecid,
	})
	const after = readFileSync(paths.unitPath, 'utf8')
	assert.doesNotMatch(after, /NODE_EXTRA_CA_CERTS|GITHUB_TOKEN/)
	assert.match(after, /NODE_OPTIONS=--use-system-ca/)
	assert.match(after, /HTTPS_PROXY=/)

	lines.length = 0
	await serviceCommands.runDaemonEnvCommand(env, { action: 'list', args: [] })
	assert.equal(lines.join(''), 'NODE_OPTIONS=--use-system-ca\n')
	assert.ok(existsSync(localPolicyPath()))
})
