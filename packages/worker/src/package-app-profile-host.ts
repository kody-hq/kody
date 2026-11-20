import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'

/**
 * True when the owner of `{username}.<package-app host>` has a profile package
 * (`@{username}/{username}`) with a published app. That app then owns every
 * path on the host except the platform's reserved `/-/` prefix: no sibling
 * apps, legacy mounts, or platform redirects are served there.
 * Permanent: a platform compatibility setting, not a legacy path.
 */
export async function hasProfilePackageApp(input: {
	env: Env
	username: string
}) {
	const resolved = await resolvePackageAppOauthClient({
		env: input.env,
		username: input.username,
		kodyId: input.username,
	})
	return resolved !== null
}
