import { BlockList, isIP } from 'node:net'
import { isAbsolute as isRooted } from 'node:path'

/** One argument of an allowed shape: an exact word, or a pattern for one argument. */
export type MachineArgRule = string | { pattern: string }

/**
 * A named command this machine offers: a fixed executable run without a shell.
 * A call must match one of the `args` shapes exactly.
 */
export type MachineCommandDefinition = {
	name: string
	description: string
	exec: Array<string>
	args: Array<Array<MachineArgRule>>
	cwd?: string
	background: boolean
	timeoutMs: number
}

/** A named set of local network destinations: IP literals or CIDR ranges, plus ports. */
export type MachineLanDefinition = {
	name: string
	description: string
	hosts: Array<string>
	ports: Array<number>
}

export type MachineCapabilitiesPolicy = {
	commands: Array<MachineCommandDefinition>
	lan: Array<MachineLanDefinition>
}

const emptyMachineCapabilities: MachineCapabilitiesPolicy = {
	commands: [],
	lan: [],
}

const namePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/
const defaultTimeoutMs = 120_000
const maxTimeoutMs = 3_600_000
const maxArgLength = 4096
const maxPatternLength = 200

export class MachineCapabilityError extends Error {
	readonly code: 'machine_capability_invalid' | 'machine_command_args_refused'
	constructor(code: MachineCapabilityError['code'], message: string) {
		super(message)
		this.name = 'MachineCapabilityError'
		this.code = code
	}
}

function invalid(message: string): never {
	throw new MachineCapabilityError('machine_capability_invalid', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseName(value: unknown, what: string) {
	if (typeof value !== 'string' || !namePattern.test(value)) {
		invalid(
			`${what} needs a "name" of lowercase letters, digits, "-" or "_", starting with a letter or digit (at most 63 characters).`,
		)
	}
	return value
}

function parseDescription(value: unknown, what: string) {
	if (value === undefined) return ''
	if (typeof value !== 'string' || value.length > 500) {
		invalid(`${what} "description" must be text of at most 500 characters.`)
	}
	return value
}

function parseArgRule(rule: unknown, what: string): MachineArgRule {
	if (typeof rule === 'string') {
		if (rule.length > maxArgLength) {
			invalid(`${what} has an argument word that is too long.`)
		}
		return rule
	}
	const pattern = isRecord(rule) ? rule.pattern : undefined
	if (
		!isRecord(rule) ||
		Object.keys(rule).length !== 1 ||
		typeof pattern !== 'string'
	) {
		invalid(
			`${what} "args" entries are lists of exact words or {"pattern": "^...$"}.`,
		)
	}
	if (
		pattern.length > maxPatternLength ||
		!pattern.startsWith('^') ||
		!pattern.endsWith('$') ||
		pattern.endsWith('\\$')
	) {
		invalid(
			`${what} pattern ${JSON.stringify(pattern)} must start with ^ and end with $ (at most ${maxPatternLength} characters), so it matches the whole argument.`,
		)
	}
	try {
		new RegExp(pattern, 'u')
	} catch {
		invalid(
			`${what} pattern ${JSON.stringify(pattern)} is not a valid regular expression.`,
		)
	}
	return { pattern }
}

export function parseMachineCommandDefinition(
	value: unknown,
): MachineCommandDefinition {
	if (!isRecord(value)) invalid('A command definition must be a JSON object.')
	const name = parseName(value.name, 'A command definition')
	const what = `Command "${name}"`
	const exec = value.exec
	if (
		!Array.isArray(exec) ||
		exec.length === 0 ||
		!exec.every(
			(part) =>
				typeof part === 'string' &&
				part.length > 0 &&
				part.length <= maxArgLength,
		)
	) {
		invalid(
			`${what} needs "exec": the executable and its fixed leading arguments, for example ["node", "/path/to/script.mjs"].`,
		)
	}
	const program = exec[0] as string
	if (/[\\/]/.test(program) && !isRooted(program)) {
		invalid(
			`${what} "exec" must start with a program name or an absolute path, not the relative path ${JSON.stringify(program)}.`,
		)
	}
	const args = value.args
	if (
		!Array.isArray(args) ||
		args.length === 0 ||
		!args.every((shape) => Array.isArray(shape))
	) {
		invalid(
			`${what} needs "args": a list of allowed argument shapes, for example [["ps"], ["logs", {"pattern": "^[a-z0-9-]+$"}]]. Use [[]] for a command that takes no arguments.`,
		)
	}
	const cwd = value.cwd
	if (cwd !== undefined && (typeof cwd !== 'string' || !isRooted(cwd))) {
		invalid(`${what} "cwd" must be an absolute path.`)
	}
	const background = value.background ?? false
	if (typeof background !== 'boolean') {
		invalid(`${what} "background" must be true or false.`)
	}
	const timeoutMs = value.timeoutMs ?? defaultTimeoutMs
	if (
		typeof timeoutMs !== 'number' ||
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 1000 ||
		timeoutMs > maxTimeoutMs
	) {
		invalid(
			`${what} "timeoutMs" must be a whole number from 1000 to ${maxTimeoutMs}.`,
		)
	}
	const known = new Set([
		'name',
		'description',
		'exec',
		'args',
		'cwd',
		'background',
		'timeoutMs',
	])
	const unknown = Object.keys(value).filter((key) => !known.has(key))
	if (unknown.length > 0) {
		invalid(`${what} has unknown field(s): ${unknown.join(', ')}.`)
	}
	return {
		name,
		description: parseDescription(value.description, what),
		exec: [...(exec as Array<string>)],
		args: (args as Array<Array<unknown>>).map((shape) =>
			shape.map((rule) => parseArgRule(rule, what)),
		),
		...(typeof cwd === 'string' ? { cwd } : {}),
		background,
		timeoutMs,
	}
}

function isHostRule(host: unknown): host is string {
	if (typeof host !== 'string') return false
	const [address, prefix, ...rest] = host.split('/')
	const family = isIP(address ?? '')
	if (family === 0 || rest.length > 0) return false
	if (prefix === undefined) return true
	if (!/^\d{1,3}$/.test(prefix)) return false
	try {
		new BlockList().addSubnet(
			address as string,
			Number(prefix),
			family === 4 ? 'ipv4' : 'ipv6',
		)
		return true
	} catch {
		return false
	}
}

export function parseMachineLanDefinition(
	value: unknown,
): MachineLanDefinition {
	if (!isRecord(value)) {
		invalid('A local network definition must be a JSON object.')
	}
	const name = parseName(value.name, 'A local network definition')
	const what = `Local network "${name}"`
	const hosts = value.hosts
	if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every(isHostRule)) {
		invalid(
			`${what} needs "hosts": IP addresses or CIDR ranges, for example ["192.168.1.10", "10.0.0.0/24"]. Host names are not supported.`,
		)
	}
	const ports = value.ports
	if (
		!Array.isArray(ports) ||
		ports.length === 0 ||
		!ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
	) {
		invalid(`${what} needs "ports": port numbers from 1 to 65535.`)
	}
	const known = new Set(['name', 'description', 'hosts', 'ports'])
	const unknown = Object.keys(value).filter((key) => !known.has(key))
	if (unknown.length > 0) {
		invalid(`${what} has unknown field(s): ${unknown.join(', ')}.`)
	}
	return {
		name,
		description: parseDescription(value.description, what),
		hosts: [...new Set(hosts as Array<string>)],
		ports: [...new Set(ports as Array<number>)].sort((a, b) => a - b),
	}
}

/** Parses the `capabilities` entry of the local policy file. Absent means none. */
export function parseMachineCapabilities(
	value: unknown,
): MachineCapabilitiesPolicy {
	if (value === undefined) return emptyMachineCapabilities
	if (!isRecord(value)) invalid('"capabilities" must be a JSON object.')
	const list = (key: 'commands' | 'lan') => {
		const entries = value[key] ?? []
		if (!Array.isArray(entries)) {
			invalid(`"capabilities.${key}" must be a list.`)
		}
		return entries as Array<unknown>
	}
	const commands = list('commands').map(parseMachineCommandDefinition)
	const lan = list('lan').map(parseMachineLanDefinition)
	for (const [kind, names] of [
		['command', commands.map((entry) => entry.name)],
		['local network', lan.map((entry) => entry.name)],
	] as const) {
		const duplicate = names.find((name, index) => names.indexOf(name) !== index)
		if (duplicate) invalid(`More than one ${kind} is named "${duplicate}".`)
	}
	return { commands, lan }
}

function describeShape(shape: ReadonlyArray<MachineArgRule>) {
	return shape.length === 0
		? '(no arguments)'
		: shape
				.map((rule) => (typeof rule === 'string' ? rule : `<${rule.pattern}>`))
				.join(' ')
}

/** The allowed argument shapes as text, without the executable or any path. */
export function describeMachineCommandArgs(
	definition: Pick<MachineCommandDefinition, 'args'>,
) {
	return definition.args.map(describeShape)
}

function matchesShape(
	shape: ReadonlyArray<MachineArgRule>,
	args: ReadonlyArray<string>,
) {
	return (
		shape.length === args.length &&
		shape.every((rule, index) => {
			const arg = args[index] as string
			return typeof rule === 'string'
				? rule === arg
				: new RegExp(rule.pattern, 'u').test(arg)
		})
	)
}

/**
 * The `execFile` call for one use of a named command, or a refusal that lists
 * the allowed shapes. Nothing here starts a process.
 */
export function resolveMachineCommand(
	definition: MachineCommandDefinition,
	args: unknown,
) {
	if (
		!Array.isArray(args) ||
		!args.every((arg) => typeof arg === 'string' && arg.length <= maxArgLength)
	) {
		throw new MachineCapabilityError(
			'machine_command_args_refused',
			`Command "${definition.name}" takes a list of text arguments.`,
		)
	}
	if (!definition.args.some((shape) => matchesShape(shape, args))) {
		throw new MachineCapabilityError(
			'machine_command_args_refused',
			`Command "${definition.name}" does not allow these arguments. Allowed: ${describeMachineCommandArgs(definition).join(' | ')}. The machine's owner changes this with \`kody context capability add command <file>\`.`,
		)
	}
	const [file, ...fixed] = definition.exec
	return {
		file: file as string,
		args: [...fixed, ...(args as Array<string>)],
		...(definition.cwd ? { cwd: definition.cwd } : {}),
		background: definition.background,
		timeoutMs: definition.timeoutMs,
	}
}
