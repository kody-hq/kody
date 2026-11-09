import { readFileSync } from 'node:fs'
import {
	localPolicyPath,
	readLocalPolicy,
	writeLocalPolicy,
	type LocalFsPolicy,
} from './fs-access.js'
import {
	normalizeServiceEnv,
	reservedServiceEnvKeys,
	validateServiceEnvKey,
} from './service-env-keys.js'

const secretLooking = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)/i
const managedMarker = 'kody daemon env:'

export function parseServiceEnvAssignment(text: string) {
	const equals = text.indexOf('=')
	if (equals <= 0) {
		throw new Error(
			`Expected KEY=VALUE, got ${JSON.stringify(text.slice(0, 64))}. Example: kody daemon env set NODE_OPTIONS=--use-system-ca`,
		)
	}
	const key = text.slice(0, equals)
	const value = text.slice(equals + 1)
	validateServiceEnvKey(key)
	if (/[\0\r\n]/.test(value)) {
		throw new Error(`The value for ${key} cannot contain line breaks.`)
	}
	return { key, value }
}

export function looksSecret(key: string) {
	return secretLooking.test(key)
}

/** The configured service environment; unreadable config means none. */
export function readServiceEnvSync(
	path: string = localPolicyPath(),
): Record<string, string> {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			serviceEnv?: unknown
		}
		return normalizeServiceEnv(parsed.serviceEnv) ?? {}
	} catch {
		return {}
	}
}

/** Saves `KEY=VALUE` arguments (`kody daemon env set`, `install --env`). */
export async function saveServiceEnvAssignments(
	args: Array<string>,
	policyPath?: string,
) {
	const set = Object.fromEntries(
		args.map((arg) => {
			const { key, value } = parseServiceEnvAssignment(arg)
			return [key, value]
		}),
	)
	await updateServiceEnv({ set, ...(policyPath ? { policyPath } : {}) })
	return Object.keys(set)
}

export async function updateServiceEnv(input: {
	set?: Record<string, string>
	unset?: Array<string>
	policyPath?: string
}): Promise<LocalFsPolicy> {
	const policyPath = input.policyPath ?? localPolicyPath()
	const current = await readLocalPolicy(policyPath)
	const next = { ...current.serviceEnv, ...input.set }
	for (const key of input.unset ?? []) delete next[key]
	const policy: LocalFsPolicy = { ...current }
	if (Object.keys(next).length > 0) policy.serviceEnv = next
	else delete policy.serviceEnv
	await writeLocalPolicy(policyPath, policy)
	return policy
}

function unxml(value: string) {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
}

/** Variables a service file sets, whoever wrote them. */
export function envInUnit(text: string | null): Record<string, string> {
	if (!text) return {}
	const env: Record<string, string> = {}
	const plist = text.match(
		/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
	)
	if (plist) {
		for (const match of plist[1]!.matchAll(
			/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g,
		)) {
			env[unxml(match[1]!)] = unxml(match[2]!)
		}
		return env
	}
	for (const line of text.split(/\r?\n/)) {
		const systemd = line.match(/^Environment=(.*)$/)
		if (systemd) {
			const raw = systemd[1]!.trim()
			const assignments = raw.startsWith('"')
				? [
						raw
							.slice(1, raw.endsWith('"') ? -1 : undefined)
							.replace(/%%/g, '%')
							.replace(/\\(["\\])/g, '$1'),
					]
				: raw.split(/\s+/)
			for (const assignment of assignments) {
				const equals = assignment.indexOf('=')
				if (equals > 0)
					env[assignment.slice(0, equals)] = assignment.slice(equals + 1)
			}
			continue
		}
		const powershell = line.match(
			/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'(.*)'\s*$/,
		)
		if (powershell) env[powershell[1]!] = powershell[2]!.replace(/''/g, "'")
	}
	return env
}

export function managedEnvComment(keys: Array<string>) {
	return keys.length > 0 ? `${managedMarker} ${keys.join(',')}` : null
}

function managedKeysInUnit(text: string | null) {
	const match = text?.match(/kody daemon env: ([A-Za-z0-9_,]*)/)
	return match ? match[1]!.split(',').filter(Boolean) : []
}

/**
 * The environment the next service file carries: kody's own variables, the
 * ones set with `kody daemon env`, and any a person added by hand (kept, so a
 * reinstall never strips them).
 */
export function serviceEnvPlan(input: {
	existing: string | null
	configured: Record<string, string>
}) {
	const inFile = envInUnit(input.existing)
	const managedBefore = managedKeysInUnit(input.existing)
	const handAdded = Object.keys(inFile).filter(
		(key) =>
			!(reservedServiceEnvKeys as ReadonlyArray<string>).includes(key) &&
			!(key in input.configured) &&
			!managedBefore.includes(key),
	)
	const extraEnv: Record<string, string> = { ...input.configured }
	for (const key of handAdded) extraEnv[key] = inFile[key]!
	return {
		extraEnv,
		managedKeys: Object.keys(input.configured),
		handAdded,
		ignoreKeys: [
			...new Set([
				...Object.keys(input.configured),
				...managedBefore,
				...handAdded,
			]),
		],
	}
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A service file with the given variables and kody's env marker removed. */
export function unitWithoutEnv(text: string, keys: Array<string>) {
	let result = text.replace(/^.*kody daemon env: [A-Za-z0-9_,]*.*\r?\n/m, '')
	for (const key of keys) {
		const name = escapeRegExp(key)
		result = result
			.replace(new RegExp(`^Environment="?${name}=.*\\r?\\n`, 'gm'), '')
			.replace(
				new RegExp(
					`^\\s*<key>${name}</key>\\s*<string>[^<]*</string>\\r?\\n`,
					'gm',
				),
				'',
			)
			.replace(new RegExp(`^\\$env:${name}\\s*=.*\\r?\\n`, 'gm'), '')
	}
	return result
}

export function handAddedWarning(keys: Array<string>) {
	return `Kept ${keys.join(', ')} in the service file: added by hand, not by kody. Move ${keys.length === 1 ? 'it' : 'them'} to \`kody daemon env set KEY=VALUE\` so kody manages ${keys.length === 1 ? 'it' : 'them'}.`
}
