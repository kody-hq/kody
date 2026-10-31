function registrationIdentity(identity) {
	if (!identity.user?.email)
		throw new Error(
			'Use Machine > Sign in to CLI before registering this machine.',
		)
	if (
		!Array.isArray(identity.scope) ||
		!identity.scope.includes('execution_context:create')
	) {
		throw new Error(
			'Use Machine > Sign in to CLI again. This CLI login does not have permission to register execution contexts.',
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
