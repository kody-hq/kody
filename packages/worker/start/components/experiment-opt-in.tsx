/** @jsxImportSource @emotion/react */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { setExperiment } from '#start/server/experiment-opt-in'
import { type SelfServeExperimentId } from '#universal/feature-flags/experiments.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'

/** Turns one self-serve experiment on for the signed-in person. */
export function ExperimentOptIn({
	experiment,
	children,
}: {
	experiment: SelfServeExperimentId
	children: string
}) {
	const router = useRouter()
	const client = useQueryClient()
	const mutation = useMutation({
		mutationFn: () => setExperiment({ data: { experiment, enabled: true } }),
		onSettled: async () => {
			await client.invalidateQueries({ queryKey: ['shell'] })
			await client.invalidateQueries({ queryKey: ['page'] })
			await router.invalidate()
		},
	})
	return (
		<div css={{ margin: '0.75rem 0 0' }}>
			<button
				type="button"
				data-testid={`${experiment}-flag-opt-in`}
				css={getPillButtonCss({ size: 'sm' })}
				disabled={mutation.isPending}
				onClick={() => mutation.mutate()}
			>
				{mutation.isPending ? 'Turning on…' : children}
			</button>
			{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
		</div>
	)
}
