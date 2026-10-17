/** @jsxImportSource @emotion/react */
export function FathomTracker({
	siteId,
}: {
	siteId: string | null | undefined
}) {
	return siteId ? (
		<>
			<link rel="preconnect" href="https://cdn.usefathom.com" />
			<script
				src="https://cdn.usefathom.com/script.js"
				data-site={siteId}
				data-spa="auto"
				defer
			/>
		</>
	) : null
}
