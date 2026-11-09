import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cliFlagNames, resolveCommand, runCli } from '../src/cli.ts'
import { commandHelpTree, type CommandHelpNode } from '../src/command-help.ts'

const topLevelBanner = /Install Kody as a remote MCP server/

function walk(
	nodes: Array<CommandHelpNode>,
	parent: Array<string> = [],
): Array<{ node: CommandHelpNode; path: Array<string> }> {
	return nodes.flatMap((node) => {
		const path = [...parent, node.name]
		return [{ node, path }, ...walk(node.subcommands ?? [], path)]
	})
}

async function capture(argv: Array<string>) {
	let stdout = ''
	let stderr = ''
	const code = await runCli(argv, {
		stdout: (text) => {
			stdout += text
		},
		stderr: (text) => {
			stderr += text
		},
	})
	return { code, stdout, stderr }
}

function section(text: string, title: string): Array<string> {
	const match = new RegExp(`^${title}:\\n((?:  .*\\n?)+)`, 'm').exec(text)
	return match?.[1]?.trimEnd().split('\n') ?? []
}

const commands = walk(commandHelpTree)

test('every command and nested subcommand prints help scoped to it', async () => {
	assert.ok(commands.length > 40, 'the walk reaches nested commands')
	for (const { node, path } of commands) {
		const full = `kody ${path.join(' ')}`
		for (const argv of [
			[...path, '--help'],
			[...path, '-h'],
			['help', ...path],
		]) {
			const { code, stdout, stderr } = await capture(argv)
			const label = argv.join(' ')
			assert.equal(code, 0, `${label} exits 0`)
			assert.equal(stderr, '', `${label} writes nothing to stderr`)
			assert.doesNotMatch(
				stdout,
				topLevelBanner,
				`${label} is not top-level help`,
			)
			assert.ok(
				stdout.startsWith(`${full}: ${node.summary}`),
				`${label} names ${full}`,
			)

			const usage = section(stdout, 'Usage')
			assert.ok(usage.length > 0, `${label} has usage`)
			for (const line of usage) {
				assert.ok(
					line.startsWith(`  ${full}`) || /^ {3,}\S/.test(line),
					`${label} usage line is for ${full}: ${line}`,
				)
			}

			const commandRows = section(stdout, 'Commands').filter((row) =>
				/^ {2}\S/.test(row),
			)
			assert.deepEqual(
				commandRows.map((row) => row.trim().split(/\s+/)[0]),
				(node.subcommands ?? []).map((sub) => sub.name),
				`${label} lists exactly its own subcommands`,
			)

			const flagRows = section(stdout, 'Flags')
				.filter((row) => /^ {2}-/.test(row))
				.flatMap((row) =>
					row
						.trim()
						.split(/\s{2,}/)[0]!
						.split(', '),
				)
				.map((flag) => flag.split(' ')[0]!.replace(/^-+/, ''))
				.filter(Boolean)
			assert.ok(flagRows.includes('help'), `${label} lists --help`)
			for (const flag of flagRows) {
				if (flag === 'h') continue
				assert.ok(
					cliFlagNames.includes(flag),
					`${label} flag --${flag} is a real CLI flag`,
				)
			}
			const usageFlags = new Set(
				usage
					.join(' ')
					.match(/--[a-z][a-z-]*/g)
					?.map((flag) => flag.slice(2)) ?? [],
			)
			for (const flag of usageFlags) {
				assert.ok(
					flagRows.includes(flag),
					`${label} explains --${flag} from its usage`,
				)
			}
		}
	}
})

test('help after positionals still finds the deepest command', async () => {
	const { stdout } = await capture(['daemon', 'stop', 'extra', '--help'])
	assert.ok(stdout.startsWith('kody daemon stop: '))
	const { stdout: fetchHelp } = await capture([
		'dev',
		'fetch',
		'/api/x',
		'--help',
	])
	assert.ok(fetchHelp.startsWith('kody dev fetch: '))
})

test('top-level help stays the full usage', async () => {
	for (const argv of [['--help'], ['help'], []]) {
		const { stdout } = await capture(argv)
		assert.match(stdout, topLevelBanner)
	}
})

test('the help tree covers exactly the commands the CLI dispatches', () => {
	for (const node of commandHelpTree) {
		assert.equal(resolveCommand([node.name]).command, node.name)
	}
	assert.throws(() => resolveCommand(['not-a-command']), /Unknown command/)
})
