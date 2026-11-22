import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import type { OAuthPurgeResult, PurgeContinuation } from './oauth-purge.ts'
import {
	oauthPurgeCoordinatorState,
	oauthPurgeRunState,
} from './oauth-purge-state.ts'

const result: OAuthPurgeResult = {
	phase: 'grants',
	checked: 1,
	grantsPurged: 0,
	tokensPurged: 0,
	phaseComplete: false,
	budgetExhausted: false,
}

function run(input: { continuation: PurgeContinuation; failPhase?: boolean }) {
	const calls: Array<string> = []
	const saved: Array<PurgeContinuation> = []
	function phase(name: string) {
		return createAsyncLogic({
			run: async ({ input: continuation }: { input: PurgeContinuation }) => {
				calls.push(name)
				if (input.failPhase) throw new Error('kv down')
				return {
					result,
					continuation: { ...continuation, grantCursor: 'next' },
				}
			},
		})
	}
	const machine = oauthPurgeRunState.provide({
		actors: {
			loadContinuation: createAsyncLogic({
				run: async () => {
					calls.push('load')
					return input.continuation
				},
			}),
			purgeGrantPhase: phase('grants'),
			purgeTokenPhase: phase('tokens'),
			saveContinuation: createAsyncLogic({
				run: async ({ input: continuation }: { input: PurgeContinuation }) => {
					calls.push('save')
					saved.push(continuation)
				},
			}),
		},
	})
	return { calls, saved, output: toPromise(createActor(machine).start()) }
}

test('a run loads its continuation, runs the stored phase, and saves the advanced continuation', async () => {
	const grants = run({ continuation: { version: 1, nextPhase: 'grants' } })
	expect(await grants.output).toEqual({ status: 'saved', result })
	expect(grants.calls).toEqual(['load', 'grants', 'save'])
	expect(grants.saved).toEqual([
		{ version: 1, nextPhase: 'grants', grantCursor: 'next' },
	])
	const tokens = run({ continuation: { version: 1, nextPhase: 'tokens' } })
	await tokens.output
	expect(tokens.calls).toEqual(['load', 'tokens', 'save'])
})

test('a failed phase saves nothing', async () => {
	const { calls, output } = run({
		continuation: { version: 1, nextPhase: 'grants' },
		failPhase: true,
	})
	expect(await output).toMatchObject({ status: 'failed' })
	expect(calls).toEqual(['load', 'grants'])
})

test('the coordinator runs requests one at a time and settles each, even after a failure', async () => {
	const started: Array<number> = []
	const finish = new Map<number, (error?: Error) => void>()
	const coordinator = createActor(
		oauthPurgeCoordinatorState.provide({
			actors: {
				purgeRun: createAsyncLogic({
					run: ({ input }: { input: { scheduledAt: number } }) => {
						started.push(input.scheduledAt)
						return new Promise<OAuthPurgeResult>((resolve, reject) => {
							finish.set(input.scheduledAt, (error) =>
								error ? reject(error) : resolve(result),
							)
						})
					},
				}),
			},
		}),
	).start()
	function request(scheduledAt: number) {
		return new Promise<OAuthPurgeResult>((resolve, reject) =>
			coordinator.send({
				type: 'RUN',
				request: { scheduledAt, resolve, reject },
			}),
		)
	}
	const first = request(1)
	const second = request(2)
	const third = request(3)
	await Promise.resolve()
	expect(started).toEqual([1])
	expect(coordinator.getSnapshot().value).toBe('running')
	const failure = new Error('kv down')
	finish.get(1)!(failure)
	await expect(first).rejects.toBe(failure)
	await Promise.resolve()
	expect(started).toEqual([1, 2])
	finish.get(2)!()
	await expect(second).resolves.toBe(result)
	await Promise.resolve()
	finish.get(3)!()
	await expect(third).resolves.toBe(result)
	await Promise.resolve()
	expect(coordinator.getSnapshot().value).toBe('idle')
})
