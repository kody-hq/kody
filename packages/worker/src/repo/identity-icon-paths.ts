/**
 * Repo/list identity mark paths. Canonical file is `.kody/icon.png`; other
 * `.kody/icon.*` extensions, root `icon.*`, and root `community-icon.*` are
 * permanent aliases. Package apps may fall back to `icons/icon-192.png`.
 *
 * Within each group the first existing file wins: svg, png, webp, jpg, jpeg.
 */

export const identityIconExtensions = [
	'svg',
	'png',
	'webp',
	'jpg',
	'jpeg',
] as const

export type IdentityIconExtension = (typeof identityIconExtensions)[number]

function iconPathsForStem(stem: string) {
	return identityIconExtensions.map(
		(extension) => `${stem}.${extension}` as const,
	)
}

export const kodyIdentityIconPaths = iconPathsForStem('.kody/icon')
export const legacyRootIconPaths = iconPathsForStem('icon')
export const legacyCommunityIconPaths = iconPathsForStem('community-icon')
export const packageAppIdentityIconPath = 'icons/icon-192.png' as const

export const identityIconAliasPaths = [
	...kodyIdentityIconPaths,
	...legacyRootIconPaths,
	...legacyCommunityIconPaths,
] as const

export const identityIconSourcePaths = [
	...identityIconAliasPaths,
	packageAppIdentityIconPath,
] as const

export type IdentityIconSourcePath = (typeof identityIconSourcePaths)[number]

export function isIdentityIconSourcePath(
	path: string,
): path is IdentityIconSourcePath {
	return identityIconSourcePaths.some((candidate) => candidate === path)
}

export function findIdentityIconPath(
	files: Readonly<Record<string, string>>,
	options?: { includePackageAppIcon?: boolean },
): IdentityIconSourcePath | null {
	const paths = options?.includePackageAppIcon
		? identityIconSourcePaths
		: identityIconAliasPaths
	return paths.find((path) => path in files) ?? null
}

export {
	identityIconLeafName,
	identityIconMonogramLetter,
} from '#universal/identity-icon-leaf.ts'
