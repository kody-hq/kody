const { createRequire } = require('node:module')
const updaterLoad = createRequire(
	require.resolve('electron-updater/package.json'),
)
const { parseDn } = updaterLoad('builder-util-runtime')

// Match the pinned updater: a configured DN checks every named field, while a
// plain publisher name checks CN. Signature trust is checked separately by CI.
function publisherMatches(expected, subject) {
	if (!expected || !subject) return false
	const actual = parseDn(subject)
	const configured = parseDn(expected)
	return configured.size
		? [...configured].every(([key, value]) => actual.get(key) === value)
		: expected === actual.get('CN')
}
if (
	require.main === module &&
	!publisherMatches(
		process.env.EXPECTED_PUBLISHER,
		process.env.ACTUAL_PUBLISHER_SUBJECT,
	)
) {
	throw new Error(
		'Signing certificate does not match DESKTOP_WINDOWS_PUBLISHER.',
	)
}
module.exports = { publisherMatches }
