const assert = require('node:assert/strict')
const { test } = require('node:test')
const { registrationIdentity } = require('../registration-identity.cjs')
test('registration confirmation identifies the CLI account and org without dumping token scopes', () => {
	assert.equal(
		registrationIdentity({
			user: { displayName: 'Sam', email: 'sam@example.com' },
			org: 'sam',
			scope: ['execution_context:create', 'secret:use'],
		}),
		'Sam <sam@example.com>\nOrganization: @sam',
	)
})
test('older CLI logins must sign in again before registering a device', () => {
	assert.throws(
		() =>
			registrationIdentity({
				user: { email: 'sam@example.com' },
				scope: ['org:read'],
			}),
		/Sign in to CLI again/,
	)
	assert.throws(() => registrationIdentity({}), /Sign in to CLI before/)
})
