import { isExecutedDirectly } from './node-runtime.ts'

export const defaultMaintenanceZone = 'kody.codes'
export const defaultMaintenanceTarget = 'https://status.kody.codes/maintenance'
export const maintenanceRuleMarker = 'kody-maintenance-mode'
const dynamicRedirectPhase = 'http_request_dynamic_redirect'
export const cloudflareApiBaseUrl = 'https://api.cloudflare.com/client/v4'
export const requiredTokenScopesMessage =
	'This token needs Zone:Read and Zone "Single Redirect" / Dynamic Redirect: Edit on the target zone.'

type MaintenanceModeCommand = 'on' | 'off' | 'status'

type MaintenanceModeOptions = {
	command: MaintenanceModeCommand
	zone: string
	target: string
	dryRun: boolean
	json: boolean
}

type PlannedApiRequest = {
	method: 'GET' | 'POST' | 'PATCH'
	url: string
	body?: unknown
}

type MaintenanceModeResult = {
	command: MaintenanceModeCommand
	zone: string
	target: string
	exists: boolean
	enabled: boolean
	dryRun: boolean
	requests: Array<PlannedApiRequest>
	rulesetId?: string
	ruleId?: string
}

type MaintenanceModeDeps = {
	env?: NodeJS.ProcessEnv
	fetch?: typeof fetch
	log?: (line: string) => void
}

type CloudflareApiEnvelope<T> = {
	success?: boolean
	result?: T
	errors?: Array<{ code?: number | string; message?: string }>
}

type CloudflareZone = {
	id: string
	name: string
}

type CloudflareRedirectRule = {
	id?: string
	ref?: string
	description?: string
	enabled?: boolean
	expression?: string
	action?: string
	action_parameters?: {
		from_value?: {
			target_url?: { value?: string; expression?: string }
			status_code?: number
			preserve_query_string?: boolean
		}
	}
}

type CloudflareRuleset = {
	id: string
	name?: string
	kind?: string
	phase?: string
	rules?: Array<CloudflareRedirectRule>
}

function readFlagValue(
	argv: ReadonlyArray<string>,
	index: number,
	flag: string,
) {
	const value = argv[index + 1]
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing value for ${flag}.`)
	}
	return value
}

function isMaintenanceModeCommand(
	value: string,
): value is MaintenanceModeCommand {
	return value === 'on' || value === 'off' || value === 'status'
}

export function parseArgs(argv: ReadonlyArray<string>): MaintenanceModeOptions {
	let command: MaintenanceModeCommand | null = null
	let zone = defaultMaintenanceZone
	let target = defaultMaintenanceTarget
	let dryRun = false
	let json = false

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (!argument) continue
		if (argument === '--dry-run') {
			dryRun = true
			continue
		}
		if (argument === '--json') {
			json = true
			continue
		}
		if (argument === '--zone') {
			zone = readFlagValue(argv, index, '--zone')
			index += 1
			continue
		}
		if (argument === '--target') {
			target = readFlagValue(argv, index, '--target')
			index += 1
			continue
		}
		if (argument.startsWith('--')) {
			throw new Error(`Unknown flag: ${argument}`)
		}
		if (command !== null) {
			throw new Error(`Unexpected argument: ${argument}`)
		}
		if (!isMaintenanceModeCommand(argument)) {
			throw new Error(`Unknown command: ${argument}. Use on, off, or status.`)
		}
		command = argument
	}

	if (command === null) {
		throw new Error(
			'Usage: maintenance-mode <on|off|status> [--zone] [--target] [--dry-run] [--json]',
		)
	}

	return { command, zone, target, dryRun, json }
}

export function buildMaintenanceExpression(zone: string) {
	return `(http.host eq "${zone}" and not starts_with(http.request.uri.path, "/__maintenance/") and http.request.uri.path ne "/health")`
}

export function buildMaintenanceRedirectRule(input: {
	zone: string
	target: string
	enabled: boolean
}) {
	return {
		ref: maintenanceRuleMarker,
		description: maintenanceRuleMarker,
		expression: buildMaintenanceExpression(input.zone),
		action: 'redirect',
		enabled: input.enabled,
		action_parameters: {
			from_value: {
				target_url: { value: input.target },
				status_code: 302,
				preserve_query_string: false,
			},
		},
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findMaintenanceRule(
	ruleset: CloudflareRuleset | null,
): CloudflareRedirectRule | null {
	if (!ruleset?.rules) return null
	return (
		ruleset.rules.find(
			(rule) =>
				rule.description?.includes(maintenanceRuleMarker) ||
				rule.ref === maintenanceRuleMarker,
		) ?? null
	)
}

function ruleEnabled(rule: CloudflareRedirectRule | null) {
	return rule?.enabled === true
}

function ruleTarget(rule: CloudflareRedirectRule | null, fallback: string) {
	return rule?.action_parameters?.from_value?.target_url?.value ?? fallback
}

function ruleNeedsUpdate(
	existing: CloudflareRedirectRule,
	desired: ReturnType<typeof buildMaintenanceRedirectRule>,
) {
	const fromValue = existing.action_parameters?.from_value
	return (
		existing.expression !== desired.expression ||
		fromValue?.target_url?.value !==
			desired.action_parameters.from_value.target_url.value ||
		fromValue?.status_code !==
			desired.action_parameters.from_value.status_code ||
		fromValue?.preserve_query_string !==
			desired.action_parameters.from_value.preserve_query_string ||
		existing.action !== desired.action ||
		existing.ref !== desired.ref ||
		existing.description !== desired.description
	)
}

function formatAuthFailure(status: number) {
	return `Cloudflare API request failed (${status}). ${requiredTokenScopesMessage}`
}

async function cloudflareRequest<T>(input: {
	apiToken: string
	method: 'GET' | 'POST' | 'PATCH'
	pathname: string
	body?: unknown
	fetch: typeof fetch
	allowNotFound?: boolean
}): Promise<{ status: number; result: T | null }> {
	const url = `${cloudflareApiBaseUrl}${input.pathname}`
	const response = await input.fetch(url, {
		method: input.method,
		headers: {
			Authorization: `Bearer ${input.apiToken}`,
			Accept: 'application/json',
			...(input.body ? { 'Content-Type': 'application/json' } : {}),
		},
		...(input.body ? { body: JSON.stringify(input.body) } : {}),
	})
	const text = await response.text()
	if (response.status === 401 || response.status === 403) {
		throw new Error(formatAuthFailure(response.status))
	}
	if (input.allowNotFound && response.status === 404) {
		return { status: 404, result: null }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(
			`Malformed Cloudflare response (${response.status}) for ${input.pathname}: ${text.trim().slice(0, 200) || '(empty body)'}`,
		)
	}
	if (!isRecord(parsed)) {
		throw new Error(
			`Malformed Cloudflare response (${response.status}) for ${input.pathname}`,
		)
	}
	const payload = parsed as CloudflareApiEnvelope<T>
	if (
		!response.ok ||
		payload.success !== true ||
		payload.result === undefined
	) {
		const error = payload.errors?.[0]
		throw new Error(
			`Cloudflare API request failed (${response.status}): ${error?.message ?? error?.code ?? input.pathname}`,
		)
	}
	return { status: response.status, result: payload.result }
}

function pathSegment(value: string) {
	return /^[\w{}-]+$/.test(value) ? value : encodeURIComponent(value)
}

function zoneLookupPath(zone: string) {
	return `/zones?name=${encodeURIComponent(zone)}&status=active`
}

function entrypointPath(zoneId: string) {
	return `/zones/${pathSegment(zoneId)}/rulesets/phases/${dynamicRedirectPhase}/entrypoint`
}

function rulesetsPath(zoneId: string) {
	return `/zones/${pathSegment(zoneId)}/rulesets`
}

function rulesetRulesPath(zoneId: string, rulesetId: string) {
	return `/zones/${pathSegment(zoneId)}/rulesets/${pathSegment(rulesetId)}/rules`
}

function rulePath(zoneId: string, rulesetId: string, ruleId: string) {
	return `${rulesetRulesPath(zoneId, rulesetId)}/${pathSegment(ruleId)}`
}

function plannedUrl(pathname: string) {
	return `${cloudflareApiBaseUrl}${pathname}`
}

function dryRunLookupRequests(zone: string) {
	return [
		{
			method: 'GET' as const,
			url: plannedUrl(zoneLookupPath(zone)),
		},
		{
			method: 'GET' as const,
			url: plannedUrl(entrypointPath('{zone_id}')),
		},
	]
}

function unauthenticatedDryRunRequests(options: MaintenanceModeOptions) {
	const lookups = dryRunLookupRequests(options.zone)
	switch (options.command) {
		case 'status':
			return lookups
		case 'on':
			return [
				...lookups,
				{
					method: 'POST' as const,
					url: plannedUrl(rulesetsPath('{zone_id}')),
					body: {
						name: 'Redirect rules ruleset',
						kind: 'zone',
						phase: dynamicRedirectPhase,
						rules: [
							buildMaintenanceRedirectRule({
								zone: options.zone,
								target: options.target,
								enabled: true,
							}),
						],
					},
				},
			]
		case 'off':
			return [
				...lookups,
				{
					method: 'PATCH' as const,
					url: plannedUrl(rulePath('{zone_id}', '{ruleset_id}', '{rule_id}')),
					body: buildMaintenanceRedirectRule({
						zone: options.zone,
						target: options.target,
						enabled: false,
					}),
				},
			]
		default: {
			const unexpected: never = options.command
			throw new Error(`Unexpected command: ${String(unexpected)}`)
		}
	}
}

function printHumanResult(
	result: MaintenanceModeResult,
	log: (line: string) => void,
) {
	const state = result.enabled
		? 'enabled'
		: result.exists
			? 'disabled'
			: 'absent'
	log(
		`Maintenance mode: ${result.enabled ? 'on' : 'off'} (${state} on ${result.zone})`,
	)
	log(`Target: ${result.target}`)
	if (result.dryRun) {
		log('Dry-run: no Cloudflare writes were sent. Planned API calls:')
		for (const request of result.requests) {
			log(`${request.method} ${request.url}`)
			if (request.body !== undefined) {
				log(JSON.stringify(request.body, null, 2))
			}
		}
	}
}

export async function runMaintenanceMode(
	options: MaintenanceModeOptions,
	deps: MaintenanceModeDeps = {},
): Promise<MaintenanceModeResult> {
	const env = deps.env ?? process.env
	const fetchImpl = deps.fetch ?? fetch
	const log = deps.log ?? console.log
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim() ?? ''

	if (!apiToken) {
		if (!options.dryRun) {
			throw new Error(
				`CLOUDFLARE_API_TOKEN is required. ${requiredTokenScopesMessage}`,
			)
		}
		const requests = unauthenticatedDryRunRequests(options)
		const result: MaintenanceModeResult = {
			command: options.command,
			zone: options.zone,
			target: options.target,
			exists: false,
			enabled: false,
			dryRun: true,
			requests,
		}
		if (options.json) log(JSON.stringify(result, null, 2))
		else printHumanResult(result, log)
		return result
	}

	const requests: Array<PlannedApiRequest> = []
	const zoneLookup: PlannedApiRequest = {
		method: 'GET',
		url: plannedUrl(zoneLookupPath(options.zone)),
	}
	requests.push(zoneLookup)
	const zones = await cloudflareRequest<Array<CloudflareZone>>({
		apiToken,
		method: 'GET',
		pathname: zoneLookupPath(options.zone),
		fetch: fetchImpl,
	})
	const zone = (zones.result ?? []).find((entry) => entry.name === options.zone)
	if (!zone) {
		throw new Error(`Cloudflare zone not found: ${options.zone}`)
	}

	const entrypointLookup: PlannedApiRequest = {
		method: 'GET',
		url: plannedUrl(entrypointPath(zone.id)),
	}
	requests.push(entrypointLookup)
	const entrypointResponse = await cloudflareRequest<CloudflareRuleset>({
		apiToken,
		method: 'GET',
		pathname: entrypointPath(zone.id),
		fetch: fetchImpl,
		allowNotFound: true,
	})
	const entrypoint = entrypointResponse.result
	const existingRule = findMaintenanceRule(entrypoint)
	const exists = existingRule !== null
	const enabled = ruleEnabled(existingRule)
	const currentTarget = ruleTarget(existingRule, options.target)

	async function applyWrite(request: PlannedApiRequest) {
		requests.push(request)
		if (options.dryRun) return
		const url = new URL(request.url)
		const pathname = `${url.pathname.slice(new URL(cloudflareApiBaseUrl).pathname.length)}${url.search}`
		await cloudflareRequest({
			apiToken,
			method: request.method,
			pathname,
			body: request.body,
			fetch: fetchImpl,
		})
	}

	switch (options.command) {
		case 'status': {
			const result: MaintenanceModeResult = {
				command: 'status',
				zone: options.zone,
				target: currentTarget,
				exists,
				enabled,
				dryRun: options.dryRun,
				requests,
				rulesetId: entrypoint?.id,
				ruleId: existingRule?.id,
			}
			if (options.json) log(JSON.stringify(result, null, 2))
			else printHumanResult(result, log)
			return result
		}
		case 'on': {
			const rule = buildMaintenanceRedirectRule({
				zone: options.zone,
				target: options.target,
				enabled: true,
			})
			if (!entrypoint) {
				await applyWrite({
					method: 'POST',
					url: plannedUrl(rulesetsPath(zone.id)),
					body: {
						name: 'Redirect rules ruleset',
						kind: 'zone',
						phase: dynamicRedirectPhase,
						rules: [rule],
					},
				})
			} else if (!existingRule) {
				await applyWrite({
					method: 'POST',
					url: plannedUrl(rulesetRulesPath(zone.id, entrypoint.id)),
					body: rule,
				})
			} else if (!enabled || ruleNeedsUpdate(existingRule, rule)) {
				if (!existingRule.id) {
					throw new Error(
						'Maintenance redirect rule is missing an id; cannot update it.',
					)
				}
				await applyWrite({
					method: 'PATCH',
					url: plannedUrl(rulePath(zone.id, entrypoint.id, existingRule.id)),
					body: { ...rule, enabled: true },
				})
			}
			const result: MaintenanceModeResult = {
				command: 'on',
				zone: options.zone,
				target: options.target,
				exists: true,
				enabled: true,
				dryRun: options.dryRun,
				requests,
				rulesetId: entrypoint?.id,
				ruleId: existingRule?.id,
			}
			if (options.json) log(JSON.stringify(result, null, 2))
			else printHumanResult(result, log)
			return result
		}
		case 'off': {
			if (existingRule?.id && enabled && entrypoint) {
				await applyWrite({
					method: 'PATCH',
					url: plannedUrl(rulePath(zone.id, entrypoint.id, existingRule.id)),
					body: {
						...buildMaintenanceRedirectRule({
							zone: options.zone,
							target: currentTarget,
							enabled: false,
						}),
						enabled: false,
					},
				})
			}
			const result: MaintenanceModeResult = {
				command: 'off',
				zone: options.zone,
				target: currentTarget,
				exists,
				enabled: false,
				dryRun: options.dryRun,
				requests,
				rulesetId: entrypoint?.id,
				ruleId: existingRule?.id,
			}
			if (options.json) log(JSON.stringify(result, null, 2))
			else printHumanResult(result, log)
			return result
		}
		default: {
			const unexpected: never = options.command
			throw new Error(`Unexpected command: ${String(unexpected)}`)
		}
	}
}

async function main(argv: ReadonlyArray<string> = process.argv.slice(2)) {
	await runMaintenanceMode(parseArgs(argv))
}

if (isExecutedDirectly(import.meta.url)) {
	void main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		process.exitCode = 1
	})
}
