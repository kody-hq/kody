import { expect, test } from 'vitest'
import {
	buildMaintenanceExpression,
	buildMaintenanceRedirectRule,
	cloudflareApiBaseUrl,
	defaultMaintenanceTarget,
	defaultMaintenanceZone,
	maintenanceRuleMarker,
	parseArgs,
	runMaintenanceMode,
} from './maintenance-mode.ts'

const zoneId = 'zone-kody'
const rulesetId = 'ruleset-redirects'
const ruleId = 'rule-maintenance'
const zones = `${cloudflareApiBaseUrl}/zones`
const zoneLookupUrl = `${zones}?name=${defaultMaintenanceZone}&status=active`
const entrypointUrl = `${zones}/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`
const ruleUrl = `${zones}/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`
const maintenanceRule = buildMaintenanceRedirectRule({
	zone: defaultMaintenanceZone,
	target: defaultMaintenanceTarget,
	enabled: true,
})

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function envelope<T>(result: T, status = 200) {
	return jsonResponse({ success: true, result, errors: [] }, status)
}

function redirectRule(enabled: boolean, target = defaultMaintenanceTarget) {
	return {
		id: ruleId,
		ref: maintenanceRuleMarker,
		description: maintenanceRuleMarker,
		enabled,
		expression: buildMaintenanceExpression(defaultMaintenanceZone),
		action: 'redirect',
		action_parameters: {
			from_value: {
				target_url: { value: target },
				status_code: 302,
				preserve_query_string: false,
			},
		},
	}
}

function entrypoint(rules: Array<ReturnType<typeof redirectRule>>) {
	return envelope({
		id: rulesetId,
		name: 'Redirect rules ruleset',
		kind: 'zone',
		phase: 'http_request_dynamic_redirect',
		rules,
	})
}

/** Every write answers with the maintenance rule in the state the command asked for. */
async function runLive(
	argv: Array<string>,
	entrypointResponse: () => Response,
) {
	const calls: Array<{ method: string; url: string; body: unknown }> = []
	const result = await runMaintenanceMode(parseArgs(argv), {
		env: { CLOUDFLARE_API_TOKEN: 'token' },
		fetch: async (input, init) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			calls.push({
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			if (url === zoneLookupUrl) {
				return envelope([{ id: zoneId, name: defaultMaintenanceZone }])
			}
			if (url === entrypointUrl) return entrypointResponse()
			if (method === 'GET') throw new Error(`Unexpected GET ${url}`)
			return envelope({
				id: rulesetId,
				phase: 'http_request_dynamic_redirect',
				rules: [redirectRule(argv[0] !== 'off')],
			})
		},
		log: () => {},
	})
	return {
		result,
		requests: calls.map((call) => `${call.method} ${call.url}`),
		lastBody: calls.at(-1)?.body,
	}
}

test('dry-run without a token prints command-specific Rulesets API calls', async () => {
	const lines: Array<string> = []
	const on = await runMaintenanceMode(parseArgs(['on', '--dry-run']), {
		env: {},
		log: (line) => lines.push(line),
	})
	expect(
		on.requests.map((request) => `${request.method} ${request.url}`),
	).toEqual([
		`GET ${zoneLookupUrl}`,
		`GET ${zones}/{zone_id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
		`POST ${zones}/{zone_id}/rulesets`,
	])
	expect(on.requests[2]?.body).toMatchObject({
		phase: 'http_request_dynamic_redirect',
		rules: [{ description: maintenanceRuleMarker, enabled: true }],
	})

	const off = await runMaintenanceMode(parseArgs(['off', '--dry-run']), {
		env: {},
		log: () => {},
	})
	expect(off.requests.at(-1)).toMatchObject({
		method: 'PATCH',
		url: `${zones}/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}`,
		body: { enabled: false },
	})

	const status = await runMaintenanceMode(parseArgs(['status', '--dry-run']), {
		env: {},
		log: () => {},
	})
	expect(status.requests.every((request) => request.method === 'GET')).toBe(
		true,
	)
	expect(lines.join('\n')).toContain('POST')
})

test('parseArgs reads command, zone, target, dry-run, and json', () => {
	expect(parseArgs(['status'])).toEqual({
		command: 'status',
		zone: defaultMaintenanceZone,
		target: defaultMaintenanceTarget,
		dryRun: false,
		json: false,
	})
	expect(
		parseArgs([
			'on',
			'--zone',
			'example.com',
			'--target',
			'https://status.example.com/maintenance',
			'--dry-run',
			'--json',
		]),
	).toEqual({
		command: 'on',
		zone: 'example.com',
		target: 'https://status.example.com/maintenance',
		dryRun: true,
		json: true,
	})
	expect(() => parseArgs([])).toThrow(/Usage/)
	expect(() => parseArgs(['enable'])).toThrow(/Unknown command/)
	expect(() => parseArgs(['on', '--nope'])).toThrow(/Unknown flag/)
})

test('buildMaintenanceRedirectRule uses a static 302 to the status page', () => {
	expect(maintenanceRule).toEqual({
		ref: maintenanceRuleMarker,
		description: maintenanceRuleMarker,
		expression: `(http.host eq "${defaultMaintenanceZone}" and not starts_with(http.request.uri.path, "/__maintenance/") and http.request.uri.path ne "/health")`,
		action: 'redirect',
		enabled: true,
		action_parameters: {
			from_value: {
				target_url: { value: defaultMaintenanceTarget },
				status_code: 302,
				preserve_query_string: false,
			},
		},
	})
})

test('on and off make exactly one write: create, add, enable, retarget, or disable without deleting', async () => {
	const cases = [
		{
			scenario:
				'on creates the dynamic-redirect entrypoint when the zone has none',
			argv: ['on'],
			entrypoint: () =>
				jsonResponse(
					{ success: false, errors: [{ message: 'not found' }] },
					404,
				),
			write: `POST ${zones}/${zoneId}/rulesets`,
			body: {
				name: 'Redirect rules ruleset',
				kind: 'zone',
				phase: 'http_request_dynamic_redirect',
				rules: [maintenanceRule],
			},
			result: { exists: true, enabled: true },
		},
		{
			scenario: 'on adds the maintenance rule to an existing redirect ruleset',
			argv: ['on'],
			entrypoint: () => entrypoint([]),
			write: `POST ${zones}/${zoneId}/rulesets/${rulesetId}/rules`,
			body: maintenanceRule,
			result: { enabled: true },
		},
		{
			scenario: 'on enables an existing disabled maintenance rule',
			argv: ['on'],
			entrypoint: () => entrypoint([redirectRule(false)]),
			write: `PATCH ${ruleUrl}`,
			body: expect.objectContaining({
				enabled: true,
				ref: maintenanceRuleMarker,
			}),
			result: { enabled: true },
		},
		{
			scenario: 'on patches an enabled rule when the target differs',
			argv: ['on'],
			entrypoint: () =>
				entrypoint([
					redirectRule(true, 'https://status.kody.codes/old-maintenance'),
				]),
			write: `PATCH ${ruleUrl}`,
			body: expect.objectContaining({
				enabled: true,
				action_parameters: expect.objectContaining({
					from_value: expect.objectContaining({
						target_url: { value: defaultMaintenanceTarget },
					}),
				}),
			}),
			result: { target: defaultMaintenanceTarget },
		},
		{
			scenario: 'off disables the existing rule and does not delete it',
			argv: ['off'],
			entrypoint: () => entrypoint([redirectRule(true)]),
			write: `PATCH ${ruleUrl}`,
			body: expect.objectContaining({ enabled: false }),
			result: { exists: true, enabled: false },
		},
	]
	for (const {
		scenario,
		argv,
		entrypoint: respond,
		write,
		body,
		result,
	} of cases) {
		const live = await runLive(argv, respond)
		expect({ scenario, requests: live.requests, body: live.lastBody }).toEqual({
			scenario,
			requests: [`GET ${zoneLookupUrl}`, `GET ${entrypointUrl}`, write],
			body,
		})
		expect(live.result).toMatchObject(result)
	}
})

test('status reports whether the rule exists and is enabled', async () => {
	const { result, requests } = await runLive(['status', '--json'], () =>
		entrypoint([redirectRule(true)]),
	)
	expect(requests).toEqual([`GET ${zoneLookupUrl}`, `GET ${entrypointUrl}`])
	expect(result).toMatchObject({
		command: 'status',
		exists: true,
		enabled: true,
		zone: defaultMaintenanceZone,
		target: defaultMaintenanceTarget,
		rulesetId,
		ruleId,
	})
})
