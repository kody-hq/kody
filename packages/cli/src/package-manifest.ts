/**
 * Read and validate the authored package.json `kody` surface used by `kody dev`.
 */

import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	formatPackageJobScheduleSummary,
	parsePackageJobSchedule,
} from '@kody-internal/shared/jobs/package-job-schedule.ts'
import { StructuredCliError } from './structured-error.js'

/** Mirrors `@kody-internal/shared/jobs/package-job-schedule` (kept local so published CLI `.d.ts` does not reference the private package). */
export type PackageJobSchedule =
	| {
			type: 'cron'
			expression: string
	  }
	| {
			type: 'interval'
			every: string
	  }

export type PackageAppManifest = {
	entry: string
	/** Browser entry (string form, or `entry` of the object form). */
	client?: string
	/** `client.externals` from the object form; left as bare imports for an import map. */
	clientExternals?: Array<string>
	assets?: string
}

/** Local-only `kody dev` settings (`package.json#kody.dev`); never published behavior. */
export type PackageDevManifest = {
	/** Shell command run from the package root before every `kody dev` build. */
	prebuild?: string
	/** Root-relative path prefixes the watcher ignores (e.g. prebuild outputs). */
	ignore: Array<string>
}

export type PackageJobManifest = {
	entry: string
	/** Normalized for display / check output. */
	schedule: string
	/** Canonical schedule shape (same as production publish). */
	scheduleRaw: PackageJobSchedule
	timezone?: string
	enabled?: boolean
}

export type PackageWebhookManifest = {
	export: string
	description?: string
	inputMode?: 'request' | 'params'
}

export type PackageSubscriptionManifest = {
	handler: string
	description?: string
	filters?: unknown
}

export type KodyPackageManifest = {
	/** Absolute path to package.json */
	packageJsonPath: string
	/** Package root directory */
	root: string
	name: string
	kodyId: string
	description?: string
	exports: Record<string, string>
	app?: PackageAppManifest
	dev: PackageDevManifest
	jobs: Record<string, PackageJobManifest>
	webhooks: Record<string, PackageWebhookManifest>
	subscriptions: Record<string, PackageSubscriptionManifest>
}

export async function loadPackageManifest(
	cwd: string = process.cwd(),
): Promise<KodyPackageManifest> {
	const packageJsonPath = await findPackageJson(cwd)
	// Match bundler and watcher paths when the working directory is a symlink.
	const root = await realpath(dirname(packageJsonPath))
	let raw: unknown
	try {
		raw = JSON.parse(await readFile(packageJsonPath, 'utf8'))
	} catch (error) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: `Could not read package.json at ${packageJsonPath}.`,
			where: packageJsonPath,
			fix: 'Run `kody dev` from a package directory with a valid package.json.',
			details: {
				cause: error instanceof Error ? error.message : String(error),
			},
		})
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'package.json must be a JSON object.',
			where: packageJsonPath,
		})
	}
	const pkg = raw as Record<string, unknown>
	const name = typeof pkg.name === 'string' ? pkg.name : ''
	const kody = asRecord(pkg.kody) ?? {}
	const kodyId =
		typeof kody.id === 'string' && kody.id.trim()
			? kody.id.trim()
			: name.includes('/')
				? name.slice(name.lastIndexOf('/') + 1)
				: name || 'local-package'

	const exportsField = normalizeExports(pkg.exports)
	const app = parseApp(kody.app, packageJsonPath)
	const dev = parseDev(kody.dev, packageJsonPath)
	const jobs = parseJobs(kody.jobs, packageJsonPath)
	const webhooks = parseWebhooks(kody.webhooks, packageJsonPath)
	const subscriptions = parseSubscriptions(kody.subscriptions, packageJsonPath)

	return {
		packageJsonPath,
		root,
		name: name || `@local/${kodyId}`,
		kodyId,
		description:
			typeof kody.description === 'string' ? kody.description : undefined,
		exports: exportsField,
		app,
		dev,
		jobs,
		webhooks,
		subscriptions,
	}
}

async function findPackageJson(start: string): Promise<string> {
	let dir = resolve(start)
	for (;;) {
		const candidate = join(dir, 'package.json')
		try {
			await readFile(candidate)
			return candidate
		} catch {
			const parent = dirname(dir)
			if (parent === dir) {
				throw new StructuredCliError({
					code: 'package_manifest_invalid',
					message: `No package.json found from ${start}.`,
					fix: 'cd into a Kody package directory (one with package.json and a kody block).',
				})
			}
			dir = parent
		}
	}
}

function normalizeExports(exportsField: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (typeof exportsField === 'string') {
		out['.'] = exportsField
		return out
	}
	if (
		!exportsField ||
		typeof exportsField !== 'object' ||
		Array.isArray(exportsField)
	) {
		return out
	}
	for (const [key, value] of Object.entries(
		exportsField as Record<string, unknown>,
	)) {
		if (typeof value === 'string') {
			out[key] = value
			continue
		}
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const cond = value as Record<string, unknown>
			const pick =
				(typeof cond.default === 'string' && cond.default) ||
				(typeof cond.import === 'string' && cond.import) ||
				(typeof cond.require === 'string' && cond.require)
			if (pick) out[key] = pick
		}
	}
	return out
}

function parseApp(raw: unknown, where: string): PackageAppManifest | undefined {
	if (raw === undefined || raw === null) return undefined
	const record = asRecord(raw)
	if (!record || typeof record.entry !== 'string' || !record.entry.trim()) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.app.entry must be a non-empty string path.',
			where,
			fix: 'Set `"kody": { "app": { "entry": "./app/router.ts" } }` in package.json.',
		})
	}
	let client: string | undefined
	let clientExternals: Array<string> | undefined
	if (record.client !== undefined && record.client !== null) {
		if (typeof record.client === 'string') {
			if (!record.client.trim()) {
				throw new StructuredCliError({
					code: 'package_manifest_invalid',
					message:
						'kody.app.client must be a non-empty string path or { entry, externals? }.',
					where,
					fix: 'Set `"client": "./app/client.ts"` or `"client": { "entry": "./app/client.ts" }`.',
				})
			}
			client = record.client
		} else {
			const clientRecord = asRecord(record.client)
			if (
				!clientRecord ||
				typeof clientRecord.entry !== 'string' ||
				!clientRecord.entry.trim()
			) {
				throw new StructuredCliError({
					code: 'package_manifest_invalid',
					message: 'kody.app.client.entry must be a non-empty string path.',
					where,
					fix: 'Set `"client": { "entry": "./app/client.ts", "externals": ["preact"] }`.',
				})
			}
			client = clientRecord.entry
			clientExternals = Array.isArray(clientRecord.externals)
				? clientRecord.externals.filter(
						(item): item is string => typeof item === 'string',
					)
				: undefined
		}
	}
	return {
		entry: record.entry,
		client,
		...(clientExternals?.length ? { clientExternals } : {}),
		assets: typeof record.assets === 'string' ? record.assets : undefined,
	}
}

function parseDev(raw: unknown, where: string): PackageDevManifest {
	if (raw === undefined || raw === null) return { ignore: [] }
	const record = asRecord(raw)
	if (!record) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.dev must be an object.',
			where,
			fix: 'Use `"kody": { "dev": { "prebuild": "node scripts/build-assets.mjs", "ignore": ["public/generated"] } }`.',
		})
	}
	if (
		record.prebuild !== undefined &&
		(typeof record.prebuild !== 'string' || !record.prebuild.trim())
	) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.dev.prebuild must be a non-empty shell command string.',
			where,
		})
	}
	if (
		record.ignore !== undefined &&
		(!Array.isArray(record.ignore) ||
			!record.ignore.every((item) => typeof item === 'string'))
	) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message:
				'kody.dev.ignore must be an array of root-relative path prefixes.',
			where,
		})
	}
	return {
		...(typeof record.prebuild === 'string'
			? { prebuild: record.prebuild.trim() }
			: {}),
		ignore: (record.ignore as Array<string> | undefined) ?? [],
	}
}

function parseJobs(
	raw: unknown,
	where: string,
): Record<string, PackageJobManifest> {
	if (raw === undefined || raw === null) return {}
	const record = asRecord(raw)
	if (!record) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.jobs must be an object.',
			where,
		})
	}
	const out: Record<string, PackageJobManifest> = {}
	for (const [name, value] of Object.entries(record)) {
		const job = asRecord(value)
		if (!job || typeof job.entry !== 'string' || !job.entry.trim()) {
			throw new StructuredCliError({
				code: 'package_manifest_invalid',
				message: `kody.jobs.${name} requires a non-empty entry string.`,
				where,
				fix: 'Set `"entry": "./jobs/hourly.ts"` and a schedule `{ "type": "cron", "expression": "…" }` or `{ "type": "interval", "every": "15m" }`.',
			})
		}
		const schedule = parseJobSchedule(job.schedule, name, where)
		out[name] = {
			entry: job.entry,
			schedule: schedule.normalized,
			scheduleRaw: schedule.raw,
			timezone: typeof job.timezone === 'string' ? job.timezone : undefined,
			enabled: typeof job.enabled === 'boolean' ? job.enabled : undefined,
		}
	}
	return out
}

/**
 * Same accept/reject set as production publish (`packageJobScheduleSchema`).
 */
function parseJobSchedule(
	raw: unknown,
	jobName: string,
	where: string,
): { normalized: string; raw: PackageJobSchedule } {
	const parsed = parsePackageJobSchedule(raw)
	if (!parsed.ok) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: `kody.jobs.${jobName}: ${parsed.message}`,
			where,
			fix: 'Use `"schedule": { "type": "cron", "expression": "0 * * * *" }` or `"schedule": { "type": "interval", "every": "15m" }` (same as production).',
		})
	}
	return {
		normalized: formatPackageJobScheduleSummary(parsed.schedule),
		raw: parsed.schedule,
	}
}

function parseWebhooks(
	raw: unknown,
	where: string,
): Record<string, PackageWebhookManifest> {
	if (raw === undefined || raw === null) return {}
	if (Array.isArray(raw)) {
		const out: Record<string, PackageWebhookManifest> = {}
		for (const item of raw) {
			const webhook = asRecord(item)
			if (
				!webhook ||
				typeof webhook.name !== 'string' ||
				typeof webhook.export !== 'string'
			) {
				throw new StructuredCliError({
					code: 'package_manifest_invalid',
					message: 'Each kody.webhooks[] entry needs name and export.',
					where,
				})
			}
			out[webhook.name] = {
				export: webhook.export,
				description:
					typeof webhook.description === 'string'
						? webhook.description
						: undefined,
				inputMode: webhook.inputMode === 'params' ? 'params' : 'request',
			}
		}
		return out
	}
	const record = asRecord(raw)
	if (!record) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.webhooks must be an object or array.',
			where,
		})
	}
	const out: Record<string, PackageWebhookManifest> = {}
	for (const [name, value] of Object.entries(record)) {
		const webhook = asRecord(value)
		if (!webhook || typeof webhook.export !== 'string') {
			throw new StructuredCliError({
				code: 'package_manifest_invalid',
				message: `kody.webhooks.${name} requires an export string.`,
				where,
			})
		}
		out[name] = {
			export: webhook.export,
			description:
				typeof webhook.description === 'string'
					? webhook.description
					: undefined,
			inputMode: webhook.inputMode === 'params' ? 'params' : 'request',
		}
	}
	return out
}

function parseSubscriptions(
	raw: unknown,
	where: string,
): Record<string, PackageSubscriptionManifest> {
	if (raw === undefined || raw === null) return {}
	const record = asRecord(raw)
	if (!record) {
		throw new StructuredCliError({
			code: 'package_manifest_invalid',
			message: 'kody.subscriptions must be an object keyed by event topic.',
			where,
		})
	}
	const out: Record<string, PackageSubscriptionManifest> = {}
	for (const [topic, value] of Object.entries(record)) {
		const sub = asRecord(value)
		if (!sub || typeof sub.handler !== 'string') {
			throw new StructuredCliError({
				code: 'package_manifest_invalid',
				message: `kody.subscriptions[${JSON.stringify(topic)}] requires a handler path.`,
				where,
			})
		}
		out[topic] = {
			handler: sub.handler,
			description:
				typeof sub.description === 'string' ? sub.description : undefined,
			filters: sub.filters,
		}
	}
	return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return null
	return value as Record<string, unknown>
}

/** Resolve a package-relative path against the package root. */
export function resolvePackagePath(
	manifest: KodyPackageManifest,
	relativePath: string,
): string {
	return resolve(manifest.root, relativePath)
}

/** Resolve an export key (`.` / `./foo`) or filesystem-ish ref to an absolute module path. */
export function resolveExportModulePath(
	manifest: KodyPackageManifest,
	exportRef: string,
	options: { exportsOnly?: boolean } = {},
): string {
	const trimmed = exportRef.trim()
	if (!trimmed) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: 'Export reference is empty.',
			fix: 'Pass an export key from package.json#exports (e.g. `.` or `./on-user-deleted`).',
		})
	}
	if (trimmed in manifest.exports) {
		return resolvePackagePath(manifest, manifest.exports[trimmed]!)
	}
	const withDot = trimmed.startsWith('./') ? trimmed : `./${trimmed}`
	if (withDot in manifest.exports) {
		return resolvePackagePath(manifest, manifest.exports[withDot]!)
	}
	// Bare path into the package (webhooks / jobs may pass relative files).
	// --invoke uses exportsOnly so unknown keys list known exports instead of ENOENT.
	if (
		!options.exportsOnly &&
		(trimmed.startsWith('.') || trimmed.startsWith('/'))
	) {
		return resolvePackagePath(manifest, trimmed)
	}
	throw new StructuredCliError({
		code: 'dev_surface_missing',
		message: `No package export ${JSON.stringify(trimmed)}.`,
		where: manifest.packageJsonPath,
		fix: `Known exports: ${Object.keys(manifest.exports).join(', ') || '(none)'}.`,
	})
}
