/** @jsxImportSource @emotion/react */

/** @jsxRuntime automatic */

import { type PublicCommunityListing } from '#universal/community-public-types.ts'
import { IdentityIconMark } from './identity-icon-mark.tsx'

type CommunityListingIconProps = {
	listing: Pick<PublicCommunityListing, 'iconUrl' | 'name'>
	size: 'card' | 'starter' | 'detail'
}

/**
 * Per-package icon in a rounded well (the prototype's `.pkg-icon` /
 * `.pkg-icon-lg` grammar). The image is served per pinned commit by the
 * community icon endpoint, which already falls back to a rendered initial
 * when a package publishes no icon — so the well always has a photo to fill.
 * The well is a fixed white plate so dark or colorful marks stay readable in
 * both light and dark UI themes.
 */
export function CommunityListingIcon(props: CommunityListingIconProps) {
	const { listing, size } = props
	return (
		<IdentityIconMark
			name={listing.name}
			iconUrl={listing.iconUrl}
			size={size}
			testId={`community-listing-icon-${size}`}
		/>
	)
}
