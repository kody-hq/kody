// Registration names are 1-63 lowercase letters, digits, or dashes. macOS
// hostnames commonly include capitals and a .local suffix.
function machineName(hostname) {
	return (
		hostname
			.replace(/\.local$/i, '')
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 63) || 'my-machine'
	)
}
module.exports = { machineName }
