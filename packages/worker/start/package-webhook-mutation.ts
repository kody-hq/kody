import {
	mintPackageWebhook,
	rotatePackageWebhook,
	revealPackageWebhook,
	enablePackageWebhook,
	disablePackageWebhook,
} from '#start/server/package-webhooks'
import {
	mutationOptions,
	type QueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import {
	type WebhookIntent,
	webhookFailureMessage,
} from '#client/routes/webhooks-shared.ts'

export function packageWebhookMutationOptions(queryClient: QueryClient) {
	return mutationOptions({
		gcTime: 0,
		mutationFn: async (input: {
			username: string
			kodyId: string
			webhookName: string
			endpointId?: string | null
			createInstance?: boolean
			instanceLabel?: string
			webhookId: string
			intent: WebhookIntent
			queryKey: QueryKey
			/** Related page resources only, never the package webhook read itself. */
			invalidate: () => Promise<void>
		}) => {
			const operation = {
				mint: mintPackageWebhook,
				rotate: rotatePackageWebhook,
				reveal: revealPackageWebhook,
				enable: enablePackageWebhook,
				disable: disablePackageWebhook,
			}[input.intent]
			const payload = await operation({
				data: {
					username: input.username,
					kodyId: input.kodyId,
					webhookName: input.webhookName,
					endpointId: input.endpointId ?? undefined,
					createInstance: input.createInstance,
					instanceLabel: input.instanceLabel,
				},
			})
			if (!payload.ok)
				throw new Error(payload.error || webhookFailureMessage(input.intent))
			return payload
		},
		onMutate: async ({ queryKey }) => {
			await queryClient.cancelQueries({
				queryKey,
				exact: true,
				predicate: (query) => query.state.data !== undefined,
			})
		},
		onSettled: async (_accepted, _error, input) => {
			// A navigation can start its first read while this write is pending.
			// Let that shared promise finish before starting a confirming read.
			await Promise.allSettled(
				queryClient
					.getQueryCache()
					.findAll({ queryKey: input.queryKey, exact: true })
					.filter(
						(query) =>
							query.state.data === undefined &&
							query.state.fetchStatus === 'fetching',
					)
					.map((query) => query.promise),
			)

			await queryClient.cancelQueries({
				queryKey: input.queryKey,
				exact: true,
				predicate: (query) => query.state.data !== undefined,
			})
			// Reconcile the submitted package even if its committed response was lost.
			// One-time reveal and approval URLs never enter the read cache.
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: input.queryKey,
					refetchType: 'all',
					exact: true,
				}),
				input.invalidate(),
			])
		},
	})
}
