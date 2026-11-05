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
const windows = new Map()
let lastWindow
let windowOpening
let pendingWindows = 0
function currentWindow() {
	const focused = BrowserWindow.getFocusedWindow()
	return windows.has(focused) ? focused : lastWindow
}
function navigationFor(event) {
	const window = BrowserWindow.fromWebContents(event.sender)
	const navigation = windows.get(window)?.navigation
	return navigation?.accepts(event) ? navigation : undefined
}
ipcMain.handle('kody:navigation', (event, command) => {
	const navigation = navigationFor(event)
	if (!navigation)
		throw new Error('Navigation is only available to the main Kody document.')
	return navigation.command(command)
})
let loginAttempt
let loginWindow
ipcMain.handle('kody:authentication', async (event, mode) => {
	if (!navigationFor(event))
		throw new Error('Sign-in is only available to the main Kody document.')
	const window = BrowserWindow.fromWebContents(event.sender)
	if (mode === 'cancel') {
		if (loginWindow === window) loginAttempt?.cancel()
		return
	}
	if (mode !== 'login' && mode !== 'signup')
		throw new Error('Invalid sign-in action.')
	if (loginAttempt) return { error: 'Browser sign-in is already open.' }
	loginWindow = window
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
		if (!quitting && !window.isDestroyed()) await showApp('/account', window)
		return {}
	} catch (error) {
		if (error.message === 'Browser sign-in canceled.') return {}
		return { error: error.message }
	} finally {
		loginAttempt = null
		loginWindow = null
	}
})
const runner = new Runner()
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
		const registered = !!state.ecid
		state = next
		saveState()
		if (registered !== !!state.ecid && app.isReady() && !quitting) updateMenu()
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
	if (!navigationFor(event))
		throw new Error(
			'Machine controls are only available to the main Kody document.',
		)
	if (quitting) throw new Error('Kody is quitting.')
	return execution.request(command, input)
})
let machineMenuCommand = null
ipcMain.handle('kody:machine-menu', (event) => {
	if (!navigationFor(event)) return null
	const command = machineMenuCommand
	machineMenuCommand = null
	return command
})
function machinePath() {
	const orgSlug = execution.read().owner?.orgSlug
	return orgSlug ? `/@${orgSlug}/-/execution-contexts` : '/account'
}
async function machineMenu(command) {
	if (quitting) return
	if (command === 'pause') {
		const { response } = await dialog.showMessageBox({
			type: 'question',
			message: 'Pause routing to this machine?',
			detail:
				'Kody keeps it paused until you resume it, even while this machine is offline. Chains skip it, queued runs fail, and host commands are refused. The runner stays connected.',
			buttons: ['Pause routing', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
		})
		if (response !== 0 || quitting) return
	}
	machineMenuCommand = command
	const window = await showApp(machinePath())
	window?.webContents.send('kody:machine-menu')
}
async function machineRunner(command) {
	try {
		await execution.request(command)
	} catch (error) {
		if (!quitting) dialog.showErrorBox('Kody runner', error.message)
	}
}
function updateMenu() {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
			{
				label: 'File',
				submenu: [
					{
						label: 'New Window',
						accelerator: 'CmdOrCtrl+N',
						click: () => void newWindow(),
					},
					{ role: 'close' },
				],
			},
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
						click: () =>
							windows.get(currentWindow())?.navigation.command('back'),
					},
					{
						label: 'Forward',
						accelerator: 'CmdOrCtrl+]',
						click: () =>
							windows.get(currentWindow())?.navigation.command('forward'),
					},
					{
						label: 'Home',
						accelerator: 'CmdOrCtrl+Shift+H',
						click: () => showApp('/account'),
					},
					{
						label: 'Copy page address',
						accelerator: 'CmdOrCtrl+Shift+C',
						click: () =>
							windows.get(currentWindow())?.navigation.command('copy-address'),
					},
				],
			},
			...(state.ecid
				? [
						{
							label: 'Machine',
							submenu: [
								{
									label: 'This machine',
									click: () => void showApp(machinePath()),
								},
								{ type: 'separator' },
								{
									label: 'Pause routing in Kody…',
									click: () => void machineMenu('pause'),
								},
								{
									label: 'Resume routing in Kody',
									click: () => void machineMenu('resume'),
								},
								{ type: 'separator' },
								{
									label: 'Start runner',
									click: () => void machineRunner('start'),
								},
								{
									label: 'Stop runner',
									click: () => void machineRunner('stop'),
								},
								{
									label: 'Restart runner',
									click: () => void machineRunner('restart'),
								},
								{
									label: 'Update runner now',
									click: () => void machineMenu('update'),
								},
								{
									label: 'Show runner log',
									click: () => void machineMenu('logs'),
								},
							],
						},
					]
				: []),
			{ role: 'viewMenu' },
			{ role: 'windowMenu' },
		]),
	)
}
async function showApp(path, window = currentWindow()) {
	if (quitting) return
	if (!window || window.isDestroyed()) {
		const creating = !windowOpening
		if (creating) windowOpening = createWindow(path)
		try {
			window = await windowOpening
		} finally {
			windowOpening = null
		}
		// createWindow owns the initial navigation for all overlapping launches.
		if (creating) return window
	}
	if (!quitting && window && !window.isDestroyed()) showWindow(window, path)
	return window
}
function quitWithoutWindows() {
	if (process.platform !== 'darwin' && !windows.size && !pendingWindows)
		app.quit()
}
async function newWindow(path) {
	if (quitting) return
	pendingWindows++
	try {
		return await createWindow(path)
	} catch (error) {
		if (!quitting)
			dialog.showErrorBox('Could not open Kody window', error.message)
	} finally {
		pendingWindows--
		if (!quitting) quitWithoutWindows()
	}
}
function showWindow(window, path) {
	const record = windows.get(window)
	if (!record || quitting) return
	if (window.isMinimized()) window.restore()
	window.show()
	window.focus()
	const crashed = window.webContents.isCrashed()
	if (!path && !crashed && !record.failedLoadUrl) return
	const url = path
		? `${appOrigin}${path}`
		: record.failedLoadUrl ||
			window.webContents.getURL() ||
			`${appOrigin}/account`
	record.failedLoadUrl = undefined
	void window.loadURL(url).catch((error) => {
		// A newer navigation can cancel this load without failing the page.
		if (!quitting && !window.isDestroyed() && error.code !== 'ERR_ABORTED') {
			record.failedLoadUrl = url
			dialog.showErrorBox('Could not load Kody', error.message)
		}
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
async function createWindow(path = '/account') {
	const [integratedTitlebar, browserAuthentication] = await Promise.all([
		process.platform === 'darwin'
			? supportsIntegratedTitlebar(appOrigin, net.fetch)
			: false,
		supportsBrowserLogin(),
	])
	if (quitting) return
	const window = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		title: 'Kody',
		icon: join(__dirname, 'assets/icon.png'),
		...(integratedTitlebar
			? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 13 } }
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
	const navigation = attachWindowNavigation(window, {
		appOrigin,
		clipboard,
		shell,
		integratedTitlebar,
	})
	const record = { navigation, failedLoadUrl: undefined }
	windows.set(window, record)
	lastWindow = window
	window.on('focus', () => {
		lastWindow = window
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
			void newWindow(
				new URL(url).pathname + new URL(url).search + new URL(url).hash,
			)
		else external(url)
		return { action: 'deny' }
	})
	window.on('close', (event) => {
		if (process.platform === 'darwin' && !quitting && windows.size === 1) {
			event.preventDefault()
			window.hide()
		}
	})
	window.webContents.on(
		'did-fail-load',
		(_event, errorCode, _description, url, isMainFrame) => {
			// Chromium uses -3 (ERR_ABORTED) for canceled navigation.
			if (
				isMainFrame &&
				errorCode !== -3 &&
				(isCurrentAppUrl(url) || isNavigationUrl(url))
			)
				record.failedLoadUrl = url
		},
	)
	window.webContents.on('did-finish-load', () => {
		record.failedLoadUrl = undefined
	})
	window.on('closed', () => {
		windows.delete(window)
		if (lastWindow === window) lastWindow = Array.from(windows.keys()).at(-1)
		if (loginWindow === window) loginAttempt?.cancel()
	})
	showWindow(window, path)
	return window
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
	app.on('activate', () => showApp())
	app.on('window-all-closed', quitWithoutWindows)
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
