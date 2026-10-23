import { type DatabaseSync } from 'node:sqlite'

export function withCachedMigrations(actual: {
	applyAllMigrations: (sqlite: DatabaseSync, directory: URL) => void
}) {
	const images = new Map<string, Uint8Array>()
	return {
		...actual,
		applyAllMigrations(sqlite: DatabaseSync, directory: URL) {
			const image = images.get(directory.href)
			if (image) {
				sqlite.deserialize(image)
			} else {
				actual.applyAllMigrations(sqlite, directory)
				images.set(directory.href, sqlite.serialize())
			}
		},
	}
}
