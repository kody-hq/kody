import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createAccountExportManifest } from '#worker/account/export.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'

function buildExportFilename(username: string) {
	const safeUsername = username
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return `kody-account-export-manifest-${safeUsername || 'user'}.json`
}

export function createAccountExportHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			return Response.json(
				{ error: 'Authentication required.' },
				{ status: 401 },
			)
		}
		const manifest = await createAccountExportManifest({
			env,
			dbUserId: user.userId,
			ownerUserId: personalOrgIdForPerson(user.mcpUser),
			personUserId: user.mcpUser.userId,
		})
		const body = JSON.stringify(
			{
				manifest,
				completeExport: {
					manifestCapability: 'accountExportManifest',
					sectionCapability: 'accountExportSection',
					note: 'This browser download is a bounded metadata manifest. Retrieve every section page, including r2_object chunks, through the account MCP export capabilities for a complete portable export.',
				},
			},
			null,
			2,
		)
		return new Response(body, {
			status: 200,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Disposition': `attachment; filename="${buildExportFilename(user.username)}"`,
				'Content-Type': 'application/json; charset=utf-8',
				'X-Kody-Export-Completeness': 'manifest-only',
			},
		})
	}
}
