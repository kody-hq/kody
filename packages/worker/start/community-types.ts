import { type PackageRepoActions } from '#universal/package-repo-actions.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	type PublicCommunityListing,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
export type CommunityDetailApiPayload = {
	ok: true
	repoActions?: PackageRepoActions | null
	listing: PublicCommunityListing | null
	ownerProfilePublic: boolean
	loggedIn: boolean
	viewerIsAdmin: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	viewerCanManageAccess?: boolean
	viewerCanPublish?: boolean
	viewerCanDelete?: boolean
	viewerCanAdoptCommunityFork?: boolean
	forkPrompt: string
	viewerInstall: ViewerListingInstall | null
	readmeContent: string | null
	readmeFences?: Array<HighlightedCode>
	hasAgentsDocs?: boolean
	imageBaseHref?: string | null
	ownerPackage: AccountPackageDetail | null
	hasPackage?: boolean
	packageShaped?: boolean
	username: string
	kodyId: string
	isPrivate: boolean
	invocationUrlOrigin: string
}

export type CommunityInstallApiPayload = {
	ok: boolean
	requiresAcknowledgement?: boolean
	status?: 'installed' | 'adaptation_required'
	packageId?: string
	targetName?: string
	agentPrompt?: string
	failedChecks?: Array<{ kind: string; message: string }>
	error?: string
}

export type CommunityInstallOutcome = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
	packageId: string | null
	failedChecks: Array<{ kind: string; message: string }>
}
