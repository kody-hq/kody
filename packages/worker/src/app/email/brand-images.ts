/**
 * Brand images shared by every transactional email. The PNGs under
 * `/images/email/` are rendered at 2x from `sourceSvg` by
 * `tools/generate-email-brand-images.ts`; rerun it after a brand SVG changes.
 */
export type EmailBrandImage = {
	/** Site-relative path of the hosted 2x PNG. */
	src: string
	/** Brand SVG the PNG is rendered from. */
	sourceSvg: string
	/** Displayed CSS size of the whole white plate. */
	width: number
	height: number
	/** Displayed CSS width of the artwork inside the plate. */
	artWidth: number
	/** Corner radius of the plate in CSS pixels. */
	radius: number
}

/** Full light-mode logo (outlined mark plus wordmark) on a white plate. */
export const emailHeaderLogo: EmailBrandImage = {
	src: '/images/email/kody-logo-plate.png',
	sourceSvg: '/images/brand/kody-logo-outlined.svg',
	width: 196,
	height: 92,
	artWidth: 148,
	radius: 12,
}

/** Outlined Kody mark on a white plate, centered at the bottom of the card. */
export const emailFooterMark: EmailBrandImage = {
	src: '/images/email/kody-mark-plate.png',
	sourceSvg: '/images/brand/kody-mark-outlined.svg',
	width: 88,
	height: 74,
	artWidth: 56,
	radius: 12,
}
