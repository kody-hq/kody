import { usePageCommands } from './context.tsx'
import type { Command } from './model.ts'
import { routes } from '#universal/routes.ts'
import { getPackageSettingsHref } from '#universal/package-files.ts'
import {
	packageCredentialsTabs,
	packageCredentialsTabHref,
	packageCredentialsTabLabel,
} from '#universal/package-credentials-page.ts'
import { packageCollaboratorsHref } from '#universal/package-collaborators.ts'
import { withInstallOrg } from '#universal/community-search.ts'

export function PackageCommands(input: {
	username: string
	kodyId: string
	filesHref: string
	viewerCanManage: boolean
	viewerIsOwner: boolean
	viewerCanManageAccess?: boolean
	hasPackage?: boolean
	installOrg?: string | null
}) {
	const subtitle = `@${input.username}/${input.kodyId}`
	const commands: Command[] = []
	function page(title: string, href: string, keywords?: string) {
		commands.push({
			id: `package:${href}`,
			title,
			subtitle,
			href: withInstallOrg(href, input.installOrg),
			kind: 'page',
			icon: 'box',
			keywords,
		})
	}
	page('Repository overview', routes.communityPackage.href(input))
	page('Browse repository files', input.filesHref, 'source code readme')
	if (input.viewerCanManage)
		page(
			'Repository settings',
			getPackageSettingsHref(input),
			'edit rename visibility delete',
		)
	if (input.viewerCanManageAccess && input.hasPackage !== false)
		page(
			'Manage repository collaborators',
			packageCollaboratorsHref(input),
			'sharing access invite',
		)
	if (input.viewerIsOwner && input.hasPackage !== false)
		for (const tab of packageCredentialsTabs)
			page(
				packageCredentialsTabLabel(tab),
				packageCredentialsTabHref({ ...input, tab }),
			)
	usePageCommands(commands)
	return null
}
