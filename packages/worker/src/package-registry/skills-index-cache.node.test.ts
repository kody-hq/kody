import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	buildPackageSkillsIndex,
	type PackageSkillsIndex,
} from './package-skills.ts'
import {
	buildPackageSkillsIndexKey,
	deleteAllPackageSkillsIndexEntriesForUser,
	hasPackageSkillsKv,
	readPackageSkillsIndex,
	removePackageSkillsIndexEntries,
	writePackageSkillsIndex,
} from './skills-index-cache.ts'

function createEnv(kv?: KVNamespace) {
	return { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
}

function emptyIndex(overrides?: Partial<PackageSkillsIndex>) {
	return {
		...buildPackageSkillsIndex({
			packageId: 'pkg-1',
			kodyId: '@owner/slug',
			publishedCommit: 'commit-1',
			skills: [],
		}),
		...overrides,
	}
}

test('writes and reads an index keyed by user, package, and commit', async () => {
	const { kv, store } = createMemoryKvNamespace()
	const env = createEnv(kv)
	const index = emptyIndex()
	await writePackageSkillsIndex({
		env,
		userId: ownerIdFromStored('user-1'),
		index,
	})
	expect([...store.keys()]).toEqual([
		'package-skills-index:v1:user-1:pkg-1:commit-1',
	])
	await expect(
		readPackageSkillsIndex({
			env,
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
		}),
	).resolves.toEqual({
		version: 1,
		packageId: 'pkg-1',
		kodyId: '@owner/slug',
		publishedCommit: 'commit-1',
		skills: [],
	})
})

test('read returns null for missing, other-user, and malformed entries', async () => {
	const { kv, store } = createMemoryKvNamespace()
	const env = createEnv(kv)
	await writePackageSkillsIndex({
		env,
		userId: ownerIdFromStored('user-1'),
		index: emptyIndex(),
	})
	const base = { env, packageId: 'pkg-1', publishedCommit: 'commit-1' }
	expect(
		await readPackageSkillsIndex({
			...base,
			userId: ownerIdFromStored('user-2'),
		}),
	).toBeNull()
	expect(
		await readPackageSkillsIndex({
			...base,
			userId: ownerIdFromStored('user-1'),
			publishedCommit: 'commit-2',
		}),
	).toBeNull()
	store.set(
		buildPackageSkillsIndexKey({
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({ version: 2, packageId: 'pkg-1' }),
	)
	expect(
		await readPackageSkillsIndex({
			...base,
			userId: ownerIdFromStored('user-1'),
		}),
	).toBeNull()
})

test('remove deletes every commit for one package only', async () => {
	const { kv, store } = createMemoryKvNamespace()
	const env = createEnv(kv)
	for (const [packageId, publishedCommit] of [
		['pkg-1', 'commit-1'],
		['pkg-1', 'commit-2'],
		['pkg-2', 'commit-1'],
	] as const) {
		await writePackageSkillsIndex({
			env,
			userId: ownerIdFromStored('user-1'),
			index: emptyIndex({ packageId, publishedCommit }),
		})
	}
	await removePackageSkillsIndexEntries({
		env,
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
	})
	expect([...store.keys()]).toEqual([
		'package-skills-index:v1:user-1:pkg-2:commit-1',
	])
})

test('remove pages through large key sets', async () => {
	const { kv, store } = createMemoryKvNamespace()
	const env = createEnv(kv)
	for (let index = 0; index < 1100; index += 1) {
		store.set(`package-skills-index:v1:user-1:pkg-1:commit-${index}`, '{}')
	}
	await removePackageSkillsIndexEntries({
		env,
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
	})
	expect(store.size).toBe(0)
})

test('deleteAll removes only the target user entries', async () => {
	const { kv, store } = createMemoryKvNamespace()
	const env = createEnv(kv)
	await writePackageSkillsIndex({
		env,
		userId: ownerIdFromStored('user-1'),
		index: emptyIndex(),
	})
	await writePackageSkillsIndex({
		env,
		userId: ownerIdFromStored('user-10'),
		index: emptyIndex(),
	})
	await expect(
		deleteAllPackageSkillsIndexEntriesForUser({
			env,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBe(1)
	expect([...store.keys()]).toEqual([
		'package-skills-index:v1:user-10:pkg-1:commit-1',
	])
})

test('missing KV binding: write throws, read and remove no-op', async () => {
	const env = createEnv(undefined)
	expect(hasPackageSkillsKv(env)).toBe(false)
	await expect(
		writePackageSkillsIndex({
			env,
			userId: ownerIdFromStored('user-1'),
			index: emptyIndex(),
		}),
	).rejects.toThrow(/BUNDLE_ARTIFACTS_KV/)
	await expect(
		readPackageSkillsIndex({
			env,
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
		}),
	).resolves.toBeNull()
	await expect(
		removePackageSkillsIndexEntries({
			env,
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
		}),
	).resolves.toBeUndefined()
	await expect(
		deleteAllPackageSkillsIndexEntriesForUser({
			env,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toBe(0)
})

test('retains publication attribution when a same-commit index is rebuilt', async () => {
	const { kv } = createMemoryKvNamespace()
	const env = createEnv(kv)
	const input = {
		env,
		userId: 'user-1',
		index: emptyIndex({
			publishedBy: 'casey',
			publishedAt: '2026-10-28T12:00:00Z',
		}),
	}
	await writePackageSkillsIndex(input)
	await writePackageSkillsIndex({
		...input,
		index: emptyIndex({
			publishedBy: 'rebuilder',
			publishedAt: '2026-10-29T12:00:00Z',
		}),
	})
	expect(
		await readPackageSkillsIndex({
			env,
			userId: 'user-1',
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
		}),
	).toMatchObject({ publishedBy: 'casey', publishedAt: '2026-10-28T12:00:00Z' })
})
