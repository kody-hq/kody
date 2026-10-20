import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import {
	decodePathKey,
	dirname,
	dynamicPackageImportResolvedMarker,
	encodePathKey,
	joinPath,
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
	packageRuntimeModulePrefix,
	publicRuntimeModulePath,
	resolveRelativeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

let cachedRuntimeModuleSource: string | null = null

export function createRuntimeModuleSource() {
	if (cachedRuntimeModuleSource) {
		return cachedRuntimeModuleSource
	}
	// The runtime context for a single execute-call / package-app fetch is
	// kept in AsyncLocalStorage rather than a single mutable globalThis slot.
	// AsyncLocalStorage propagates through async chains so concurrent calls
	// in the same isolate cannot clobber each other's runtime view, and the
	// surrounding wrapper no longer needs a try/finally save/restore dance.
	//
	// The AsyncLocalStorage *instance* must be shared between this virtual
	// runtime module and the surrounding execute / package-app wrapper,
	// because the wrapper is the one that calls `.run(runtime, cb)` while
	// user code reads the resulting store via the exports below. We share
	// the instance through a globalThis symbol; only the *instance* lives on
	// globalThis - the per-request runtime value is held inside the ALS, so
	// concurrent requests do not stomp on each other's view.
	//
	// Hydration used to install another full copy of this module under each
	// published-artifact prefix. Those copies now re-export this root module
	// so the stamp ALS is created once in this closure. The ALS instance and
	// stamp runner stay module-local (never hung off Symbol.for / globalThis);
	// only a read-only current-stamp getter is published for host wrappers.
	//
	// This module is evaluated at most once per isolate path, but dynamic
	// workers with identical code are cached and reused across executions
	// (stable worker-loader ids). Per-run values must therefore never freeze
	// into module scope: the \`kody\` capability proxy in particular closes over
	// the RPC ToolDispatcher stubs passed to a single \`evaluate()\` call,
	// and those stubs are implicitly disposed when that call returns. A
	// frozen \`export const kody = runtime.kody\` would make every later run
	// in a reused worker call capabilities through the first run's disposed
	// stubs ("RPC stub used after being disposed"). Every export below is
	// instead late-bound: it re-reads the current AsyncLocalStorage store on
	// each property access / call.
	//
	// Optional helpers (\`email\`, \`workflows\`, ...) still preserve their
	// absent value (\`undefined\` / \`null\`) so \`if (email) { ... }\`
	// guards stay falsy when a wrapper intentionally omits that export.
	// Helper *presence* is decided by the generated wrapper source, which is
	// part of the worker id hash, so presence observed on the first in-run
	// evaluation is identical for every later run of the same worker.
	// \`packageContext\` and unstamped \`packageSecrets\` are the exceptions:
	// the same wrapper is reused across evaluate calls, and the current
	// package id arrives on evaluate RPC, so those exports must re-read
	// AsyncLocalStorage on each access. \`if (packageSecrets)\` is therefore
	// always truthy on the late-bound export; presence is \`'get' in
	// packageSecrets\` or \`packageContext?.packageId\`.
	//
	// \`kody\` is always exported as a late-bound proxy: every
	// execute/package runtime provides it, and Worker module loaders may
	// evaluate this virtual module before the wrapper installs the per-run
	// store. The proxy resolves against the current AsyncLocalStorage store
	// at call time in both the preload and the reused-worker case.
	const source = `
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
const __kodyGetSecretAuthoritySymbol = Symbol.for('kody.getSecretAuthority');
const __globalAny = /** @type {any} */ (globalThis);
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());
// Stamp ALS + runner stay module-local (re-exports share one evaluation).
// Do not hang the runner on Symbol.for — package code can steal it.
const __kodySecretAuthorityAls = new AsyncLocalStorage();
function __kodyReadSecretAuthority() {
	const current = __kodySecretAuthorityAls.getStore();
	return typeof current === 'string' && current.trim() ? current.trim() : null;
}
function __kodyRunWithSecretAuthority(packageId, callback) {
	return __kodySecretAuthorityAls.run(packageId, callback);
}
// Intrinsic AsyncFunction prototype — never read target.constructor (package
// code can null or forge it). Used only to choose async vs sync ALS.run.
const __kodyAsyncFunctionPrototype = Object.getPrototypeOf(async function () {});
// Sealed global getter for back-compat readers. Reinstall when absent or
// still configurable. A sealed pre-planted getter cannot be replaced —
// host wrappers prefer the module export so that forge cannot stamp.
{
	const existing = Object.getOwnPropertyDescriptor(
		__globalAny,
		__kodyGetSecretAuthoritySymbol,
	);
	if (!existing || existing.configurable) {
		Object.defineProperty(__globalAny, __kodyGetSecretAuthoritySymbol, {
			value: __kodyReadSecretAuthority,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}
}
export function __kodyGetSecretAuthority() {
	return __kodyReadSecretAuthority();
}

export function __kodyRunInRuntime(runtime, callback) {
	return __kodyRuntimeStorage.run(runtime, callback);
}

function __kodyReadRuntimeExport(exportName) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const runtimeExport = currentRuntime?.[exportName];
	if (runtimeExport == null) {
		throw new Error(
			\`kody:runtime export "\${exportName}" is not available in this execution context.\`,
		);
	}
	return runtimeExport;
}

function __kodyRuntimeProxyLabel(exportName) {
	return \`[KodyRuntime:\${exportName}]\`;
}

function __kodyRuntimeProxyInspectionValue(exportName, property) {
	if (property === Symbol.toStringTag) return \`KodyRuntime:\${exportName}\`;
	if (property === 'then') return undefined;
	if (
		property === Symbol.iterator ||
		property === Symbol.asyncIterator
	) {
		return undefined;
	}
	if (
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString'
	) {
		return () => __kodyRuntimeProxyLabel(exportName);
	}
	if (property === 'valueOf') {
		return () => __kodyCreateRuntimeObjectProxy(exportName);
	}
	return undefined;
}

function __kodyIsRuntimeProxyInspectionProperty(property) {
	return (
		property === Symbol.toStringTag ||
		property === 'then' ||
		property === Symbol.iterator ||
		property === Symbol.asyncIterator ||
		property === Symbol.toPrimitive ||
		property === Symbol.for('nodejs.util.inspect.custom') ||
		property === 'inspect' ||
		property === 'toString' ||
		property === 'valueOf'
	);
}

function __kodyReadRuntimeNestedValue(exportName, path) {
	let current = __kodyReadRuntimeExport(exportName);
	for (const segment of path) {
		if (current == null) return undefined;
		current = current[segment];
	}
	return current;
}

function __kodyBindRuntimeNestedValue(exportName, path, property, value) {
	if (typeof value === 'function') {
		return function (...args) {
			return __kodyApplyRuntimeNestedValue(exportName, [...path, property], args);
		};
	}
	if (value != null && typeof value === 'object') {
		return __kodyCreateRuntimeNestedObjectProxy(exportName, [...path, property]);
	}
	return value;
}

function __kodyApplyRuntimeNestedValue(exportName, path, args) {
	const nestedExportName = exportName + '.' + path.map(String).join('.');
	const parentPath = path.slice(0, -1);
	const property = path[path.length - 1];
	const parent =
		parentPath.length === 0
			? __kodyReadRuntimeExport(exportName)
			: __kodyReadRuntimeNestedValue(exportName, parentPath);
	if (parent == null) {
		throw new Error(
			\`kody:runtime export "\${nestedExportName}" is not callable in this execution context.\`,
		);
	}
	// Do not swallow Get throws: createKodyRemoteProxy raises the OAuth /
	// disconnected message when a 0-tool server is accessed. Re-reading here
	// surfaces that instead of TypeError "is not a function".
	const currentValue = parent[property];
	if (typeof currentValue !== 'function') {
		throw new Error(
			\`kody:runtime export "\${nestedExportName}" is not callable in this execution context.\`,
		);
	}
	return currentValue.apply(parent, args);
}

// Bundler \`const { home } = kody.mcp\` uses [[GetOwnProperty]]. If the
// current run's mcp proxy omits home (or throws on [[Get]]), bind a
// late-bound nested proxy instead of undefined so a later run can still
// resolve home.bond_shade_set_position against that run's kody.mcp.
// The stand-in is callable: a same-run call re-reads the current mcp
// proxy and surfaces its throw (OAuth waiting, unknown tool) instead of
// TypeError "kody.mcp.home.tool is not a function".
function __kodyLateBoundNestedPropertyDescriptor(exportName, path, property) {
	return {
		configurable: true,
		enumerable: true,
		writable: true,
		value: __kodyCreateRuntimeNestedObjectProxy(exportName, [...path, property]),
	};
}

function __kodyCreateRuntimeNestedObjectProxy(exportName, path) {
	const nestedExportName = exportName + '.' + path.map(String).join('.');
	// Arrow target: a normal function's non-configurable prototype must
	// appear in [[OwnPropertyKeys]], so ownKeys that forwards only the
	// runtime parent keys would throw on Object.keys(kody.mcp).
	return new Proxy(() => {}, {
		apply(_target, _thisArg, args) {
			return __kodyApplyRuntimeNestedValue(exportName, path, args);
		},
		get(_target, property) {
			const inspectionValue = __kodyRuntimeProxyInspectionValue(
				nestedExportName,
				property,
			);
			if (inspectionValue !== undefined || __kodyIsRuntimeProxyInspectionProperty(property)) {
				return inspectionValue;
			}
			const parent = __kodyReadRuntimeNestedValue(exportName, path);
			if (parent == null) {
				return __kodyCreateRuntimeNestedObjectProxy(
					exportName,
					[...path, property],
				);
			}
			let value;
			try {
				value = parent[property];
			} catch {
				return __kodyCreateRuntimeNestedObjectProxy(
					exportName,
					[...path, property],
				);
			}
			if (value === undefined) {
				return __kodyCreateRuntimeNestedObjectProxy(
					exportName,
					[...path, property],
				);
			}
			return __kodyBindRuntimeNestedValue(
				exportName,
				path,
				property,
				value,
			);
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			if (currentRuntime?.[exportName] == null) return false;
			const parent = __kodyReadRuntimeNestedValue(exportName, path);
			return parent != null && property in parent;
		},
		ownKeys() {
			const currentRuntime = __kodyRuntimeStorage.getStore();
			if (currentRuntime?.[exportName] == null) return [];
			const parent = __kodyReadRuntimeNestedValue(exportName, path);
			return parent == null ? [] : Reflect.ownKeys(parent);
		},
		getOwnPropertyDescriptor(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return undefined;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			if (currentRuntime?.[exportName] == null) {
				return __kodyLateBoundNestedPropertyDescriptor(
					exportName,
					path,
					property,
				);
			}
			const parent = __kodyReadRuntimeNestedValue(exportName, path);
			if (parent == null) {
				return __kodyLateBoundNestedPropertyDescriptor(
					exportName,
					path,
					property,
				);
			}
			let descriptor;
			try {
				descriptor = Reflect.getOwnPropertyDescriptor(parent, property);
			} catch {
				return __kodyLateBoundNestedPropertyDescriptor(
					exportName,
					path,
					property,
				);
			}
			if (descriptor !== undefined && !('value' in descriptor)) {
				return { ...descriptor, configurable: true };
			}
			let value = descriptor?.value;
			if (descriptor === undefined) {
				try {
					value = parent[property];
				} catch {
					return __kodyLateBoundNestedPropertyDescriptor(
						exportName,
						path,
						property,
					);
				}
				if (value === undefined) {
					return __kodyLateBoundNestedPropertyDescriptor(
						exportName,
						path,
						property,
					);
				}
			}
			return {
				configurable: true,
				enumerable: descriptor?.enumerable !== false,
				writable: true,
				value: __kodyBindRuntimeNestedValue(
					exportName,
					path,
					property,
					value,
				),
			};
		},
	});
}

function __kodyCreateRuntimeObjectProxy(exportName) {
	return new Proxy({}, {
		get(_target, property) {
			const inspectionValue = __kodyRuntimeProxyInspectionValue(
				exportName,
				property,
			);
			if (inspectionValue !== undefined || __kodyIsRuntimeProxyInspectionProperty(property)) {
				return inspectionValue;
			}
			const runtimeExport = __kodyReadRuntimeExport(exportName);
			const value = runtimeExport[property];
			if (typeof value === 'function') {
				// Late-bind method calls to the runtime of the *calling* run: a
				// function captured at property-access time (for example a
				// top-level \`const search = kody.communitySearch\`) would
				// otherwise keep pointing at the run that evaluated this module,
				// whose RPC dispatcher stubs are disposed once that run returns.
				return function (...args) {
					const currentExport = __kodyReadRuntimeExport(exportName);
					const currentValue = currentExport[property];
					if (typeof currentValue !== 'function') {
						throw new Error(
							\`kody:runtime export "\${exportName}.\${String(property)}" is not callable in this execution context.\`,
						);
					}
					return currentValue.apply(currentExport, args);
				};
			}
			// Nested namespaces such as kody.mcp must stay
			// late-bound too. Returning the raw object lets a bundler
			// destructure \`const { home } = kody.mcp\` against a get-only
			// proxy and bind home to undefined.
			if (value != null && typeof value === 'object') {
				return __kodyCreateRuntimeNestedObjectProxy(exportName, [property]);
			}
			return value;
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport != null && property in runtimeExport;
		},
		ownKeys() {
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			return runtimeExport == null ? [] : Reflect.ownKeys(runtimeExport);
		},
		getOwnPropertyDescriptor(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return undefined;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const runtimeExport = currentRuntime?.[exportName];
			if (runtimeExport == null) return undefined;
			const descriptor = Reflect.getOwnPropertyDescriptor(runtimeExport, property);
			if (descriptor !== undefined) {
				return { ...descriptor, configurable: true };
			}
			if (!(property in runtimeExport)) return undefined;
			const value = runtimeExport[property];
			return {
				configurable: true,
				enumerable: true,
				writable: true,
				value:
					value != null && typeof value === 'object'
						? __kodyCreateRuntimeNestedObjectProxy(exportName, [property])
						: value,
			};
		},
	});
}

function __kodyCreateRuntimeFunctionExport(exportName) {
	return function (...args) {
		const runtimeExport = __kodyReadRuntimeExport(exportName);
		if (typeof runtimeExport !== 'function') {
			throw new Error(
				\`kody:runtime export "\${exportName}" is not callable in this execution context.\`,
			);
		}
		return runtimeExport(...args);
	};
}

const __kodyInitialRuntime = __kodyRuntimeStorage.getStore();

function __kodyOptionalRuntimeObjectExport(exportName, absentValue) {
	if (__kodyInitialRuntime === undefined) return absentValue;
	if (__kodyInitialRuntime[exportName] == null) return absentValue;
	return __kodyCreateRuntimeObjectProxy(exportName);
}

function __kodyOptionalRuntimeFunctionExport(exportName) {
	if (__kodyInitialRuntime === undefined) return undefined;
	if (typeof __kodyInitialRuntime[exportName] !== 'function') return undefined;
	return __kodyCreateRuntimeFunctionExport(exportName);
}

function __kodyCreateRuntimeRecordExport(exportName) {
	return new Proxy({}, {
		get(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) {
				return __kodyRuntimeProxyInspectionValue(exportName, property);
			}
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const value = currentRuntime?.[exportName] ?? null;
			if (value == null) return undefined;
			return value[property];
		},
		has(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return false;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const value = currentRuntime?.[exportName] ?? null;
			return value != null && property in value;
		},
		ownKeys() {
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const value = currentRuntime?.[exportName] ?? null;
			return value == null ? [] : Reflect.ownKeys(value);
		},
		getOwnPropertyDescriptor(_target, property) {
			if (__kodyIsRuntimeProxyInspectionProperty(property)) return undefined;
			const currentRuntime = __kodyRuntimeStorage.getStore();
			const value = currentRuntime?.[exportName] ?? null;
			if (value == null) return undefined;
			const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
			if (descriptor !== undefined) {
				return { ...descriptor, configurable: true };
			}
			if (!(property in value)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				writable: true,
				value: value[property],
			};
		},
		set() {
			return false;
		},
		defineProperty() {
			return false;
		},
		deleteProperty() {
			return false;
		},
	});
}

function __kodyResolvePackageStorage(packageId) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const factory = currentRuntime?.__kodyPackageStorage;
	if (typeof factory !== 'function') {
		throw new Error(
			'packageStorage() is not available in this execution context. It is bound for bundled module runs (execute calls and saved-package invocations) with an authenticated user.',
		);
	}
	return factory(packageId);
}

// Factory for the bundler's per-package virtual runtime modules: each module
// that originates from a saved package imports 'kody:runtime' through a
// module whose packageStorage closes over that package's immutable id (see
// createPackageRuntimeModuleSource). The closure survives bundler inlining,
// and the host independently validates the id against the run's provenance
// grants, so this stamp routes identity without being a security boundary.
export function __kodyCreatePackageBoundStorage(packageId) {
	return function packageStorage() {
		return __kodyResolvePackageStorage(packageId);
	};
}

function __kodyResolvePackageSecrets(packageId) {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const factory = currentRuntime?.__kodyPackageSecrets;
	if (typeof factory !== 'function') {
		throw new Error(
			'packageSecrets is not available in this execution context. It is bound for stamped saved-package modules (including static kody:@ imports) and for saved-package runtime contexts with an authenticated user.',
		);
	}
	return factory(packageId);
}

// Factory for the bundler's per-package virtual runtime modules: each module
// that originates from a saved package imports 'kody:runtime' through a
// module whose packageSecrets closes over that package's immutable id (see
// createPackageRuntimeModuleSource). The host independently validates the
// id against the run's provenance grants, so this stamp routes secret
// authority without being a security boundary.
export function __kodyCreatePackageBoundSecrets(packageId) {
	return {
		get: async (alias) =>
			__kodyRunWithSecretAuthority(packageId, () =>
				__kodyResolvePackageSecrets(packageId).get(alias),
			),
		has: async (alias) =>
			__kodyRunWithSecretAuthority(packageId, () =>
				__kodyResolvePackageSecrets(packageId).has(alias),
			),
	};
}

// Proxies created by __kodyMeterStaticPackageExport. When a re-export chain
// wraps an already-metered export, only the innermost apply that invokes the
// real target records — outer layers skip so one throw is one event.
const __kodyMeteredStaticPackageExports = new WeakSet();

function __kodySanitizeStaticCallErrorName(raw) {
	if (typeof raw !== 'string') return '';
	const trimmed = raw.trim().slice(0, 96);
	if (!trimmed || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) return '';
	return trimmed;
}

function __kodyStaticCallErrorName(error) {
	try {
		if (error == null) return '';
		if (typeof error === 'string') {
			const match = /^\\[([A-Za-z0-9._:-]{1,96})\\]/.exec(error.trim());
			return __kodySanitizeStaticCallErrorName(match?.[1]);
		}
		if (typeof error !== 'object') return '';
		const code = error.code;
		if (typeof code === 'string') {
			const fromCode = __kodySanitizeStaticCallErrorName(code);
			if (fromCode) return fromCode;
		}
		const bodyCode = error.body?.code;
		if (typeof bodyCode === 'string') {
			const fromBody = __kodySanitizeStaticCallErrorName(bodyCode);
			if (fromBody) return fromBody;
		}
		const message = error.message;
		if (typeof message === 'string') {
			const match = /^\\[([A-Za-z0-9._:-]{1,96})\\]/.exec(message.trim());
			const fromMessage = __kodySanitizeStaticCallErrorName(match?.[1]);
			if (fromMessage) return fromMessage;
		}
		const name = error.name;
		if (typeof name === 'string') {
			return __kodySanitizeStaticCallErrorName(name);
		}
	} catch {}
	return '';
}

function __kodyRecordStaticPackageCall(packageId, startedAtMs, outcome, errorName) {
	// Metering must never block or throw into the call path: reporting is a
	// synchronous buffer push into the current run's meter (the surrounding
	// wrapper flushes the buffer over the host bridge once, at the end of
	// the run, while its RPC dispatchers are still live). The meter is read
	// late-bound from the run store so reused worker isolates never pin a
	// previous run's state, and runs without a meter simply skip recording.
	try {
		const meter = __kodyRuntimeStorage.getStore()?.__kodyStaticCallMeter;
		if (meter == null || typeof meter.report !== 'function') return;
		const report = {
			packageId,
			durationMs: Date.now() - startedAtMs,
			outcome,
		};
		if (outcome === 'error' && typeof errorName === 'string' && errorName) {
			report.errorName = errorName;
		}
		meter.report(report);
	} catch {}
}

// Call-metering wrapper for statically imported package exports. The
// bundler stamps the callee package id into generated import proxies (see
// createMeteredPackageImportProxySource); the id is identity routing only —
// the host independently validates it against the run's bundler-recorded
// dependency provenance before recording anything. Non-function exports
// pass through unchanged; function exports keep their identity semantics
// (arguments, this, return values, thrown errors, properties, construct)
// behind a transparent Proxy whose only addition is a non-blocking usage
// event per call. [[Call]] records usage. [[Construct]] is not metered
// (construction stays a transparent \`new\`), but it still runs under the
// stamp ALS so constructor-side fetch / kody.* keep the imported identity.
// Re-export chains that wrap an already-metered proxy record once at the
// innermost layer (see __kodyMeteredStaticPackageExports).
export function __kodyMeterStaticPackageExport(packageId, exportValue) {
	if (typeof exportValue !== 'function') return exportValue;
	const proxy = new Proxy(exportValue, {
		construct(target, argumentsList, newTarget) {
			return __kodyRunWithSecretAuthority(packageId, () =>
				Reflect.construct(target, argumentsList, newTarget),
			);
		},
		apply(target, thisArg, argumentsList) {
			const startedAtMs = Date.now();
			// Outer re-export layers skip recording; the inner metered apply
			// that reaches the real target owns the event.
			const recordThisLayer = !__kodyMeteredStaticPackageExports.has(target);
			// Async callees must be awaited inside ALS.run so the stamp
			// survives awaits in the callee body (workerd loses ALS when the
			// sync run() callback only *returns* a Promise). Sync callees
			// stay synchronous — return-value detection cannot both preserve
			// sync returns and run Reflect.apply inside async ALS, so we key
			// off the intrinsic AsyncFunction prototype (not constructor.name).
			if (Object.getPrototypeOf(target) === __kodyAsyncFunctionPrototype) {
				return __kodyRunWithSecretAuthority(packageId, async () => {
					try {
						const value = await Reflect.apply(
							target,
							thisArg,
							argumentsList,
						);
						if (recordThisLayer) {
							__kodyRecordStaticPackageCall(
								packageId,
								startedAtMs,
								'success',
							);
						}
						return value;
					} catch (error) {
						if (recordThisLayer) {
							__kodyRecordStaticPackageCall(
								packageId,
								startedAtMs,
								'error',
								__kodyStaticCallErrorName(error),
							);
						}
						throw error;
					}
				});
			}
			const invoke = () => {
				let result;
				try {
					result = Reflect.apply(target, thisArg, argumentsList);
				} catch (error) {
					if (recordThisLayer) {
						__kodyRecordStaticPackageCall(
							packageId,
							startedAtMs,
							'error',
							__kodyStaticCallErrorName(error),
						);
					}
					throw error;
				}
				// Deliberately only native promises: subscribing to an arbitrary
				// user thenable would invoke its then() from the metering path,
				// which can trigger lazy side effects (query-builder style
				// thenables execute when first awaited) — a behavior change the
				// wrapper must never cause. All modules run in one isolate, so
				// async exports always return same-realm native promises;
				// non-promise thenables record at return time instead of
				// settlement.
				if (result instanceof Promise) {
					if (recordThisLayer) {
						result.then(
							() =>
								__kodyRecordStaticPackageCall(
									packageId,
									startedAtMs,
									'success',
								),
							(error) =>
								__kodyRecordStaticPackageCall(
									packageId,
									startedAtMs,
									'error',
									__kodyStaticCallErrorName(error),
								),
						);
					}
					return result;
				}
				if (recordThisLayer) {
					__kodyRecordStaticPackageCall(packageId, startedAtMs, 'success');
				}
				return result;
			};
			return __kodyRunWithSecretAuthority(packageId, invoke);
		},
	});
	__kodyMeteredStaticPackageExports.add(proxy);
	return proxy;
}

// Unstamped fallback: modules without bundler-recorded package provenance
// (ad hoc execute code, artifacts published before stamping existed) can only
// reach the storage of the package the run itself belongs to.
export function packageStorage() {
	const currentRuntime = __kodyRuntimeStorage.getStore();
	const declaringPackageId = currentRuntime?.packageContext?.packageId;
	if (typeof declaringPackageId !== 'string' || declaringPackageId === '') {
		throw new Error(
			'packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. ' +
				'Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage(), ' +
				"statically import the owning package's export (kody:@scope/package/export) when the package name is known, " +
				'or import(specifier) when the package name is data.',
		);
	}
	return __kodyResolvePackageStorage(declaringPackageId);
}

// \`kody\` keeps its preload late-binding (imported before any store exists)
// and additionally stays late-bound for in-run evaluations, so reused worker
// isolates never pin the first run's dispatcher-backed proxy. A wrapper that
// deliberately omits \`kody\` still observes \`undefined\` so falsiness
// guards keep working.
export const kody =
	__kodyInitialRuntime === undefined || __kodyInitialRuntime.kody != null
		? __kodyCreateRuntimeObjectProxy('kody')
		: undefined;
export const createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport('createAuthenticatedFetch');
export const secretHeaders = __kodyOptionalRuntimeObjectExport('secretHeaders', undefined);
export const oauthClientCredentials = __kodyOptionalRuntimeFunctionExport('oauthClientCredentials');
// \`credential\` carries \`credential.named\`, so it forwards the property too.
export const credential = __kodyOptionalRuntimeFunctionExport('credential') &&
	Object.freeze(Object.assign(
		__kodyCreateRuntimeFunctionExport('credential'),
		{
			named: (...args) => {
				const runtimeExport = __kodyReadRuntimeExport('credential');
				if (typeof runtimeExport?.named !== 'function') {
					throw new Error('kody:runtime export "credential" is not callable in this execution context.');
				}
				return runtimeExport.named(...args);
			},
		},
	));
export const credentials = __kodyOptionalRuntimeFunctionExport('credentials');

// Factory for the per-package virtual runtime modules: an imported package's
// \`credential(key)\` reads that package's needs, not the entry package's. The
// host accepts the id only when it is in the run's provenance, and it selects
// needs only; it grants nothing.
function __kodyResolvePackageCredentialRuntime(packageId) {
	const factory = __kodyRuntimeStorage.getStore()?.__kodyCredentialRuntimeFor;
	if (typeof factory !== 'function') {
		throw new Error('kody:runtime export "credential" is not callable in this execution context.');
	}
	return factory(packageId);
}
export function __kodyCreatePackageBoundCredentialRuntime(packageId) {
	if (typeof __kodyInitialRuntime?.__kodyCredentialRuntimeFor !== 'function') {
		return { credential: undefined, credentials: undefined };
	}
	const credential = Object.assign(
		(...args) => __kodyResolvePackageCredentialRuntime(packageId).credential(...args),
		{
			named: (...args) =>
				__kodyResolvePackageCredentialRuntime(packageId).credential.named(...args),
		},
	);
	return {
		credential: Object.freeze(credential),
		credentials: (...args) =>
			__kodyResolvePackageCredentialRuntime(packageId).credentials(...args),
	};
}
export const packageContext = __kodyCreateRuntimeRecordExport('packageContext');
export const packageSecrets = __kodyCreateRuntimeObjectProxy('packageSecrets');
export const email = __kodyOptionalRuntimeObjectExport('email', null);
export const workflows = __kodyOptionalRuntimeObjectExport('workflows', null);
export const packages = __kodyOptionalRuntimeObjectExport('packages', null);
export const events = __kodyOptionalRuntimeObjectExport('events', null);

const __kodyRuntimeNamedExports = {
	kody,
	packageStorage,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	credential,
	credentials,
	packageContext,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
};

// The default export mirrors the named exports and forwards any extra
// wrapper-specific helpers (for example package-app \`realtime\`) to the
// current run's store instead of freezing the first run's object.
const __kodyRuntimeDefault = new Proxy(__kodyRuntimeNamedExports, {
	get(target, property) {
		if (Reflect.has(target, property)) return Reflect.get(target, property);
		const currentRuntime = __kodyRuntimeStorage.getStore();
		return currentRuntime?.[property];
	},
	has(target, property) {
		if (Reflect.has(target, property)) return true;
		const currentRuntime = __kodyRuntimeStorage.getStore();
		return currentRuntime != null && property in currentRuntime;
	},
	ownKeys(target) {
		const keys = new Set(Reflect.ownKeys(target));
		const currentRuntime = __kodyRuntimeStorage.getStore();
		if (currentRuntime != null) {
			for (const key of Reflect.ownKeys(currentRuntime)) keys.add(key);
		}
		return [...keys];
	},
	getOwnPropertyDescriptor(target, property) {
		const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
		if (ownDescriptor) return ownDescriptor;
		const currentRuntime = __kodyRuntimeStorage.getStore();
		if (currentRuntime == null) return undefined;
		const descriptor = Reflect.getOwnPropertyDescriptor(currentRuntime, property);
		if (descriptor === undefined) return undefined;
		return { ...descriptor, configurable: true };
	},
});
export default __kodyRuntimeDefault;

// Optional request-context key: a frozen \`{ defaultValue }\` object so a
// Remix \`context.get(KodyRuntime)\` (or any library that treats
// \`defaultValue\` the same way) yields this module's default export without
// a middleware to install it. The value stays late-bound like every other
// export. Other entries import named exports from this module directly.
export const KodyRuntime = Object.freeze({ defaultValue: __kodyRuntimeDefault });
`.trim()
	cachedRuntimeModuleSource = source
	return source
}

export function isKodyRuntimeModulePath(modulePath: string) {
	return (
		modulePath === runtimeModulePath ||
		modulePath.endsWith(`/${runtimeModulePath}`)
	)
}

export function isCanonicalKodyRuntimeModulePath(modulePath: string) {
	return normalizeWorkspaceModulePath(modulePath) === runtimeModulePath
}

/**
 * Prefixed `runtime.js` copies re-export one shared runtime root so the stamp
 * ALS is created once. A second full evaluation would write one store while
 * fetch / `kody.*` read another, or require putting the ALS runner on
 * `globalThis` where package code can steal it via Symbol.for.
 */
export function createRuntimeModuleReexportSource(
	modulePath: string,
	rootPath: string = runtimeModulePath,
) {
	const specifier = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(modulePath),
		normalizeWorkspaceModulePath(rootPath),
	)
	return `
export * from ${JSON.stringify(specifier)};
export { default } from ${JSON.stringify(specifier)};
`.trim()
}

function pickPrimaryRuntimeModulePath(paths: Iterable<string>) {
	const normalized = [...new Set([...paths].map(normalizeWorkspaceModulePath))]
	if (normalized.length === 0) {
		return runtimeModulePath
	}
	// Prefer the graph-canonical root when present; otherwise the shortest
	// `.../.__kody_virtual__/runtime.js` path so artifact-only graphs still
	// evaluate the full runtime exactly once.
	if (normalized.includes(runtimeModulePath)) {
		return runtimeModulePath
	}
	normalized.sort(
		(left, right) => left.length - right.length || left.localeCompare(right),
	)
	return normalized[0]!
}

export function buildPackageRuntimeModulePath(packageId: string) {
	// Hex-encode the id so arbitrary saved-package ids stay path-safe and the
	// id survives a lossless round trip through the module path.
	return `${packageRuntimeModulePrefix}/${encodePathKey(packageId)}.js`
}

/**
 * Reads the stamped saved-package id back out of a per-package virtual
 * runtime module path (`.__kody_virtual__/package-runtime/<hex>.js`,
 * optionally nested under a graph or artifact prefix). Returns null for
 * every other path.
 */
export function parsePackageRuntimeModulePathPackageId(modulePath: string) {
	const normalizedPath = normalizeWorkspaceModulePath(modulePath)
	const prefix = `${packageRuntimeModulePrefix}/`
	const isPackageRuntimePath =
		normalizedPath.startsWith(prefix) || normalizedPath.includes(`/${prefix}`)
	if (!isPackageRuntimePath) return null
	const fileName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
	if (!fileName.endsWith('.js')) return null
	return decodePathKey(fileName.slice(0, -'.js'.length))
}

/**
 * Late-bound `kody:runtime` exports that package code may import verbatim
 * from the shared runtime. `packageStorage`, `packageSecrets`, `default`, and
 * `KodyRuntime` are added per facade. Everything else the shared runtime
 * exports (stamp, bound-secret, bound-storage, and metering helpers) is
 * bundler-internal: it can enter secret authority for any package id, so
 * package-facing modules must list exports explicitly, never `export *`.
 */
const kodyRuntimeSharedExportNames = [
	'kody',
	'createAuthenticatedFetch',
	'secretHeaders',
	'oauthClientCredentials',
	'credential',
	'credentials',
	'packageContext',
	'email',
	'workflows',
	'packages',
	'events',
] as const

const packageBoundCredentialExportNames: ReadonlySet<string> = new Set([
	'credential',
	'credentials',
])

/**
 * `kody:runtime` target for modules without saved-package provenance (ad hoc
 * execute code, unstamped roots). Same public surface as the shared runtime,
 * minus the bundler-internal helpers.
 */
export function createPublicRuntimeModuleSource() {
	const exportNames = [
		...kodyRuntimeSharedExportNames,
		'packageStorage',
		'packageSecrets',
		'KodyRuntime',
		'default',
	]
	return `
export { ${exportNames.join(', ')} } from './runtime.js';
`.trim()
}

export function isKodyPublicRuntimeModulePath(modulePath: string) {
	return (
		modulePath === publicRuntimeModulePath ||
		modulePath.endsWith(`/${publicRuntimeModulePath}`)
	)
}

/**
 * Virtual runtime module for one saved package: re-exports the shared
 * runtime's public surface and overrides `packageStorage` with a variant
 * bound to the package's immutable id. The bundler rewrites `kody:runtime` imports in
 * modules that originate from that package to this module, so
 * `packageStorage()` keeps resolving to the declaring package's bucket even
 * when the module is statically imported into a foreign execution context.
 * The id baked in here is identity routing only; the host grants access from
 * its own provenance metadata (see `createPackageStorageKodyTools`).
 */
export function createPackageRuntimeModuleSource(packageId: string) {
	// Per-package modules sit one directory below the shared runtime module
	// (`.__kody_virtual__/package-runtime/<hex>.js` next to
	// `.__kody_virtual__/runtime.js`), in every graph or artifact prefix.
	const baseRuntimeSpecifier = '../runtime.js'
	const sharedExportNames = kodyRuntimeSharedExportNames.filter(
		(name) => !packageBoundCredentialExportNames.has(name),
	)
	return `
export { ${sharedExportNames.join(', ')} } from ${JSON.stringify(baseRuntimeSpecifier)};
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundSecrets, __kodyCreatePackageBoundCredentialRuntime } from ${JSON.stringify(
		baseRuntimeSpecifier,
	)};
export const packageStorage = __kodyCreatePackageBoundStorage(${JSON.stringify(
		packageId,
	)});
export const packageSecrets = __kodyCreatePackageBoundSecrets(${JSON.stringify(
		packageId,
	)});
const __kodyPackageCredentialRuntime = __kodyCreatePackageBoundCredentialRuntime(${JSON.stringify(
		packageId,
	)});
export const credential = __kodyPackageCredentialRuntime.credential;
export const credentials = __kodyPackageCredentialRuntime.credentials;
// The default export mirrors the shared runtime default but resolves
// packageStorage / packageSecrets / credential / credentials to this
// package's bound variants.
const __kodyPackageBound = Object.fromEntries(
	Object.entries({ packageStorage, packageSecrets, credential, credentials }).filter(
		([, value]) => value !== undefined,
	),
);
const __kodyPackageRuntimeDefault = new Proxy(__kodyBaseRuntimeDefault, {
	get(target, property, receiver) {
		if (Object.hasOwn(__kodyPackageBound, property)) return __kodyPackageBound[property];
		return Reflect.get(target, property, receiver);
	},
	has(target, property) {
		return Object.hasOwn(__kodyPackageBound, property) || Reflect.has(target, property);
	},
});
export default __kodyPackageRuntimeDefault;
// Per-package request-context key: \`context.get(KodyRuntime)\` resolves
// packageStorage / packageSecrets to the declaring package, matching the
// named exports above.
export const KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });
`.trim()
}

function collectReferencedRuntimeModulePaths(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
) {
	const runtimePaths = new Set<string>(
		options?.includeDefaultRuntimePath === false ? [] : [runtimeModulePath],
	)
	for (const modulePath of Object.keys(modules)) {
		if (isKodyRuntimeModulePath(modulePath)) {
			runtimePaths.add(modulePath)
		}
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath && isKodyRuntimeModulePath(resolvedPath)) {
				runtimePaths.add(resolvedPath)
			}
		}
	}
	return runtimePaths
}

function collectReferencedPackageRuntimeModulePaths(
	modules: WorkerLoaderModules,
) {
	const packageRuntimePaths = new Map<string, string>()
	const remember = (modulePath: string) => {
		const packageId = parsePackageRuntimeModulePathPackageId(modulePath)
		if (packageId != null) {
			packageRuntimePaths.set(
				normalizeWorkspaceModulePath(modulePath),
				packageId,
			)
		}
	}
	for (const modulePath of Object.keys(modules)) {
		remember(modulePath)
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath) {
				remember(resolvedPath)
			}
		}
	}
	return packageRuntimePaths
}

function collectReferencedPublicRuntimeModulePaths(
	modules: WorkerLoaderModules,
) {
	const publicRuntimePaths = new Set<string>()
	const remember = (modulePath: string) => {
		const normalizedPath = normalizeWorkspaceModulePath(modulePath)
		if (isKodyPublicRuntimeModulePath(normalizedPath)) {
			publicRuntimePaths.add(normalizedPath)
		}
	}
	for (const modulePath of Object.keys(modules)) {
		remember(modulePath)
	}
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			const resolvedPath = resolveRelativeModulePath(modulePath, node.specifier)
			if (resolvedPath) {
				remember(resolvedPath)
			}
		}
	}
	return publicRuntimePaths
}

export function refreshKodyRuntimeModules(
	modules: WorkerLoaderModules,
	options?: {
		includeDefaultRuntimePath?: boolean
	},
): WorkerLoaderModules {
	const refreshed: WorkerLoaderModules = { ...modules }
	const includeCanonicalRoot = options?.includeDefaultRuntimePath !== false
	const runtimePaths = new Set(
		collectReferencedRuntimeModulePaths(modules, options),
	)
	if (includeCanonicalRoot) {
		runtimePaths.add(runtimeModulePath)
	}
	const packageRuntimeEntries = [
		...collectReferencedPackageRuntimeModulePaths(modules),
	]
	for (const [modulePath] of packageRuntimeEntries) {
		runtimePaths.add(
			normalizeWorkspaceModulePath(
				joinPath(dirname(dirname(modulePath)), 'runtime.js'),
			),
		)
	}
	const publicRuntimePaths = collectReferencedPublicRuntimeModulePaths(modules)
	for (const modulePath of publicRuntimePaths) {
		runtimePaths.add(
			normalizeWorkspaceModulePath(joinPath(dirname(modulePath), 'runtime.js')),
		)
	}
	// Artifact-only graphs omit the canonical root and used to materialize a
	// full runtime copy at every prefix. That created multiple stamp ALS
	// instances while `globalThis[Symbol.for('kody.getSecretAuthority')]`
	// kept the first getter — stamps wrote one store and reads saw another.
	// Evaluate the full runtime once at the primary path; every other copy
	// re-exports that root.
	const primaryRuntimePath = includeCanonicalRoot
		? runtimeModulePath
		: pickPrimaryRuntimeModulePath(runtimePaths)
	for (const modulePath of runtimePaths) {
		refreshed[modulePath] = runtimeModuleSourceForPath(modulePath, {
			primaryRuntimePath,
		})
	}
	for (const [modulePath, packageId] of packageRuntimeEntries) {
		refreshed[modulePath] = createPackageRuntimeModuleSource(packageId)
	}
	for (const modulePath of publicRuntimePaths) {
		refreshed[modulePath] = createPublicRuntimeModuleSource()
	}
	return refreshed
}

function runtimeModuleSourceForPath(
	modulePath: string,
	options: { primaryRuntimePath: string },
) {
	if (
		normalizeWorkspaceModulePath(modulePath) ===
		normalizeWorkspaceModulePath(options.primaryRuntimePath)
	) {
		return createRuntimeModuleSource()
	}
	return createRuntimeModuleReexportSource(
		modulePath,
		options.primaryRuntimePath,
	)
}

function isStrippableKodyRuntimeModulePath(modulePath: string) {
	return (
		isKodyRuntimeModulePath(modulePath) ||
		isKodyPublicRuntimeModulePath(modulePath) ||
		parsePackageRuntimeModulePathPackageId(modulePath) != null
	)
}

export function stripKodyRuntimeModules(modules: WorkerLoaderModules) {
	let stripped: WorkerLoaderModules | null = null
	for (const modulePath of Object.keys(modules)) {
		if (!isStrippableKodyRuntimeModulePath(modulePath)) continue
		stripped ??= { ...modules }
		delete stripped[modulePath]
	}
	return stripped ?? modules
}

/**
 * `hasDefaultExport: false` is for entries with only named exports (valid
 * package exports that are imported, never invoked directly). Importing
 * `default` from them is a hard bundler error, so the entry still evaluates
 * the module but rejects invocation with an actionable message.
 */
export function createExecuteEntrypointSource(input: {
	modulePath: string
	entryPoint: string
	hasDefaultExport: boolean
}) {
	if (!input.hasDefaultExport) {
		const message = `Kody execute modules must default export a function; "${input.entryPoint}" has no default export. Named exports can be imported from another module (for example \`import { name } from 'kody:@scope/package/export'\`) but cannot be invoked directly.`
		return `
import ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint() {
	throw new Error(${JSON.stringify(message)});
}
`.trim()
	}
	return `
import userEntrypoint from ${JSON.stringify(input.modulePath)};

export default async function __kodyExecuteEntrypoint(input) {
	if (typeof userEntrypoint !== 'function') {
		throw new Error('Kody execute modules must default export a function.');
	}
	return await userEntrypoint(input);
}
`.trim()
}

export function createAppEntrypointSource(input: { modulePath: string }) {
	return `
import * as userModule from ${JSON.stringify(input.modulePath)};
export * from ${JSON.stringify(input.modulePath)};

const candidate = userModule.default ?? userModule;

function resolvePackageAppHandler() {
  if (typeof candidate === 'function') {
    return candidate;
  }
  if (candidate && typeof candidate.fetch === 'function') {
    return candidate.fetch.bind(candidate);
  }
  // Read "fetch" reflectively: a static userModule.fetch access makes esbuild
  // emit an import-is-undefined warning for every app without a named fetch
  // export.
  const moduleFetch = Reflect.get(userModule, 'fetch');
  if (typeof moduleFetch === 'function') {
    return moduleFetch;
  }
  throw new Error(
    'Kody package apps must default export a fetch handler (a function, an object with fetch(), or a named fetch export).',
  );
}

const handler = resolvePackageAppHandler();

export default {
  async fetch(request, env, ctx) {
    return await handler(request, env, ctx);
  },
};
`.trim()
}

export function createPackageImportProxySource(input: { targetPath: string }) {
	return `
export * from ${JSON.stringify(input.targetPath)};
import * as __kodyPackageModule from ${JSON.stringify(input.targetPath)};
export default __kodyPackageModule.default;
`.trim()
}

/**
 * Static-import proxy stamped with the callee saved-package id: function
 * valued exports are wrapped in the call-metering Proxy from the runtime
 * module (`__kodyMeterStaticPackageExport`), non-function exports pass
 * through unchanged. The `export * from` passthrough stays first so any
 * export name the bundler could not statically discover remains available (it
 * is just not metered) — explicitly re-exported wrapped names shadow the
 * star re-export per the ES module ambiguity rules. Only the static import
 * rewrite uses this variant; dynamic package import proxies keep the plain
 * source above.
 */
export function createMeteredPackageImportProxySource(input: {
	targetPath: string
	runtimeSpecifier: string
	packageId: string
	exportNames: Array<string>
}) {
	const packageIdJson = JSON.stringify(input.packageId)
	const namedExportLines = input.exportNames.flatMap((exportName, index) => {
		if (exportName === 'default') return []
		const localName = `__kodyMeteredStaticExport${index}`
		return [
			`const ${localName} = __kodyMeterStaticPackageExport(${packageIdJson}, __kodyPackageModule.${exportName});`,
			`export { ${localName} as ${exportName} };`,
		]
	})
	return `
export * from ${JSON.stringify(input.targetPath)};
import * as __kodyPackageModule from ${JSON.stringify(input.targetPath)};
import { __kodyMeterStaticPackageExport } from ${JSON.stringify(
		input.runtimeSpecifier,
	)};
export default __kodyMeterStaticPackageExport(${packageIdJson}, __kodyPackageModule.default);
${namedExportLines.join('\n')}
`.trim()
}

export function buildRemovedDynamicKodyImportMessage(specifier: string) {
	return (
		`Dynamic import(${JSON.stringify(specifier)}) was removed: use a static import ` +
		`(import fn from ${JSON.stringify(specifier)}) — execute bundles always see the current ` +
		`published version, and saved packages declare the dependency in package.json#kody.dependencies — ` +
		`or import(specifier) when the target package is data.`
	)
}

export function createDynamicPackageImportProxySource(input: {
	targetPath: string
}) {
	return `
// ${dynamicPackageImportResolvedMarker}
${createPackageImportProxySource(input)}
`.trim()
}

export function buildInternalKodyVirtualImportMessage(label: string) {
	return (
		`${label} references an internal Kody runtime module (.__kody_virtual__/). ` +
		`Import public helpers from "kody:runtime" instead.`
	)
}

export function createComputedDynamicImportGuardSource(input: {
	helperName: string
}) {
	// Coerce once, exactly as import() would, so a specifier object cannot
	// pass the check with one toString() and load a different path.
	//
	// Computed `kody:@` loads go through the host `__kodyComputedPackageImport`
	// bridge (library-load semantics for caller-owned / fork modules).
	return `
const ${input.helperName} = async (specifier) => {
	const resolvedSpecifier = \`\${specifier}\`;
	let decodedSpecifier = resolvedSpecifier;
	try {
		decodedSpecifier = decodeURIComponent(resolvedSpecifier);
	} catch {}
	if (
		/__kody_virtual__/i.test(resolvedSpecifier) ||
		/__kody_virtual__/i.test(decodedSpecifier)
	) {
		throw new Error(
			${JSON.stringify(buildInternalKodyVirtualImportMessage('Dynamic import'))},
		);
	}
	if (resolvedSpecifier.startsWith(${JSON.stringify(packageSpecifierPrefix)})) {
		const runtimeStorage = globalThis[Symbol.for('kody.runtimeStorage')];
		const computedPackageImport =
			runtimeStorage?.getStore?.()?.__kodyComputedPackageImport;
		if (
			computedPackageImport == null ||
			typeof computedPackageImport.callDefault !== 'function'
		) {
			throw new Error(
				'Dynamic kody:@ package import requires an authenticated runtime. Use a static import (import fn from "kody:@scope/package/export") when the package name is known at write time.',
			);
		}
		return {
			default: async (params) =>
				params === undefined
					? await computedPackageImport.callDefault({
							specifier: resolvedSpecifier,
						})
					: await computedPackageImport.callDefault({
							specifier: resolvedSpecifier,
							params,
						}),
		};
	}
	return await import(resolvedSpecifier);
};
`.trim()
}

export function createRemovedDynamicKodyImportHelperSource(input: {
	helperName: string
}) {
	// This permanent guard rewrites each unsupported literal dynamic kody:@
	// import to an actionable teaching error rather than a resolution error.
	return `
const ${input.helperName} = (specifier) => {
	throw new Error(
		'Dynamic import("' + specifier + '") was removed: use a static import (import fn from "' + specifier + '") — execute bundles always see the current published version, and saved packages declare the dependency in package.json#kody.dependencies — or import(specifier) when the target package is data.',
	);
};
`.trim()
}

export function createImportableEntrypointSource(input: {
	modulePath: string
}) {
	return `
export * from ${JSON.stringify(input.modulePath)};
import * as userModule from ${JSON.stringify(input.modulePath)};
export default userModule.default;
`.trim()
}

export function* iterateModuleSourceTexts(
	modules: WorkerLoaderModules,
): Generator<[modulePath: string, source: string]> {
	for (const [modulePath, module] of Object.entries(modules)) {
		if (typeof module === 'string') {
			yield [modulePath, module]
			continue
		}
		if (typeof module.js === 'string') {
			yield [modulePath, module.js]
		}
		if (typeof module.cjs === 'string') {
			yield [modulePath, module.cjs]
		}
		if (typeof module.text === 'string') {
			yield [modulePath, module.text]
		}
	}
}
