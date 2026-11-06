import type { CommunityForkState } from '#universal/community-public-types.ts'
import type {
	CommunityInstallApiPayload,
	CommunityInstallOutcome,
} from './community-types.ts'

/** Same cadence as `FORK_IN_PROGRESS_POLL_MS` — kept local to avoid importing the query module (serverFn) into this client helper. */
const LOST_ENVELOPE_IN_PROGRESS_WAIT_MS = 2_000

/**
 * Normalize a website fork/install server-fn payload. After a successful fork
 * the Start client can still resolve to `undefined` when the RPC envelope's
 * `result` is missing (`return result.result` in createServerFn) — often a
 * lost/incomplete response after a long install that already committed. Never
 * read `.ok` until the payload is an object, or the UI surfaces
 * `Cannot read properties of undefined (reading 'ok')` after the fork row
 * already exists.
 */
export function readCommunityInstallResult(
	result: unknown,
): CommunityInstallOutcome {
	const payload =
		result && typeof result === 'object'
			? (result as CommunityInstallApiPayload)
			: null
	if (
		!payload ||
		payload.ok !== true ||
		!payload.status ||
		!payload.targetName ||
		!payload.agentPrompt
	) {
		throw new Error(
			(payload && typeof payload.error === 'string' && payload.error) ||
				'Unable to install this public package.',
		)
	}
	return {
		status: payload.status,
		targetName: payload.targetName,
		agentPrompt: payload.agentPrompt,
		packageId: payload.packageId ?? null,
		failedChecks: payload.failedChecks ?? [],
		alreadyInstalled: payload.alreadyInstalled === true,
	}
}

function isExplicitInstallFailure(result: unknown): result is {
	ok: false
	error?: string
} {
	return Boolean(
		result &&
		typeof result === 'object' &&
		(result as { ok?: unknown }).ok === false,
	)
}

/**
 * Keep in sync with `buildInstallSuccessPrompt` /
 * `buildInstallAdaptPrompt` in `#app/community-public` (server-only module).
 * Used only when Start lost the install body and we reconstruct from live
 * fork state.
 */
function agentPromptForLiveFork(live: {
	state: 'installed' | 'adaptation_required'
	targetName: string
}): string {
	if (live.state === 'installed') {
		return `I just one-click installed the public package "${live.targetName}" into my Kody account. Call packageGet for export and secret metadata (it does not return files). Then open a repo session with repoOpenSession({ target: { kind: "package", kody_id: ${JSON.stringify(live.targetName)} } }) and repoReadFile README.md and AGENTS.md. Walk me through any remaining setup: create required secrets or OAuth connections, approve package secret access if prompted, and run a quick test to confirm it works.`
	}
	return `I one-click installed the public package "${live.targetName}" on Kody, but it needs adaptation before it can be published. Open it with repoOpenSession, do a read-only safety review of all files, fix the failing publish checks — re-implement or remove any cross-scope kody:@ imports — rewrite the README Intent section for my goals, then publish with repoPublishSession.`
}

export function communityInstallOutcomeFromLiveFork(
	live: Extract<
		CommunityForkState,
		{ state: 'installed' | 'adaptation_required' }
	>,
): CommunityInstallOutcome {
	return {
		status: live.state,
		targetName: live.targetName,
		agentPrompt: agentPromptForLiveFork(live),
		packageId: null,
		failedChecks: [],
		alreadyInstalled: false,
	}
}

/**
 * Prefer the serverFn body when present. When Start resolves to `undefined`
 * (lost envelope after a committed write), reconcile through live fork state
 * instead of reporting a false failure — same rule as other Start mutations
 * (`docs/contributing/tanstack-start.md` Writes).
 */
export async function resolveCommunityInstallResult(input: {
	result: unknown
	loadForkState: () => Promise<CommunityForkState>
	waitMs?: (ms: number) => Promise<void>
	inProgressPollMs?: number
}): Promise<CommunityInstallOutcome> {
	if (isExplicitInstallFailure(input.result)) {
		throw new Error(
			(typeof input.result.error === 'string' && input.result.error) ||
				'Unable to install this public package.',
		)
	}
	if (input.result != null && typeof input.result === 'object') {
		return readCommunityInstallResult(input.result)
	}

	const wait =
		input.waitMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
	const pollMs = input.inProgressPollMs ?? LOST_ENVELOPE_IN_PROGRESS_WAIT_MS
	let live = await input.loadForkState()
	if (live.state === 'in_progress') {
		await wait(pollMs)
		live = await input.loadForkState()
	}
	if (live.state === 'installed' || live.state === 'adaptation_required') {
		return communityInstallOutcomeFromLiveFork(live)
	}
	throw new Error('Unable to install this public package.')
}
