import type { Clock } from './clock.ts'

/**
 * An explicit wall-clock budget for one lane pass, read from the injected
 * clock. `reached` is `elapsed >= budget`; `exceeded` is `elapsed > budget`.
 * Lanes keep the comparison they always used so a zero budget behaves as
 * before (the unverified purge processes nothing, the soft-delete purge still
 * processes the first candidate).
 */
export type PassBudget = {
	readonly budgetMs: number
	elapsedMs(): number
	reached(): boolean
	exceeded(): boolean
}

export function startPassBudget(clock: Clock, budgetMs: number): PassBudget {
	const startedAtMs = clock.nowMs()
	const elapsedMs = () => clock.nowMs() - startedAtMs
	return {
		budgetMs,
		elapsedMs,
		reached: () => elapsedMs() >= budgetMs,
		exceeded: () => elapsedMs() > budgetMs,
	}
}
