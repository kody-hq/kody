import { expect, test } from 'vitest'
import { deleteOrgTransferBackupsForOwner } from './backup.ts'

function createBucket(keys: Array<string>, pageSize = 2) {
	const stored = new Set(keys)
	return {
		stored,
		bucket: {
			async list(options: { prefix?: string; cursor?: string }) {
				const all = [...stored]
					.filter((key) => key.startsWith(options.prefix ?? ''))
					.sort()
				const start = Number(options.cursor ?? 0)
				const page = all.slice(start, start + pageSize)
				const truncated = start + pageSize < all.length
				return {
					objects: page.map((key) => ({ key })),
					truncated,
					cursor: truncated ? String(start + pageSize) : undefined,
				} as unknown as R2Objects
			},
			async delete(input: string | Array<string>) {
				for (const key of Array.isArray(input) ? input : [input]) {
					stored.delete(key)
				}
			},
		},
	}
}

test('owner deletion removes backups naming the owner on either side', async () => {
	const { bucket, stored } = createBucket([
		'org-resource-transfers/org-a/org-b/1.json',
		'org-resource-transfers/org-b/org-c/2.json',
		'org-resource-transfers/org-c/org-a/3.json',
		'org-resource-transfers/org-c/org-d/4.json',
		'org-resource-transfers/org-ab/org-c/5.json',
		'other/org-a/6.json',
	])
	expect(
		await deleteOrgTransferBackupsForOwner({ bucket, ownerId: 'org-a' }),
	).toBe(2)
	expect([...stored].sort()).toEqual([
		'org-resource-transfers/org-ab/org-c/5.json',
		'org-resource-transfers/org-b/org-c/2.json',
		'org-resource-transfers/org-c/org-d/4.json',
		'other/org-a/6.json',
	])
})
