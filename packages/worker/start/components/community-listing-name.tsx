/** @jsxImportSource @emotion/react */

/** @jsxRuntime automatic */

/**
 * "@scope/name" breaks after the scope slash so a long package name wraps
 * where it reads best instead of overflowing a narrow card or feed row.
 */
export function renderCommunityListingName(name: string) {
	const slashIndex = name.indexOf('/')
	if (!name.startsWith('@') || slashIndex < 0) return name
	return (
		<>
			{name.slice(0, slashIndex + 1)}
			<wbr />
			{name.slice(slashIndex + 1)}
		</>
	)
}
