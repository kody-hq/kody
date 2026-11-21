/**
 * A copy of `env` with the wide-lanes Effect trial switch on. The flag is
 * non-enumerable so assertions that compare the env by value still match.
 */
export function withEffectTrialWideLanes(env: Env): Env {
	return Object.defineProperty({ ...env }, 'EFFECT_TRIAL_WIDE_LANES', {
		value: '1',
		enumerable: false,
	})
}
