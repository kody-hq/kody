const {
	app,
	BrowserWindow,
	Menu,
	dialog,
	shell,
	ipcMain,
	clipboard,
	session,
	net,
} = require('electron')
const { startUpdates, finishQuit } = require('./updates.cjs')
const { browserLogin } = require('./browser-login.cjs')
const { parseString } = require('set-cookie-parser')
const { supportsIntegratedTitlebar } = require('./site-capabilities.cjs')
const { attachWindowNavigation } = require('./window-navigation.cjs')
const {
	readFileSync,
	writeFileSync,
	mkdirSync,
	renameSync,
} = require('node:fs')
const { hostname } = require('node:os')
const { join } = require('node:path')
const { Runner } = require('./runner.cjs')
const { DesktopExecution } = require('./execution.cjs')
const {
	appOrigin: productionOrigin,
	isExternalUrl,
	isNavigationUrl,
} = require('./navigation.cjs')

app.setName('Kody')
let appOrigin = productionOrigin
const developmentUrl = process.argv
	.find((arg) => arg.startsWith('--app-url='))
	?.slice('--app-url='.length)
if (developmentUrl && !app.isPackaged) {
	const url = new URL(developmentUrl)
	if (
		!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
		!['http:', 'https:'].includes(url.protocol)
	)
		throw new Error('Development app URL must be a loopback origin.')
	appOrigin = url.origin
}
function isCurrentAppUrl(value) {
	try {
		return new URL(value).origin === appOrigin
	} catch {
		return false
	}
}
let navigation
let windowOpening
ipcMain.handle('kody:navigation', (event, command) => {
	if (!navigation?.accepts(event))
		throw new Error('Navigation is only available to the main Kody document.')
	return navigation.command(command)
})
let loginAttempt
ipcMain.handle('kody:authentication', async (event, mode) => {
	if (!navigation?.accepts(event))
		throw new Error('Sign-in is only available to the main Kody document.')
	if (mode === 'cancel') {
		loginAttempt?.cancel()
		return
	}
	if (mode !== 'login' && mode !== 'signup')
		throw new Error('Invalid sign-in action.')
	if (loginAttempt) return { error: 'Browser sign-in is already open.' }
	const targetSession = window.webContents.session
	loginAttempt = browserLogin({
		origin: appOrigin,
		mode,
		openExternal: (url) => shell.openExternal(url),
		exchange: async (data) => {
			const response = await fetch(`${appOrigin}/desktop/session`, {
				method: 'POST',
				redirect: 'error',
				credentials: 'omit',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: data.code, verifier: data.verifier }),
				signal: AbortSignal.any([data.signal, AbortSignal.timeout(20_000)]),
			})
			if (response.status !== 204) throw new Error('Sign-in failed.')
			const cookies = response.headers
				.getSetCookie()
				.map((value) => parseString(value, { decodeValues: false }))
			const cookie = cookies.find((cookie) => cookie.name === 'kody_session')
			if (
				!cookie ||
				!cookie.httpOnly ||
				cookie.domain ||
				cookie.path !== '/' ||
				(appOrigin.startsWith('https:') && !cookie.secure)
			)
				throw new Error('Invalid sign-in session.')
			data.signal.throwIfAborted()
			await targetSession.cookies.set({
				url: appOrigin,
				name: cookie.name,
				value: cookie.value,
				path: '/',
				httpOnly: true,
				secure: !!cookie.secure,
				sameSite: 'lax',
				expirationDate: cookie.maxAge
					? Date.now() / 1000 + cookie.maxAge
					: cookie.expires?.getTime() / 1000,
			})
		},
	})
	try {
		await loginAttempt.result
		if (!quitting) {
			await showApp('/account')
			window.focus()
		}
		return {}
	} catch (error) {
		if (error.message === 'Browser sign-in canceled.') return {}
		return { error: error.message }
	} finally {
		loginAttempt = null
	}
})
const runner = new Runner()
let window
let quitting = false
let updates
let restartForUpdate = false
let state = { ecid: null, enabled: false }
function statePath() {
	return join(app.getPath('userData'), 'machine.json')
}
function saveState() {
	mkdirSync(app.getPath('userData'), { recursive: true })
	const temporary = `${statePath()}.tmp`
	writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
	renameSync(temporary, statePath())
}
function loadState() {
	try {
		const saved = JSON.parse(readFileSync(statePath(), 'utf8'))
		const ecid =
			typeof saved.ecid === 'string' && /^ec_[A-Za-z0-9_-]+$/.test(saved.ecid)
				? saved.ecid
				: null
		state = {
			ecid,
			name: typeof saved.name === 'string' ? saved.name : undefined,
			enabled: !!ecid && saved.enabled === true,
			owner:
				saved.owner &&
				typeof saved.owner.username === 'string' &&
				typeof saved.owner.orgSlug === 'string'
					? { username: saved.owner.username, orgSlug: saved.owner.orgSlug }
					: null,
			onboardingSeen: Array.isArray(saved.onboardingSeen)
				? saved.onboardingSeen.filter((value) => typeof value === 'string')
				: [],
		}
	} catch (error) {
		if (error.code !== 'ENOENT')
			throw new Error(
				`Could not read desktop machine settings: ${error.message}`,
			)
	}
}
const execution = new DesktopExecution({
	runner,
	read: () => state,
	write: (next) => {
		state = next
		saveState()
	},
	hostname: hostname(),
	confirmCommands: async () => {
		const { response } = await dialog.showMessageBox({
			type: 'warning',
			message: 'Allow Kody runs to run commands on this machine?',
			detail:
				'Runs on this machine that have the command grant (you, and anyone you explicitly share host commands with) can run any shell command as your user account, with no approval per command: install software, read and change your files, use your network. Every command is recorded in the context audit log. Turn it off here, with `kody context commands off`, or on the website.',
			buttons: ['Allow commands', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
		})
		return response === 0 && !quitting
	},
	viewer: async () => {
		const response = await session
			.fromPartition('persist:kody')
			.fetch(`${appOrigin}/session`, {
				credentials: 'include',
				redirect: 'error',
				cache: 'no-store',
				signal: AbortSignal.timeout(10000),
			})
		if (!response.ok)
			throw new Error('Could not verify your Kody account. Try again.')
		const result = await response.json()
		if (!result.ok || !result.session) return null
		const person = result.session
		const personal = person.organizations?.find((org) => org.personal)
		if (!person.emailVerified || !personal) return null
		if (
			typeof person.username !== 'string' ||
			typeof person.email !== 'string' ||
			!/^[a-zA-Z0-9_-]+$/.test(personal.slug)
		)
			throw new Error('Could not verify this workspace.')
		return {
			username: person.username,
			email: person.email,
			orgSlug: personal.slug,
		}
	},
})
ipcMain.handle('kody:execution', (event, command, input) => {
	if (!navigation?.accepts(event))
		throw new Error(
			'Machine controls are only available to the main Kody document.',
		)
	if (quitting) throw new Error('Kody is quitting.')
	return execution.request(command, input)
})
function updateMenu() {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
			{ label: 'File', submenu: [{ role: 'close' }] },
			...(updates
				? [
						{
							label: 'Updates',
							submenu: [
								{
									label: 'Check for updates…',
									enabled: !!updates && !quitting,
									click: () => void updates.check(),
								},
								{
									label: 'Restart to update',
									enabled: !!updates?.downloaded && !quitting,
									click: () => {
										restartForUpdate = true
										app.quit()
									},
								},
							],
						},
					]
				: []),
			{ role: 'editMenu' },
			{
				label: 'Navigate',
				submenu: [
					{
						label: 'Back',
						accelerator: 'CmdOrCtrl+[',
						click: () => navigation?.command('back'),
					},
					{
						label: 'Forward',
						accelerator: 'CmdOrCtrl+]',
						click: () => navigation?.command('forward'),
					},
					{
						label: 'Home',
						accelerator: 'CmdOrCtrl+Shift+H',
						click: () => showApp('/account'),
					},
					{
						label: 'Copy page address',
						accelerator: 'CmdOrCtrl+Shift+C',
						click: () => navigation?.command('copy-address'),
					},
				],
			},
			{ role: 'viewMenu' },
			{ role: 'windowMenu' },
		]),
	)
}
async function showApp(path) {
	const creating = !window || window.isDestroyed()
	if (creating) {
		windowOpening ??= createWindow()
		try {
			await windowOpening
		} finally {
			windowOpening = null
		}
	}
	if (quitting || !window || window.isDestroyed()) return
	window.show()
	window.focus()
	if (!creating && !path) return
	const shownWindow = window
	void shownWindow
		.loadURL(`${appOrigin}${path ?? '/account'}`)
		.catch((error) => {
			if (!quitting && !shownWindow.isDestroyed())
				dialog.showErrorBox('Could not load Kody', error.message)
		})
}
async function supportsBrowserLogin() {
	try {
		const response = await net.fetch(`${appOrigin}/login`, {
			method: 'HEAD',
			redirect: 'manual',
			signal: AbortSignal.timeout(5000),
		})
		return (
			response.ok &&
			response.headers.get('X-Kody-Desktop-Authentication') === '1'
		)
	} catch {
		return false
	}
}
async function createWindow() {
	const [integratedTitlebar, browserAuthentication] = await Promise.all([
		process.platform === 'darwin'
			? supportsIntegratedTitlebar(appOrigin, net.fetch)
			: false,
		supportsBrowserLogin(),
	])
	if (quitting) return
	window = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		title: 'Kody',
		icon: join(__dirname, 'assets/icon.png'),
		...(integratedTitlebar
			? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 15 } }
			: {}),
		backgroundColor: '#ffffff',
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
			webviewTag: false,
			partition: 'persist:kody',
			preload: join(__dirname, 'preload.cjs'),
			additionalArguments: [
				`--kody-app-origin=${appOrigin}`,
				...(browserAuthentication ? ['--kody-browser-login'] : []),
			],
		},
	})
	navigation = attachWindowNavigation(window, {
		appOrigin,
		clipboard,
		shell,
		integratedTitlebar,
	})
	window.webContents.session.setPermissionRequestHandler(
		(contents, permission, callback, details) => {
			callback(
				permission === 'clipboard-sanitized-write' &&
					details.isMainFrame &&
					isCurrentAppUrl(details.requestingUrl) &&
					isCurrentAppUrl(contents.getURL()),
			)
		},
	)
	window.webContents.session.setPermissionCheckHandler(
		(contents, permission, origin, details) =>
			permission === 'clipboard-sanitized-write' &&
			details.isMainFrame &&
			isCurrentAppUrl(origin) &&
			!!contents &&
			isCurrentAppUrl(contents.getURL()),
	)
	window.webContents.on('will-attach-webview', (event) =>
		event.preventDefault(),
	)
	function external(url) {
		if (isExternalUrl(url))
			void shell
				.openExternal(url)
				.catch((error) =>
					dialog.showErrorBox('Could not open link', error.message),
				)
	}
	window.webContents.on('will-navigate', (event, url) => {
		if (!isCurrentAppUrl(url) && !isNavigationUrl(url)) {
			event.preventDefault()
			external(url)
		}
	})
	window.webContents.on('will-redirect', (event, url) => {
		if (!isCurrentAppUrl(url) && !isNavigationUrl(url)) {
			event.preventDefault()
			external(url)
		}
	})
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isCurrentAppUrl(url))
			showApp(new URL(url).pathname + new URL(url).search + new URL(url).hash)
		else external(url)
		return { action: 'deny' }
	})
	window.on('closed', () => {
		window = null
		navigation = null
	})
}
runner.on('change', () => {
	if (app.isReady() && !quitting) updateMenu()
})
runner.on('ended', () => {
	execution.error = 'The runner stopped unexpectedly. Start it again.'
})
runner.on('shutdown-error', () => {
	execution.error = 'Could not stop the runner. Quit Kody and try again.'
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
	app.on('second-instance', () => showApp())
	app.on('activate', () => {
		if (!window) showApp()
	})
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit()
	})
	app.on('before-quit', (event) => {
		loginAttempt?.cancel()
		if (quitting) return
		event.preventDefault()
		quitting = true
		updates?.stop()
		void finishQuit({ runner, updates, app, restart: restartForUpdate }).catch(
			(error) => {
				dialog.showErrorBox('Could not quit Kody', error.message)
				app.exit(1)
			},
		)
	})
	app
		.whenReady()
		.then(async () => {
			if (process.platform === 'darwin')
				app.dock.setIcon(join(__dirname, 'assets/icon.png'))
			updates = startUpdates({
				app,
				updater: require('electron-updater').autoUpdater,
				dialog,
				changed: updateMenu,
			})
			loadState()
			updateMenu()
			await showApp()
			if (!quitting) void execution.request('state').catch(() => {})
		})
		.catch((error) => {
			dialog.showErrorBox('Could not start Kody', error.message)
			app.quit()
		})
}
