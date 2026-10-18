import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
	isChromeExtensionMessageChannelDisconnectedError,
	isTanStackServerFnFetchNetworkError,
} from './sentry-browser-filters.ts'

type Frame = {
	filename?: string
	abs_path?: string
	absPath?: string
	function?: string
}
type Case = [
	type: string,
	value: string,
	frames?: Array<Frame>,
	originalException?: unknown,
]

function makeEvent([type, value, frames]: Case) {
	return {
		exception: {
			values: [{ type, value, ...(frames ? { stacktrace: { frames } } : {}) }],
		},
	}
}

const droppedBy = (filter: typeof filterBrowserSentryEvent, c: Case) =>
	filter(makeEvent(c), c[3]) === null
const keptBy = (filter: typeof filterBrowserSentryEvent, c: Case) => {
	const event = makeEvent(c)
	return filter(event, c[3]) === event
}
const fr = (name: string, filename: string): Frame => ({
	function: name,
	filename,
})
const withStack = <E extends Error>(error: E, stack: string) =>
	Object.assign(error, { stack })

const kodyEntry = fr('boot', 'https://kody.codes/assets/entry.js')
const appChunk = { abs_path: 'https://heykody.dev/assets/app-chunk.js' }
const hostHooks =
	'chrome-extension://iohjgamcilhbgmhbnllfolmkmmekfmci/injected-scripts/host-additional-hooks.js'
const perfInject = fr(
	'Performance.get',
	'chrome-extension://nmpbkbkalejlobohneicicgoojjokopi/data/content_script/page_context/inject.js',
)
const mIdExecutors =
	'chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js'
const mIdMessage = "Cannot read properties of undefined (reading 'M_ID')"
const readingUrl = "Cannot read properties of undefined (reading 'url')"
const webkitMessage =
	"undefined is not an object (evaluating 'window.webkit.messageHandlers')"
const ogTypeMessage =
	"null is not an object (evaluating 'document.querySelector(\"meta[property='og:type']\").content')"
const tabNotFound = 'Invalid call to runtime.sendMessage(). Tab not found.'
const objectCaptured = 'Object captured as exception with keys: code, message'
const objectCapturedWithStack =
	'Object captured as exception with keys: code, message, stack'
const messageChannelDisconnected = 'Message channel disconnected'
const rabbyMessageChannelStack =
	'MessageDisconnectedError: Message channel disconnected\n    at chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch/content-script.js:1:1'
const highlightChunkMessage =
	'Failed to fetch dynamically imported module: https://kody.codes/assets/syntax-highlight-core-VCFYP6MU.js'
const blogChunkMessage =
	'Failed to fetch dynamically imported module: https://kody.codes/assets/blog-area-ABC123.js'
const unknownStartReleaseMessage = 'Unknown Start release.'
const frameResolveFrame = fr(
	'createFrameResolveInit',
	'../client/frame-resolve.ts',
)
const turnstileCode = '[Cloudflare Turnstile] Error: 300010.'
const insertBeforeMessage =
	"Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node."
const frameworkInvariantMessage =
	'Framework invariant: Expected removed component to be committed'
const reconcileFrame = fr(
	'moveDomRange',
	'@remix-run/component/dist/runtime/reconcile',
)
const minifiedEntryFrame = fr('go', 'https://kody.codes/assets/entry-abc123.js')
const crabAppleMessage =
	'Error: [CrabApple] Failed to hard-spoof navigator.userAgent: TypeError: Cannot redefine property: userAgent'
const spoofFrames = [
	{ function: '<anonymous>' },
	{ function: 'spoofBrowserAndPlatform' },
]
const cspUnsafeEvalMessage =
	"Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self' 'sha256-abc' https://cdn.usefathom.com https://static.cloudflareinsights.com https://challenges.cloudflare.com\"."
const cspUnsafeEvalKody8yFrames = [
	fr(
		'sentryWrapped',
		'https://kody.codes/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js',
	),
	fr('next', '<anonymous>'),
	fr('predicate', '<anonymous>'),
	fr('eval', '<anonymous>'),
]
const replayCrossOriginElementMessage = `Failed to read a named property 'Element' from 'Window': Blocked a frame with origin "https://kody.codes" from accessing a cross-origin frame.`
const replayCrossOriginPrototypeMessage =
	"Cannot read properties of undefined (reading 'prototype')"
const replayOnIframeLoadFrame = fr(
	'sn.onIframeLoad',
	'@sentry/replay/build/npm/esm/index.js',
)
const replayObserveAttachShadowFrame = fr(
	'observeAttachShadow',
	'@sentry/replay/build/npm/esm/index.js',
)
const serverFnFetcherFrame = fr(
	'getResponse',
	'@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js',
)
const createServerFnFrame = fr(
	'userNext',
	'@tanstack/start-client-core/dist/esm/createServerFn.js',
)
const serverFnFetcherStack =
	'TypeError: Load failed\n    at getResponse (@tanstack/start-client-core/dist/esm/client-rpc/serverFnFetcher.js:138:9)\n    at userNext (@tanstack/start-client-core/dist/esm/createServerFn.js:1:1)'

test('individual browser Sentry filters drop AbortError, Firefox Xray, and injected-global noise', () => {
	const cases: Array<[typeof filterBrowserSentryEvent, Case, boolean]> = [
		[
			filterBrowserAbortSentryEvent,
			['Error', 'AbortError: The user aborted a request.'],
			true,
		],
		[
			filterBrowserAbortSentryEvent,
			[
				'Error',
				'something else',
				undefined,
				new DOMException('The user aborted a request.', 'AbortError'),
			],
			true,
		],
		[
			filterBrowserAbortSentryEvent,
			['Error', 'AbortError: The operation was aborted due to timeout.'],
			false,
		],
		[
			filterFirefoxDomPermissionDeniedSentryEvent,
			['Error', 'Permission denied to access property "childNodes"'],
			true,
		],
		[
			filterFirefoxDomPermissionDeniedSentryEvent,
			['Error', 'Permission denied'],
			false,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			[
				'TypeError',
				"undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
			],
			true,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			['ReferenceError', "Can't find variable: __firefox__"],
			true,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			[
				'TypeError',
				"undefined is not an object (evaluating 'window.someAppApi.foo')",
			],
			false,
		],
	]
	expect(
		cases.filter(([filter, c, dropped]) =>
			dropped ? !droppedBy(filter, c) : !keptBy(filter, c),
		),
	).toEqual([])
})

test('filterBrowserSentryEvent drops third-party and platform noise and keeps real errors', () => {
	const dropped: Array<Case> = [
		['Error', 'AbortError: The user aborted a request.'],
		// Fathom script DOM crash.
		[
			'TypeError',
			"Cannot read properties of null (reading 'removeChild')",
			[{ abs_path: 'https://cdn.usefathom.com/script.js' }],
		],
		// Chrome extension noise families.
		[
			'UnhandledRejection',
			'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
		],
		[
			'Error',
			'Error: Could not establish connection. Receiving end does not exist.',
		],
		['Error', tabNotFound],
		['Error', `Error: ${tabNotFound}`],
		['Error', 'something else', undefined, new Error(tabNotFound)],
		[
			'Error',
			'MetaMask extension not found',
			[
				{
					filename:
						'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js',
				},
			],
		],
		// MetaMask plain-object rejection (KODY-CLOUDFLARE-64): buffered
		// unhandledrejection with { code: 4001, message: "wallet must has…" }.
		[
			'Error',
			objectCaptured,
			undefined,
			{ code: 4001, message: 'wallet must has at least one account' },
		],
		['Error', 'wallet must has at least one account'],
		// Rabby / Chrome-extension Message channel disconnected (KODY-72):
		// buffered unhandledrejection with { code: 4900, message, stack }.
		[
			'Error',
			objectCapturedWithStack,
			undefined,
			{
				code: 4900,
				message: messageChannelDisconnected,
				stack: rabbyMessageChannelStack,
			},
		],
		// Same wording with only chrome-extension stack evidence (no code).
		[
			'Error',
			`MessageDisconnectedError: ${messageChannelDisconnected}`,
			undefined,
			withStack(
				new Error(`MessageDisconnectedError: ${messageChannelDisconnected}`),
				rabbyMessageChannelStack,
			),
		],
		// Direct capture: matching message plus chrome-extension event frames.
		[
			'Error',
			messageChannelDisconnected,
			[
				{
					filename:
						'chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch/content-script.js',
				},
			],
		],
		[
			'WrappedError',
			'Client has been destroyed',
			[{ filename: hostHooks }, { function: 'a6.send', abs_path: hostHooks }],
		],
		[
			'RangeError',
			'Maximum call stack size exceeded',
			[perfInject, fr('Reflect.get', '<anonymous>')],
		],
		[
			'TypeError',
			mIdMessage,
			[fr('E', mIdExecutors), { function: 'Y', abs_path: mIdExecutors }],
		],
		[
			'TypeError',
			"Cannot read property 'M_ID' of undefined",
			[fr('E', 'chrome-extension://abcd/executors/200.js')],
			new TypeError("Cannot read property 'M_ID' of undefined"),
		],
		// Twitter / X in-app browser globals.
		[
			'ReferenceError',
			'CONFIG is not defined',
			[{ function: 'updateGapFiller', abs_path: 'https://heykody.app/' }],
		],
		[
			'TypeError',
			webkitMessage,
			[
				{
					function: 'sendScrollEvent',
					abs_path: 'https://kody.codes/@kentcdodds/origin',
				},
			],
		],
		[
			'TypeError',
			`TypeError: ${ogTypeMessage}`,
			[
				{
					function: 'global code',
					absPath: 'https://heykody.app/guides/what-is-kody',
				},
			],
		],
		// WorkerGlobalScope blob importScripts NetworkError (KODY-CLOUDFLARE-5G).
		[
			'Error',
			"Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:https://kody.codes/746a7af2-37c5-4c0d-953f-661052a239a3' failed to load.",
			[
				{
					filename:
						'blob:https://kody.codes/da30da39-78fc-444b-abb1-01ebd8bfc126',
				},
			],
		],
		// Stale Start release after deploy (KODY-9E / issue 7795797021).
		['Error', unknownStartReleaseMessage],
		['Error', `Error: ${unknownStartReleaseMessage}`],
		[
			'Error',
			'something else',
			undefined,
			new Error(unknownStartReleaseMessage),
		],
		// syntax-highlight-core dynamic import misses (KODY-CLOUDFLARE-5W).
		['TypeError', highlightChunkMessage],
		[
			'TypeError',
			'something else',
			undefined,
			new TypeError(highlightChunkMessage),
		],
		// Turnstile client load and challenge failures (KODY-6D / KODY-6E).
		[
			'Error',
			'Turnstile script failed to load.',
			[fr('r.addEventListener.once', '../../client/public-form-protection.ts')],
		],
		[
			'Error',
			'something else',
			undefined,
			new Error('Turnstile API did not initialize.'),
		],
		['TurnstileError', turnstileCode],
		[
			'Error',
			'wrapped',
			undefined,
			Object.assign(new Error(turnstileCode), { name: 'TurnstileError' }),
		],
		// Local Vite HMR and loopback application failures.
		[
			'Error',
			'Local render failed',
			[
				{
					function: 'renderDocument',
					filename: '/packages/worker/client/entry.tsx',
					absPath: 'http://localhost:3742/packages/worker/client/entry.tsx',
				},
			],
		],
		[
			'TypeError',
			readingUrl,
			[
				{
					function: 'update',
					filename: '/node_modules/.vite/deps/react-dom_client.js',
					absPath:
						'http://localhost:3742/node_modules/.vite/deps/react-dom_client.js',
				},
			],
		],
		[
			'Error',
			'Client hydration error',
			undefined,
			withStack(
				new Error('Local render failed'),
				'Error: Local render failed\n    at renderDocument (http://127.0.0.1:3742/packages/worker/client/entry.tsx:80:11)',
			),
		],
		// CrabApple navigator.userAgent hard-spoof noise (KODY-80).
		['Error', crabAppleMessage, spoofFrames],
		['Error', 'something else', undefined, new Error(crabAppleMessage)],
		// CSP unsafe-eval refusal from extension-injected eval (KODY-8Y).
		['EvalError', cspUnsafeEvalMessage, cspUnsafeEvalKody8yFrames],
		[
			'EvalError',
			`EvalError: ${cspUnsafeEvalMessage}`,
			[
				fr('eval', '<anonymous>'),
				fr('sentryWrapped', '/node_modules/@sentry/browser/helpers.js'),
			],
		],
		// Production beforeSend: sentryWrapped is bundled under /assets/…
		// (Bugbot on #3204) — still drop when paired with anonymous eval.
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[
				fr('sentryWrapped', 'https://kody.codes/assets/entry-abc123.js'),
				fr('next', '<anonymous>'),
				fr('eval', '<anonymous>'),
			],
		],
		// Anonymous-only stack with the CSP wording (no named eval frame).
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[{ filename: '<anonymous>' }, { filename: '[native code]' }],
		],
		// Sentry Replay cross-origin iframe Element read (KODY-8W / #23795).
		[
			'SecurityError',
			replayCrossOriginElementMessage,
			[replayOnIframeLoadFrame],
		],
		[
			'DOMException',
			`SecurityError: ${replayCrossOriginElementMessage}`,
			[replayObserveAttachShadowFrame],
		],
		[
			'TypeError',
			replayCrossOriginPrototypeMessage,
			[replayObserveAttachShadowFrame],
		],
		[
			'SecurityError',
			'something else',
			undefined,
			withStack(
				new DOMException(replayCrossOriginElementMessage, 'SecurityError'),
				`SecurityError: ${replayCrossOriginElementMessage}\n    at sn.onIframeLoad (@sentry/replay/index.js:2118:35)`,
			),
		],
		// TanStack Start serverFn fetch network blips (KODY-9Q / 7798170337).
		['TypeError', 'Load failed', [serverFnFetcherFrame, createServerFnFrame]],
		['TypeError', 'Failed to fetch', [serverFnFetcherFrame]],
		['TypeError', 'Failed to fetch (kody.codes)', [createServerFnFrame]],
		[
			'TypeError',
			'NetworkError when attempting to fetch resource.',
			[serverFnFetcherFrame],
		],
		[
			'TypeError',
			'Load failed',
			undefined,
			withStack(new TypeError('Load failed'), serverFnFetcherStack),
		],
	]
	expect(
		dropped.filter((c) => !droppedBy(filterBrowserSentryEvent, c)),
	).toEqual([])

	// Near-misses: same message without the third-party frame/marker, or the
	// third-party frame mixed with first-party frames.
	const kept: Array<Case> = [
		['TypeError', 'TypeError: Failed to fetch'],
		[
			'TypeError',
			"Cannot read properties of null (reading 'removeChild')",
			[appChunk],
		],
		['UnhandledRejection', 'something else entirely'],
		['Error', 'Could not establish connection to the MCP server.'],
		['Error', 'Invalid call to runtime.sendMessage(). Extension gone.'],
		['Error', 'Failed to connect to MetaMask', [appChunk]],
		[
			'Error',
			objectCaptured,
			undefined,
			{ code: 4001, message: 'User rejected the request.' },
		],
		// EIP-1193 code 4900 with a different message must stay visible.
		[
			'Error',
			objectCapturedWithStack,
			undefined,
			{ code: 4900, message: 'User rejected the request.' },
		],
		// First-party "Message channel disconnected" without extension
		// provenance must stay visible (Devin on #3892).
		['Error', messageChannelDisconnected],
		['Error', `MessageDisconnectedError: ${messageChannelDisconnected}`],
		[
			'Error',
			messageChannelDisconnected,
			[kodyEntry],
			withStack(
				new Error(messageChannelDisconnected),
				`Error: ${messageChannelDisconnected}\n    at boot (https://kody.codes/assets/entry.js:1:1)`,
			),
		],
		// Matching message + first-party frames (no chrome-extension) stays.
		['Error', messageChannelDisconnected, [kodyEntry]],
		// Bare / unrelated "disconnected" wording stays visible.
		['Error', 'WebSocket disconnected unexpectedly'],
		['Error', 'Connection disconnected'],
		['WrappedError', 'Client has been destroyed', [kodyEntry]],
		[
			'Error',
			'Client has been destroyed during hydrate',
			[{ filename: hostHooks }],
		],
		['RangeError', 'Maximum call stack size exceeded', [perfInject, kodyEntry]],
		[
			'RangeError',
			'Maximum call stack size exceeded',
			[fr('scheduleNext', '../client/copy-text-button.tsx')],
		],
		[
			'TypeError',
			mIdMessage,
			[fr('readSession', 'https://kody.codes/assets/entry.js')],
		],
		[
			'TypeError',
			`TypeError: ${mIdMessage}`,
			[fr('Y', mIdExecutors), kodyEntry],
		],
		['TypeError', mIdMessage, [fr('Y', mIdExecutors), { function: 'boot' }]],
		['TypeError', readingUrl, [fr('Y', mIdExecutors)]],
		[
			'ReferenceError',
			"Can't find variable: CONFIG",
			[fr('boot', 'https://heykody.app/assets/entry.js')],
		],
		['TypeError', webkitMessage, [kodyEntry]],
		[
			'TypeError',
			ogTypeMessage,
			[fr('applyDocumentHead', 'https://heykody.app/assets/document-head.js')],
		],
		// Former runtime-specific suppression must not hide current app failures.
		// In-app TypeError "Load failed" with first-party frames stays visible:
		// without serverFnFetcher/createServerFn evidence it could be a real bug
		// (or a custom throw), not TanStack RPC network noise (KODY-9Q).
		[
			'TypeError',
			'Load failed',
			[fr('app.resolveFrame', '../client/entry.tsx')],
		],
		[
			'TypeError',
			'Failed to fetch',
			undefined,
			withStack(
				new TypeError('Failed to fetch'),
				'resolveFrame@https://kody.codes/client-entry.js:3:61347',
			),
		],
		[
			'TypeError',
			'Load failed',
			undefined,
			withStack(
				new TypeError('Load failed'),
				'fetchFrameResolve@https://kody.codes/client-entry.js:3:61000',
			),
		],
		[
			'TypeError',
			'Load failed',
			[fr('fetchFrameResolve', '../client/frame-resolve.ts')],
		],
		// Chromium "Failed to fetch (host)" via createFrameResolveInit (KODY-6A).
		[
			'TypeError',
			'Failed to fetch (kody.codes)',
			[frameResolveFrame, fr('boot', '../client/entry.tsx')],
		],
		[
			'TypeError',
			'Failed to fetch (kody.codes)',
			undefined,
			withStack(
				new TypeError('Failed to fetch (kody.codes)'),
				'TypeError: Failed to fetch\n    at Yn (https://kody.codes/client-entry.js:3:2497)\n    at Object.resolveFrame (https://kody.codes/client-entry.js:3:76468)',
			),
		],
		// Bare fetch-network TypeError without serverFn stack evidence stays
		// visible (could be any app fetch, not Start RPC).
		['TypeError', 'Load failed'],
		['TypeError', 'Load failed', [fr('someOtherFetch', 'app.js')]],
		['NotFoundError', insertBeforeMessage, [reconcileFrame]],
		['NotFoundError', insertBeforeMessage, [minifiedEntryFrame]],
		['NotFoundError', insertBeforeMessage, [fr('boot', '../client/entry.tsx')]],
		[
			'NotFoundError',
			`NotFoundError: ${insertBeforeMessage}`,
			undefined,
			new DOMException(insertBeforeMessage, 'NotFoundError'),
		],
		// Remix Framework invariant after DOM desync (KODY-8D).
		['Error', frameworkInvariantMessage, [minifiedEntryFrame]],
		['Error', `Error: ${frameworkInvariantMessage}`],
		[
			'Error',
			'something else',
			undefined,
			new Error(frameworkInvariantMessage),
		],
		['NetworkError', 'Failed to fetch'],
		// Near-miss "Unknown …" wording stays visible (not Start release).
		['Error', 'Unknown Start build.'],
		['Error', 'Unknown Start release hash.'],
		['Error', 'Unknown release.'],
		// Other hashed asset chunk misses stay visible (boot reload path), even
		// with a frame-resolve frame.
		['TypeError', blogChunkMessage],
		['TypeError', blogChunkMessage, [frameResolveFrame]],
		['Error', 'Turnstile widget host missing in layout'],
		// Production homepage SSR 500s and readRouterUrl crashes stay visible.
		[
			'Error',
			'Frame resolve failed (500) for https://kody.codes/',
			[
				{
					function: 'Object.resolveFrame',
					filename: '../client/entry.tsx',
					absPath: 'https://kody.codes/client-entry.js',
				},
			],
		],
		[
			'TypeError',
			readingUrl,
			[
				{
					function: 'readRouterUrl',
					filename: '../client/router-location.tsx',
					absPath: 'https://kody.codes/assets/entry-abc.js',
				},
			],
		],
		// Non-NotFoundError insertBefore stays visible (KODY-5E family).
		['HierarchyRequestError', insertBeforeMessage, [reconcileFrame]],
		['TypeError', insertBeforeMessage, [minifiedEntryFrame]],
		// Near-miss Framework invariant wording stays visible.
		[
			'Error',
			'Framework invariant: Expected removed component to stay mounted',
			[minifiedEntryFrame],
		],
		['TypeError', frameworkInvariantMessage, [minifiedEntryFrame]],
		[
			'TypeError',
			'TypeError: Cannot redefine property: userAgent',
			spoofFrames,
		],
		// Same CSP EvalError with a first-party bundle frame stays visible.
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[...cspUnsafeEvalKody8yFrames, minifiedEntryFrame],
		],
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[fr('eval', 'https://kody.codes/assets/entry-abc123.js')],
		],
		// URL-less frames could be first-party — keep (conservative).
		['EvalError', cspUnsafeEvalMessage, [{ function: 'eval' }]],
		// Whitespace-only URLs are unknown provenance — keep (CodeRabbit).
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[{ function: 'eval', filename: '   ' }],
		],
		// Missing stack could be first-party — keep.
		['EvalError', cspUnsafeEvalMessage],
		// originalException CSP message must not borrow frames from a
		// non-matching exception value (Devin on #3204).
		[
			'EvalError',
			'something else',
			cspUnsafeEvalKody8yFrames,
			Object.assign(new EvalError(cspUnsafeEvalMessage), {
				stack: `EvalError: ${cspUnsafeEvalMessage}\n    at eval (<anonymous>)`,
			}),
		],
		// Unrelated EvalError / other errors stay visible.
		[
			'EvalError',
			'Unexpected eval()',
			[fr('eval', '<anonymous>'), fr('sentryWrapped', '@sentry/browser')],
		],
		['TypeError', cspUnsafeEvalMessage, cspUnsafeEvalKody8yFrames],
		// Sentry + anonymous named frames without `eval` stay visible.
		[
			'EvalError',
			cspUnsafeEvalMessage,
			[
				fr(
					'sentryWrapped',
					'https://kody.codes/node_modules/@sentry/browser/build/npm/esm/prod/helpers.js',
				),
				fr('next', '<anonymous>'),
				fr('predicate', '<anonymous>'),
			],
		],
		// Replay Element SecurityError without onIframeLoad / observeAttachShadow
		// frames stays visible (could be app cross-origin access).
		['SecurityError', replayCrossOriginElementMessage, [kodyEntry]],
		[
			'TypeError',
			replayCrossOriginPrototypeMessage,
			[fr('boot', 'https://kody.codes/assets/entry.js')],
		],
		[
			'SecurityError',
			"Failed to read a named property 'location' from 'Window': Blocked a frame with origin \"https://kody.codes\" from accessing a cross-origin frame.",
			[replayOnIframeLoadFrame],
		],
		// Mismatched type + matching Element wording must stay visible
		// (Devin review on #3006): TypeError must not inherit the
		// SecurityError/DOMException Element drop path.
		['TypeError', replayCrossOriginElementMessage, [replayOnIframeLoadFrame]],
		// Stack URL substring must not count as a Replay iframe frame
		// (CodeRabbit on #3006): `onIframeLoad-helper.js` ≠ onIframeLoad.
		[
			'SecurityError',
			'something else',
			undefined,
			withStack(
				new DOMException(replayCrossOriginElementMessage, 'SecurityError'),
				`SecurityError: ${replayCrossOriginElementMessage}\n    at boot (https://kody.codes/assets/onIframeLoad-helper.js:1:1)`,
			),
		],
	]
	expect(kept.filter((c) => !keptBy(filterBrowserSentryEvent, c))).toEqual([])

	// Cross-value pairing must not drop: NotFoundError with a non-matching
	// message plus a TypeError that carries the insertBefore wording.
	const crossValueEvent = {
		exception: {
			values: [
				{ type: 'NotFoundError', value: 'Node was not found' },
				{ type: 'TypeError', value: insertBeforeMessage },
			],
		},
	}
	expect(filterBrowserSentryEvent(crossValueEvent)).toBe(crossValueEvent)

	// Replay Element wording on one value + onIframeLoad frames only on
	// another value must not drop (same-entry type/message/frame gate).
	const replayCrossValueEvent = {
		exception: {
			values: [
				{
					type: 'SecurityError',
					value: replayCrossOriginElementMessage,
					stacktrace: { frames: [kodyEntry] },
				},
				{
					type: 'TypeError',
					value: 'unrelated',
					stacktrace: { frames: [replayOnIframeLoadFrame] },
				},
			],
		},
	}
	expect(filterBrowserSentryEvent(replayCrossValueEvent)).toBe(
		replayCrossValueEvent,
	)

	// CSP EvalError wording on one value + eval frames only on another
	// value must not drop (same-entry type/message/frame gate; Devin on #3204).
	const cspEvalCrossValueEvent = {
		exception: {
			values: [
				{
					type: 'EvalError',
					value: cspUnsafeEvalMessage,
					stacktrace: {
						frames: [
							fr(
								'sentryWrapped',
								'https://kody.codes/node_modules/@sentry/browser/helpers.js',
							),
						],
					},
				},
				{
					type: 'TypeError',
					value: 'unrelated app failure',
					stacktrace: { frames: [fr('eval', '<anonymous>')] },
				},
			],
		},
	}
	expect(filterBrowserSentryEvent(cspEvalCrossValueEvent)).toBe(
		cspEvalCrossValueEvent,
	)

	// Bare event.message / originalException without exception.values must
	// stay visible — no frames to prove anonymous/Sentry-only provenance
	// (CodeRabbit on #3204). Regression that dropped these would be silent.
	const messageOnlyCspEvent = { message: cspUnsafeEvalMessage }
	expect(filterBrowserSentryEvent(messageOnlyCspEvent)).toBe(
		messageOnlyCspEvent,
	)
	const emptyEvent = {}
	expect(
		filterBrowserSentryEvent(emptyEvent, new EvalError(cspUnsafeEvalMessage)),
	).toBe(emptyEvent)
	expect(filterBrowserSentryEvent(emptyEvent, cspUnsafeEvalMessage)).toBe(
		emptyEvent,
	)
})

test('isTanStackServerFnFetchNetworkError requires serverFn stack evidence', () => {
	expect(
		isTanStackServerFnFetchNetworkError(
			withStack(new TypeError('Load failed'), serverFnFetcherStack),
		),
	).toBe(true)
	expect(
		isTanStackServerFnFetchNetworkError(
			withStack(
				new TypeError('Failed to fetch'),
				'TypeError: Failed to fetch\n    at getResponse (…/serverFnFetcher.js:1:1)',
			),
		),
	).toBe(true)
	// Message alone / first-party stack: keep reporting.
	expect(
		isTanStackServerFnFetchNetworkError(new TypeError('Load failed')),
	).toBe(false)
	expect(
		isTanStackServerFnFetchNetworkError(
			withStack(
				new TypeError('Load failed'),
				'TypeError: Load failed\n    at boot (https://kody.codes/assets/entry.js:1:1)',
			),
		),
	).toBe(false)
	// Non-network TypeError from createServerFn stays visible.
	expect(
		isTanStackServerFnFetchNetworkError(
			withStack(
				new TypeError('Cannot read properties of undefined'),
				serverFnFetcherStack,
			),
		),
	).toBe(false)
	// Non-2xx serverFn body errors are Error, not TypeError — stay visible.
	expect(
		isTanStackServerFnFetchNetworkError(
			withStack(new Error('Internal Server Error'), serverFnFetcherStack),
		),
	).toBe(false)
})

test('serverFn fetch-network filter drops production /assets stacks via /_serverFn breadcrumbs', () => {
	const productionAssetFrame = fr(
		'getResponse',
		'https://kody.codes/assets/entry-abc123.js',
	)
	const event = {
		exception: {
			values: [
				{
					type: 'TypeError',
					value: 'Load failed',
					stacktrace: { frames: [productionAssetFrame] },
				},
			],
		},
		breadcrumbs: [
			{
				category: 'fetch',
				data: {
					url: 'https://kody.codes/_serverFn/550d6c7b0123456789abcdef',
					method: 'GET',
				},
			},
		],
	}
	expect(filterBrowserSentryEvent(event)).toBeNull()
	// Same TypeError with only /assets frames and no serverFn breadcrumb stays.
	const withoutCrumb = {
		exception: event.exception,
	}
	expect(filterBrowserSentryEvent(withoutCrumb)).toBe(withoutCrumb)
})

test('serverFn fetch-network filter ignores successful /_serverFn breadcrumb status_code', () => {
	// A prior completed serverFn (status_code present) must not drop a later
	// unrelated fetch-network TypeError that only has /assets frames.
	const productionAssetFrame = fr(
		'getResponse',
		'https://kody.codes/assets/entry-abc123.js',
	)
	const event = {
		exception: {
			values: [
				{
					type: 'TypeError',
					value: 'Failed to fetch',
					stacktrace: { frames: [productionAssetFrame] },
				},
			],
		},
		breadcrumbs: [
			{
				category: 'fetch',
				data: {
					url: 'https://kody.codes/_serverFn/550d6c7b0123456789abcdef',
					method: 'GET',
					status_code: 200,
				},
			},
		],
	}
	expect(filterBrowserSentryEvent(event)).toBe(event)
})

test('serverFn fetch-network filter does not pair message and frames across exception values', () => {
	const crossValueEvent = {
		exception: {
			values: [
				{
					type: 'TypeError',
					value: 'Load failed',
					stacktrace: { frames: [kodyEntry] },
				},
				{
					type: 'TypeError',
					value: 'unrelated',
					stacktrace: { frames: [serverFnFetcherFrame] },
				},
			],
		},
	}
	expect(filterBrowserSentryEvent(crossValueEvent)).toBe(crossValueEvent)
})

test('serverFn fetch-network filter keeps a reportable exception that links a network TypeError cause', () => {
	// LinkedErrors puts cause values alongside the main exception; drop only
	// when every value is a qualifying serverFn fetch-network TypeError.
	const linkedEvent = {
		exception: {
			values: [
				{
					type: 'TypeError',
					value: 'Load failed',
					stacktrace: { frames: [serverFnFetcherFrame] },
				},
				{
					type: 'Error',
					value: 'Account loader failed',
					stacktrace: { frames: [kodyEntry] },
				},
			],
		},
	}
	expect(filterBrowserSentryEvent(linkedEvent)).toBe(linkedEvent)
})

test('isChromeExtensionMessageChannelDisconnectedError requires extension provenance', () => {
	expect(
		isChromeExtensionMessageChannelDisconnectedError({
			code: 4900,
			message: messageChannelDisconnected,
			stack: rabbyMessageChannelStack,
		}),
	).toBe(true)
	expect(
		isChromeExtensionMessageChannelDisconnectedError(
			withStack(
				new Error(messageChannelDisconnected),
				rabbyMessageChannelStack,
			),
		),
	).toBe(true)
	// No extension evidence — keep first-party / bare matches visible.
	expect(
		isChromeExtensionMessageChannelDisconnectedError(
			messageChannelDisconnected,
		),
	).toBe(false)
	expect(
		isChromeExtensionMessageChannelDisconnectedError(
			new Error(messageChannelDisconnected),
		),
	).toBe(false)
	expect(
		isChromeExtensionMessageChannelDisconnectedError({
			code: 4900,
			message: 'User rejected the request.',
		}),
	).toBe(false)
})

test('message-channel filter does not pair message and extension frames across exception values', () => {
	// First-party disconnected message + unrelated extension sibling must stay
	// visible (Devin on #3917).
	const crossValueEvent = {
		exception: {
			values: [
				{
					type: 'Error',
					value: messageChannelDisconnected,
					stacktrace: { frames: [kodyEntry] },
				},
				{
					type: 'Error',
					value: 'unrelated extension noise',
					stacktrace: {
						frames: [
							{
								filename:
									'chrome-extension://acmacodkjbdgmoleebolmdjonilkdbch/content-script.js',
							},
						],
					},
				},
			],
		},
	}
	expect(filterBrowserSentryEvent(crossValueEvent)).toBe(crossValueEvent)
})
