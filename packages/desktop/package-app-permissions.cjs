/**
 * Device permissions for installed package apps. They live on this computer,
 * per installed app and origin, start off, and are asked once: a granted or
 * denied answer stays until the person changes it, across publishes and
 * Kody sign-in or sign-out.
 */
const permissionKinds = Object.freeze([
	'notifications',
	'menuBar',
	'shortcuts',
	'floating',
	'startAtLogin',
])

const permissionLabels = {
	notifications: 'Show notifications',
	menuBar: 'Add an item to the menu bar',
	shortcuts: 'Use keyboard shortcuts anywhere',
	floating: 'Float above other windows',
	startAtLogin: 'Start when you log in',
}

function isPermissionKind(value) {
	return permissionKinds.includes(value)
}

/** 'granted', 'denied', or 'prompt' when the app never asked. */
function permissionState(app, origin, kind) {
	const state = app?.permissions?.[origin]?.[kind]
	return state === 'granted' || state === 'denied' ? state : 'prompt'
}

/**
 * Asks once per app, origin, and kind. Concurrent requests share one native
 * prompt; a known answer resolves without asking.
 */
function createPermissionGate({ store, ask }) {
	const asking = new Map()
	async function request(app, origin, kind) {
		if (!isPermissionKind(kind)) throw new Error('Unknown permission.')
		const current = store.get(app.owner, app.packageName)
		if (!current) return 'denied'
		const known = permissionState(current, origin, kind)
		if (known !== 'prompt') return known
		const key = `${app.owner}/${app.packageName} ${origin} ${kind}`
		if (!asking.has(key)) {
			asking.set(
				key,
				Promise.resolve(ask(current, origin, kind))
					.then((allowed) => {
						const state = allowed ? 'granted' : 'denied'
						store.setPermission(app.owner, app.packageName, origin, kind, state)
						return state
					})
					.finally(() => asking.delete(key)),
			)
		}
		return asking.get(key)
	}
	return { request }
}

module.exports = {
	createPermissionGate,
	permissionKinds,
	permissionLabels,
	permissionState,
}
