import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'vitest'
import { packageCredentialsQueryFilter } from './package-credentials-cache.ts'

test('late trigger settlement refreshes only the original actor and package after navigation or lost response', async () => {
	const client = new QueryClient()
	const original = [
		'page',
		'actor-a',
		'loadPackageCredentialsPage',
		{ orgSlug: 'team', kodyId: 'original' },
	]
	const otherPackage = [
		'page',
		'actor-a',
		'loadPackageCredentialsPage',
		{ orgSlug: 'team', kodyId: 'other' },
	]
	const otherActor = [
		'page',
		'actor-b',
		'loadPackageCredentialsPage',
		{ orgSlug: 'team', kodyId: 'original' },
	]
	for (const key of [original, otherPackage, otherActor])
		client.setQueryData(key, { original: true })
	await client.invalidateQueries(
		packageCredentialsQueryFilter({
			actorKey: 'actor-a',
			username: 'team',
			kodyId: 'original',
		}),
	)
	expect(client.getQueryState(original)?.isInvalidated).toBe(true)
	expect(client.getQueryState(otherPackage)?.isInvalidated).toBe(false)
	expect(client.getQueryState(otherActor)?.isInvalidated).toBe(false)
	client.clear()
})
