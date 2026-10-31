function registrationIdentity(identity) {
	if (!identity.user?.email)
		throw new Error('Sign in to this machine before registering it.')
	if (
		!Array.isArray(identity.scope) ||
		!identity.scope.includes('execution_context:create')
	) {
		throw new Error(
			'Sign in to this machine again. This CLI login does not have permission to register execution contexts.',
		)
	}
	const { displayName, email } = identity.user
	return [
		displayName ? `${displayName} <${email}>` : email,
		identity.org ? `Organization: @${identity.org}` : null,
	]
		.filter(Boolean)
		.join('\n')
}
module.exports = { registrationIdentity }
