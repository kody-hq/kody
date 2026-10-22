/**
 * Handles (the `@slug` in `kody.codes/@slug`) are permanent for every
 * organization, personal and team alike. Every surface that picks or edits a
 * handle shows the same words so people choose deliberately.
 */

export const handlePermanentNote =
	'Handles are permanent and cannot be changed later.'

/** Short permanence line for signup username fields. */
export const signupUsernamePermanentNote = "You can't change this later."

/** Where the signup username appears after account creation. */
export const signupUsernameSurfacesNote =
	'It appears in package names, {username}.kody.run URLs, and your {username}@ email address.'

export const orgSlugPermanentError =
	'Organization handles are permanent and cannot be changed. You can change the display name instead.'

export const usernamePermanentError =
	'Usernames are permanent and cannot be changed. You can change your display name instead.'

export function handleUrlPreview(slug: string) {
	return `kody.codes/@${slug}`
}

export function handlePackageAppUrlPreview(slug: string) {
	return `${slug}.kody.run`
}

export function handleEmailLocalPreview(slug: string) {
	return `${slug}@`
}

export function signupUsernameSurfacesPreview(slug: string) {
	const handle = slug.trim().toLowerCase() || 'your-username'
	return `It appears in package names, ${handle}.kody.run URLs, and your ${handle}@ email address.`
}

export function handlePermanenceConfirmMessage(slug: string) {
	const handle = slug.trim().toLowerCase() || 'your-username'
	return `You're choosing ${handle}. You can't change this later. Submit again to create your account.`
}
