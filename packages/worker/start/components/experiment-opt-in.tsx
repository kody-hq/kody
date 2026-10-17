/** @jsxImportSource @emotion/react */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { optIntoExperiment } from '#start/server/experiment-opt-in'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
export function ExperimentOptIn({
	experiment,
	children,
}: {
	experiment: 'package-skills' | 'mcp-events'
	children: string
}) {
	const router = useRouter()
	const client = useQueryClient()
	const mutation = useMutation({
		mutationFn: () => optIntoExperiment({ data: experiment }),
		onSettled: async () => {
			await client.invalidateQueries({ queryKey: ['shell'] })
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
				{children}
			</button>
			{mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
		</div>
	)
}
