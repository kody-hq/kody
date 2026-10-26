import { expect, test } from 'vitest'
import {
	buildPublishedPublishChecksKvKey,
	publishChecksVersion,
	publishedPublishChecksAreCurrent,
	readPublishedPublishChecksVersion,
	writePublishedPublishChecksVersion,
} from './published-runtime-artifacts.ts'

test('publish checks version KV key is stable per source and commit', () => {
	expect(
		buildPublishedPublishChecksKvKey({
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).toBe('publish-checks:v1:source-1:abc')
})

test('publishedPublishChecksAreCurrent is true without KV (local/test envs)', async () => {
	await expect(
		publishedPublishChecksAreCurrent({
			env: {} as Env,
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).resolves.toBe(true)
})

test('read/write publish checks version round-trips through KV', async () => {
	const store = new Map<string, string>()
	const env = {
		BUNDLE_ARTIFACTS_KV: {
			async get(key: string, type?: string) {
				const raw = store.get(key)
				if (raw == null) return null
				return type === 'json' ? JSON.parse(raw) : raw
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
		},
	} as unknown as Env

	await expect(
		readPublishedPublishChecksVersion({
			env,
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).resolves.toBeNull()
	await expect(
		publishedPublishChecksAreCurrent({
			env,
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).resolves.toBe(false)

	await writePublishedPublishChecksVersion({
		env,
		sourceId: 'source-1',
		publishedCommit: 'abc',
	})
	await expect(
		readPublishedPublishChecksVersion({
			env,
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).resolves.toBe(publishChecksVersion)
	await expect(
		publishedPublishChecksAreCurrent({
			env,
			sourceId: 'source-1',
			publishedCommit: 'abc',
		}),
	).resolves.toBe(true)
})
