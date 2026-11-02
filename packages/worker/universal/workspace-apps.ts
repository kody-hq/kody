import { type PublicProfilePackageItem } from './community-public-types.ts'

export function filterWorkspaceApps<T extends PublicProfilePackageItem>(
	apps: ReadonlyArray<T>,
	options: { query: string; visibility: string; sort: string },
): Array<T> {
	const search = options.query.trim().toLocaleLowerCase()
	return apps
		.filter(
			(app) =>
				(!search ||
					`${app.name} ${app.description} ${app.tags.join(' ')}`
						.toLocaleLowerCase()
						.includes(search)) &&
				(options.visibility === 'all' ||
					(options.visibility === 'private' ? app.isPrivate : !app.isPrivate)),
		)
		.sort((a, b) =>
			options.sort === 'name'
				? a.name.localeCompare(b.name)
				: (options.sort === 'created'
						? b.createdAt.localeCompare(a.createdAt)
						: b.updatedAt.localeCompare(a.updatedAt)) ||
					a.name.localeCompare(b.name),
		)
}
