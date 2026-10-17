import { expect, test } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { createPageQuery, ensurePageQuery } from './page-query.ts'
import { invalidateCredentialResources } from './credential-mutation.ts'
import { orgSettingsMutationOptions } from './org-settings-mutation.ts'

test.each(['credentials', 'organization'] as const)(
	'%s settlement preserves an uncached navigation promise',
	async (kind) => {
		const client = new QueryClient()
		let finish!: (value: { ok: true }) => void
		const options = createPageQuery(
			kind === 'credentials' ? 'loadSecretsPage' : 'loadOrgSettings',
			async (_input: { data: { orgSlug: string }; signal: AbortSignal }) =>
				new Promise<{ ok: true }>((resolve) => {
					finish = resolve
				}),
		)('actor', { orgSlug: 'team' })
		const navigation = ensurePageQuery(client, options, false)
		// Let the page query pass its mutation barrier and begin the transport.
		await Promise.resolve()
		await Promise.resolve()
		if (kind === 'credentials') {
			await invalidateCredentialResources(client, 'actor', 'team')
		} else {
			const mutation = client.getMutationCache().build(
				client,
				orgSettingsMutationOptions(
					client,
					options.queryKey,
					'actor',
					async () => ({ ok: true }),
				),
			)
			await mutation.execute(undefined)
		}
		finish({ ok: true })
		await expect(navigation).resolves.toEqual({ ok: true })
		client.clear()
	},
)
