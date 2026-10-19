import { landingArtAttrs as originalLandingArtAttrs } from '#universal/landing-images.ts'

/** Public files follow the build namespace, while application URLs stay at root. */
export function publicAsset(path: string): string {
	if (
		!/^\/(?:images|fonts|feature-scenes)\//.test(path) &&
		!/^\/(?:(?:logo(?:-[0-9]+)?\.(?:png|webp)|feature-pages\.css|styles\.css|android-chrome-[0-9]+x[0-9]+\.png|favicon(?:-[^/]+)?\.(?:ico|png)|apple-touch-icon\.png|site\.webmanifest|page-init\.js|emotion-style-hoist\.js))$/.test(
			path,
		)
	)
		return path
	return `${import.meta.env.BASE_URL}${path.slice(1)}`
}

export function publicAssetSrcSet(srcSet: string): string {
	return srcSet.replace(
		/(^|,\s*)(\/images\/[^\s,]+)/g,
		(_match, separator: string, path: string) =>
			`${separator}${publicAsset(path)}`,
	)
}

export function landingArtAttrs(
	name: Parameters<typeof originalLandingArtAttrs>[0],
) {
	const attrs = originalLandingArtAttrs(name)
	return {
		...attrs,
		src: publicAsset(attrs.src),
		srcSet: publicAssetSrcSet(attrs.srcSet),
	}
}
