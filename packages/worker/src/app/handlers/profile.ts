import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { getUserAvatarObject } from '#worker/community/avatar.ts'
import { getCommunityProfileByUsername } from '#worker/community/profile-service.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'
import { listOrganizationsForPerson } from '#worker/orgs/repo.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

/**
 * A non-personal organization has no person profile behind its handle. Its
 * members and grant-only collaborators (the people its org switcher lists)
 * get the organization home there; everyone else gets the 404.
 */
export async function findMemberOrganization(
	env: Env,
	request: Request,
	slug: string,
) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return null
	const organizations = await listOrganizationsForPerson(
		env.APP_DB,
		user.mcpUser.userId,
	)
	return organizations.find((org) => org.slug === slug && !org.personal) ?? null
}

/**
 * Resolve a satori-safe data URI for the profile avatar. PNG and JPEG bytes
 * embed directly; WebP (unsupported by satori) and load failures fall back to
 * a null placeholder so the OG renderer can draw an initial-letter circle.
 */
async function loadProfileOgAvatarDataUri(input: {
	env: Env
	profile: CommunityProfileRecord
}): Promise<string | null> {
	if (!input.profile.avatarKey) return null

	try {
		const object = await getUserAvatarObject({
			env: input.env,
			avatarKey: input.profile.avatarKey,
		})
		if (!object) return null

		const contentType = object.httpMetadata?.contentType ?? ''
		if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
			return null
		}

		const bytes = new Uint8Array(await object.arrayBuffer())
		return `data:${contentType};base64,${bytesToBase64(bytes)}`
	} catch (error) {
		console.error(
			'profile-og-avatar-load-failed',
			input.profile.username,
			error,
		)
		return null
	}
}

export function createProfileOgImageHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { username: string }
	}) => {
		const profile = await getCommunityProfileByUsername({
			env,
			username: params.username,
			includePrivate: false,
		})
		if (!profile) {
			return new Response('Not found', { status: 404 })
		}

		const avatarDataUri = await loadProfileOgAvatarDataUri({ env, profile })
		// `?theme=light` renders the pale variant; anything unrecognised
		// falls back to the default rather than erroring.
		const theme = parseOgTheme(new URL(request.url).searchParams.get('theme'))

		// Lazy import (sanctioned exception to the no-inline-imports rule):
		// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
		// binaries, which would otherwise bloat isolate cold starts for a
		// route that is only hit by social-media crawlers.
		const { renderProfileOgImage } =
			await import('#worker/community/profile-og-image.ts')
		const png = await renderProfileOgImage({
			displayName: profile.displayName,
			username: profile.username,
			bio: profile.bio,
			publicPackageCount: profile.publicPackageCount,
			listingCount: profile.listingCount,
			avatarDataUri,
			theme,
			assets: env.ASSETS,
		})

		return new Response(png, {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=3600',
				'Content-Type': 'image/png',
			},
		})
	}
}
