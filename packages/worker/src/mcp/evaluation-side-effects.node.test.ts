import { expect, test, vi } from 'vitest'
import {
	createEvaluationSideEffectTracker,
	createHostSideEffectProvider,
	evaluationHasHostMediatedSideEffects,
	hostSideEffectProviderName,
	isPlatformOnlyHostSideEffectProvider,
	noteSandboxFetchRecordFailures,
} from './evaluation-side-effects.ts'

const mocks = vi.hoisted(() => ({ captureMessage: vi.fn() }))

vi.mock('@sentry/cloudflare', () => ({
	captureMessage: mocks.captureMessage,
	withScope: (callback: (scope: unknown) => void) =>
		callback({ setTag() {}, setContext() {} }),
}))

test('evaluation side-effect tracker counts attempts and treats a missing snapshot as dirty', () => {
	expect(evaluationHasHostMediatedSideEffects(undefined)).toBe(true)
	expect(evaluationHasHostMediatedSideEffects(null)).toBe(true)
	expect(
		evaluationHasHostMediatedSideEffects({
			dispatcherAttempts: 0,
			fetchAttempts: 0,
		}),
	).toBe(false)

	const sideEffects = createEvaluationSideEffectTracker()
	expect(evaluationHasHostMediatedSideEffects(sideEffects.snapshot())).toBe(
		false,
	)
	sideEffects.recordDispatcherAttempt()
	expect(sideEffects.snapshot()).toEqual({
		dispatcherAttempts: 1,
		fetchAttempts: 0,
	})
	expect(evaluationHasHostMediatedSideEffects(sideEffects.snapshot())).toBe(
		true,
	)

	const fetchOnly = createEvaluationSideEffectTracker()
	fetchOnly.recordFetchAttempt()
	expect(fetchOnly.snapshot()).toEqual({
		dispatcherAttempts: 0,
		fetchAttempts: 1,
	})
	expect(evaluationHasHostMediatedSideEffects(fetchOnly.snapshot())).toBe(true)

	expect(isPlatformOnlyHostSideEffectProvider('kody')).toBe(false)

	const provider = createHostSideEffectProvider(fetchOnly)
	expect(provider.name).toBe(hostSideEffectProviderName)
})

test('host counts sandbox fetch-record failures as fetch attempts and reports once', () => {
	const sideEffects = createEvaluationSideEffectTracker()
	noteSandboxFetchRecordFailures(undefined, sideEffects)
	noteSandboxFetchRecordFailures({ count: 0, message: null }, sideEffects)
	expect(sideEffects.snapshot().fetchAttempts).toBe(0)
	expect(mocks.captureMessage).not.toHaveBeenCalled()

	noteSandboxFetchRecordFailures(
		{ count: 2, message: 'RPC stub used after being disposed.' },
		sideEffects,
	)
	expect(sideEffects.snapshot()).toEqual({
		dispatcherAttempts: 0,
		fetchAttempts: 2,
	})
	expect(evaluationHasHostMediatedSideEffects(sideEffects.snapshot())).toBe(
		true,
	)

	noteSandboxFetchRecordFailures({ count: 1, message: 'again' }, sideEffects)
	expect(sideEffects.snapshot().fetchAttempts).toBe(3)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage).toHaveBeenCalledWith(
		'Executor fetch-attempt recording failed: RPC stub used after being disposed.',
		'warning',
	)
})
