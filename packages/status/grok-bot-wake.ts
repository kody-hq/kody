import { statusComponents, type StatusComponentId } from './status-types.ts'

/**
 * Out-of-band Grok Bot wake. The status worker POSTs straight to the bot's
 * webhook (never through the main origin) so an outage that takes down
 * `kody.codes` still reaches a human. One wake per probe tick: every incident
 * that opened in the tick shares one prompt, and one all-clear goes out once
 * every woken incident resolves.
 */

export const grokBotWakeTimeoutMs = 5000
export const defaultGrokBotWakeDailyLimit = 12

export type WakeIncident = {
	id: number
	component: StatusComponentId
	detail: string | null
	startedAt: number
	resolvedAt?: number | null
}

export type GrokBotWakeDecision =
	| { kind: 'opened'; incidents: Array<WakeIncident> }
	| { kind: 'all_clear'; incidents: Array<WakeIncident> }

/**
 * `openIncidents` are the currently open incidents, `pendingAllClear` are
 * incidents that already got an opened wake but not an all-clear yet.
 * Incident ids that already got an opened wake never wake again, so probe
 * retries and flaps inside the threshold stay quiet.
 */
export function decideGrokBotWake(input: {
	openIncidents: Array<WakeIncident>
	wokenIncidentIds: ReadonlySet<number>
	pendingAllClear: Array<WakeIncident>
	wakesSentToday: number
	dailyLimit: number
}): GrokBotWakeDecision | null {
	if (input.wakesSentToday >= input.dailyLimit) return null
	const fresh = input.openIncidents.filter(
		(incident) => !input.wokenIncidentIds.has(incident.id),
	)
	if (fresh.length > 0) return { kind: 'opened', incidents: fresh }
	if (input.openIncidents.length === 0 && input.pendingAllClear.length > 0) {
		return { kind: 'all_clear', incidents: input.pendingAllClear }
	}
	return null
}

function componentName(id: StatusComponentId): string {
	return statusComponents.find((component) => component.id === id)?.name ?? id
}

function iso(epochMs: number): string {
	return new Date(epochMs).toISOString()
}

export function composeGrokBotWakePrompt(input: {
	decision: GrokBotWakeDecision
	openIncidents: Array<WakeIncident>
	statusPageUrl: string
	now: number
}): string {
	const { decision } = input
	const lines: Array<string> = []
	if (decision.kind === 'opened') {
		const count = decision.incidents.length
		lines.push(
			`Kody status alert: ${count} component${count === 1 ? '' : 's'} opened an incident (${iso(input.now)}).`,
			'',
		)
		for (const incident of decision.incidents) {
			lines.push(
				`- ${componentName(incident.component)} (${incident.component}, incident #${incident.id}): ${incident.detail ?? 'no detail'}, started ${iso(incident.startedAt)}`,
			)
		}
		const alreadyOpen = input.openIncidents.length - count
		if (alreadyOpen > 0) {
			lines.push('', `${alreadyOpen} other incident(s) were already open.`)
		}
		lines.push(
			'',
			`Status page: ${input.statusPageUrl}`,
			`JSON: ${input.statusPageUrl}/status.json`,
			'',
			'This wake comes straight from the kody-status worker, not through kody.codes, so it fires even when the main origin is down. Check status.json, Workers observability, and recent deploys.',
		)
	} else {
		lines.push(
			`Kody status all clear: every component is operational again (${iso(input.now)}).`,
			'',
		)
		for (const incident of decision.incidents) {
			const resolved =
				incident.resolvedAt == null
					? 'resolved'
					: `resolved ${iso(incident.resolvedAt)}`
			lines.push(
				`- ${componentName(incident.component)} (${incident.component}, incident #${incident.id}): started ${iso(incident.startedAt)}, ${resolved}`,
			)
		}
		lines.push('', `Status page: ${input.statusPageUrl}`)
	}
	return lines.join('\n')
}

/**
 * Kody resolves `{{secret:...}}` placeholders in outbound bodies, so the
 * serialized JSON never carries a raw `{{`. `\u007b` is the JSON escape for
 * `{`, so the receiver parses back the exact original text. Structural JSON
 * never emits `{{` because object keys are strings.
 */
export function serializeGrokBotWakeBody(
	body: Record<string, unknown>,
): string {
	return JSON.stringify(body).replace(/\{(?=\{)/g, '\\u007b')
}

export type GrokBotWakeResult =
	| { ok: true; skipped: true; reason: string }
	| { ok: true; skipped: false; status: number }
	| { ok: false; error: string; timedOut?: boolean }

export async function sendGrokBotWake(input: {
	url: string | null | undefined
	token: string | null | undefined
	botId: string | null | undefined
	botName: string | null | undefined
	prompt: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<GrokBotWakeResult> {
	const url = input.url?.trim()
	const token = input.token?.trim()
	const botId = input.botId?.trim()
	const botName = input.botName?.trim()
	if (!url || !token) {
		return { ok: true, skipped: true, reason: 'wake-secrets-unset' }
	}
	if (!botId || !botName) {
		return { ok: true, skipped: true, reason: 'wake-bot-unset' }
	}
	let target: URL
	try {
		target = new URL(url)
	} catch {
		return { ok: false, error: 'invalid-wake-url' }
	}
	if (target.protocol !== 'https:') {
		return { ok: false, error: 'insecure-wake-url' }
	}
	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? grokBotWakeTimeoutMs
	try {
		const response = await fetchImpl(target, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: serializeGrokBotWakeBody({
				id: botId,
				name: botName,
				prompt: input.prompt,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!response.ok) {
			return { ok: false, error: `http-${response.status}` }
		}
		return { ok: true, skipped: false, status: response.status }
	} catch (error) {
		const name = error instanceof Error ? error.name : ''
		if (name === 'TimeoutError' || name === 'AbortError') {
			return { ok: false, error: 'timeout', timedOut: true }
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message.slice(0, 200) : 'error',
		}
	}
}
