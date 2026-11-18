import { expect, test } from 'vitest'
import {
	moduleSourceHasInlinedKodyRuntime,
	rewriteInlinedLocalExecuteBundleSource,
} from './rewrite-inlined-local-runtime.ts'
import { runtimeModulePath } from './module-graph-paths.ts'

const packageId = '2cc996d8-c0f5-4339-a6c1-9b6206123e96'
const dependencyPackageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function inlinedDropboxStyleBundle() {
	return `// virtual:.__kody_virtual__/runtime.js
import { AsyncLocalStorage } from "node:async_hooks";
var __kodyRuntimeStorage = new AsyncLocalStorage();
var __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
function __kodyOptionalRuntimeFunctionExport(exportName) {
  if (__kodyInitialRuntime === void 0) return void 0;
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var secretHeaders = void 0;
var oauthClientCredentials = void 0;
var runtime_default = { createAuthenticatedFetch };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
var __kodyPackageRuntimeDefault = new Proxy(runtime_default, {
  get(target, property, receiver) {
    if (property === "packageStorage") return packageStorage2;
    if (property === "packageSecrets") return packageSecrets2;
    return Reflect.get(target, property, receiver);
  },
});
var KodyRuntime2 = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });

// virtual:.__kody_root__/src/request.ts
var DROPBOX_INTEGRATION = "dropbox";
async function getAuthenticatedFetch() {
  return await createAuthenticatedFetch(DROPBOX_INTEGRATION);
}
export async function smokeTest() {
  const fetchFn = await getAuthenticatedFetch();
  return typeof fetchFn;
}
`
}

test('moduleSourceHasInlinedKodyRuntime detects virtual banner and optional CAF export', () => {
	expect(moduleSourceHasInlinedKodyRuntime(inlinedDropboxStyleBundle())).toBe(
		true,
	)
	expect(
		moduleSourceHasInlinedKodyRuntime(
			`import { createAuthenticatedFetch } from "./.__kody_virtual__/runtime.js"
export async function searchMessages() { return typeof createAuthenticatedFetch }`,
		),
	).toBe(false)
})

test('rewriteInlinedLocalExecuteBundleSource replaces inlined ALS runtime with shim factories', async () => {
	const modulePath =
		'.__kody_packages__/@kentcdodds/dropbox/.__published_bundle__/2e2f736d6f6b652d74657374/bundle.js'
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath,
		source: inlinedDropboxStyleBundle(),
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain('__kodyCreatePackageBoundAuthenticatedFetch')
	expect(result.source).toContain(
		'__kodyCreatePackageBoundOauthClientCredentials',
	)
	expect(result.source).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(result.source).toContain(
		`var fetch = __kodyCreatePackageBoundGatewayFetch(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(JSON.stringify(packageId))
	expect(result.source).toContain('// virtual:.__kody_root__/src/request.ts')
	expect(result.source).not.toContain(
		'__kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch")',
	)
	expect(result.source).not.toContain('AsyncLocalStorage')
	expect(result.source).not.toContain('// virtual:.__kody_virtual__/runtime.js')
	expect(result.source).not.toContain(
		'// virtual:.__kody_virtual__/package-runtime/',
	)
	// Preserve esbuild-renamed package host bindings for author body refs.
	expect(result.source).toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(
		`var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain('var packageStorage = packageStorage2;')
	expect(result.source).toContain('var packageSecrets = packageSecrets2;')
	expect(result.source).toContain('var __kodyPackageRuntimeDefault = {')
	expect(result.source).toContain(
		'var KodyRuntime2 = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });',
	)
	expect(result.source).toContain('var KodyRuntime = KodyRuntime2;')
	// Relative hop from nested published bundle up to graph-canonical runtime.
	expect(result.source).toMatch(
		/from ["'](?:\.\.\/)+.__kody_virtual__\/runtime\.js["']/,
	)
	expect(result.source).toContain('var DROPBOX_INTEGRATION = "dropbox"')
})

test('rewrite keeps author modules that appear before the inlined runtime', async () => {
	const source = `// virtual:.__kody_root__/src/helper.ts
function parse(value) { return String(value); }

// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
export async function main() {
  const fetchFn = await createAuthenticatedFetch("dropbox");
  return parse(typeof fetchFn);
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain('// virtual:.__kody_root__/src/helper.ts')
	expect(result.source).toContain('function parse(value)')
	expect(result.source).toContain('// virtual:.__kody_root__/src/entry.ts')
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
	// Helper must appear once (no duplicate leadingAuthor prepend) and before shim.
	expect(result.source.match(/function parse\(value\)/g)).toHaveLength(1)
	expect(result.source.indexOf('function parse(value)')).toBeLessThan(
		result.source.indexOf('__kodyCreatePackageBoundAuthenticatedFetch'),
	)
})

test('rewrite skips canonical aliases that collide with author bindings', async () => {
	const collisions = [
		{
			author: 'const { packageStorage } = { packageStorage: () => "author" };',
			kept: 'const { packageStorage }',
		},
		{
			author: 'export default function packageStorage() { return "author"; }',
			kept: 'export default function packageStorage()',
		},
		{
			author:
				'export default class packageStorage { static value = "author"; }',
			kept: 'export default class packageStorage',
		},
		{
			author: 'function packageStorage() { return "author"; }',
			kept: 'function packageStorage()',
		},
	]
	for (const { author, kept } of collisions) {
		const result = await rewriteInlinedLocalExecuteBundleSource({
			modulePath: 'bundle.js',
			source: `// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
${author}
export async function main() {
  return [typeof createAuthenticatedFetch, typeof packageStorage2, packageStorage];
}
`,
			primaryRuntimePath: runtimeModulePath,
		})
		expect(result.rewritten).toBe(true)
		expect(result.source).not.toContain('var packageStorage = packageStorage2;')
		expect(result.source).toContain(kept)
		expect(result.source).toContain('var packageSecrets = packageSecrets2;')
	}
})

test('rewrite remaps each multi-facade package binding to its own package id', async () => {
	// Tip 52b782167 / pre-fix main paired first binding names with the last
	// package id, so dependency packageStorage2 was rebound to the root id.
	const source = `// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/dependency.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(dependencyPackageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(dependencyPackageId)});

// virtual:.__kody_virtual__/package-runtime/root.js
var packageStorage3 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets3 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
export async function main() {
  return [typeof packageStorage2, typeof packageStorage3, typeof packageSecrets2, typeof packageSecrets3];
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(dependencyPackageId)});`,
	)
	expect(result.source).toContain(
		`var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(dependencyPackageId)});`,
	)
	expect(result.source).toContain(
		`var packageStorage3 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(
		`var packageSecrets3 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});`,
	)
	// Must not rebind the dependency facade names onto the root package id.
	expect(result.source).not.toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	expect(result.source).not.toContain(
		`var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});`,
	)
	// Canonical aliases point at the root (last) facade bindings.
	expect(result.source).toContain('var packageStorage = packageStorage3;')
	expect(result.source).toContain('var packageSecrets = packageSecrets3;')
	expect(result.source).toContain(
		`__kodyCreatePackageBoundAuthenticatedFetch(${JSON.stringify(packageId)})`,
	)
})

test('rewrite strips duplicate runtime banners without discarding author code', async () => {
	const source = `// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch2 = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
// virtual:.__kody_root__/src/entry.ts
export default async function main() { return 1 }
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain('// virtual:.__kody_root__/src/entry.ts')
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
	expect(
		result.source.match(
			/var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch/g,
		),
	).toHaveLength(1)
})

test('rewriteInlinedLocalExecuteBundleSource leaves external-import bundles alone', async () => {
	const source = `import { createAuthenticatedFetch } from "./.__kody_virtual__/runtime.js"
export async function searchMessages() { return typeof createAuthenticatedFetch }`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/google/.__published_bundle__/2e2f63616c656e646172/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result).toEqual({ source, rewritten: false, packageId: null })
})

test('rewrite skips shim locals that retained nested package runtime imports already bind', async () => {
	// npm-backed published bundles (e.g. kodykoala-activity reconcile) inline
	// dependency graphs that keep `import { kody, … }` from nested package
	// runtimes, then also contain an inlined optional-CAF runtime section.
	// Re-importing `kody` from the CapabilityProxy shim SyntaxErrors under
	// workerd ("Identifier 'kody' has already been declared").
	const nestedRuntime =
		'./.__kody_packages__/@kentcdodds/x/.__published_bundle__/2e2f6765742d706f7374/.__kody_virtual__/runtime.js'
	const source = `import { kody, createAuthenticatedFetch, secretHeaders, oauthClientCredentials, packageContext, email, workflows, packages, events } from ${JSON.stringify(nestedRuntime)};
import { __kodyCreatePackageBoundStorage, __kodyCreatePackageBoundSecrets } from ${JSON.stringify(nestedRuntime)};

// virtual:.__kody_virtual__/runtime.js
function __kodyOptionalRuntimeFunctionExport(exportName) {
  return () => {};
}
var runtime_default = { createAuthenticatedFetch: __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch") };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_root__/src/entry.ts
export async function main() {
  return [typeof kody, typeof createAuthenticatedFetch, typeof email];
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/kodykoala-activity/.__published_bundle__/2e2f7265636f6e63696c652d61637469766974792d6d6973736573/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain(
		`import { kody, createAuthenticatedFetch, secretHeaders, oauthClientCredentials, packageContext, email, workflows, packages, events } from ${JSON.stringify(nestedRuntime)}`,
	)
	// Shim hops to the graph-canonical runtime (not a nested published copy).
	const shimImportBodies = [
		...result.source.matchAll(
			/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
		),
	]
		.filter(
			(match) =>
				(match[2] ?? '').includes('.__kody_virtual__/runtime.js') &&
				!(match[2] ?? '').includes('.__kody_packages__'),
		)
		.map((match) => match[1] ?? '')
	expect(shimImportBodies.length).toBeGreaterThan(0)
	for (const body of shimImportBodies) {
		expect(body).not.toMatch(/(^|[\s,])kody([\s,]|$)/)
		expect(body).not.toMatch(/(^|[\s,])email([\s,]|$)/)
		expect(body).not.toMatch(/(^|[\s,])secretHeaders([\s,]|$)/)
		expect(body).not.toMatch(
			/(^|[\s,])createAuthenticatedFetch(\s+as\b|[\s,]|$)/,
		)
	}
	// packageStorage / packageSecrets were not in the retained imports — bind them.
	expect(result.source).toContain(
		'var packageStorage = __kodyShimPackageStorage',
	)
	expect(result.source).toContain(
		'var packageSecrets = __kodyShimPackageSecrets',
	)
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
})

test('rewrite stamped shim skips kody when author already imported it', async () => {
	const source = `import { kody, email } from "./dep-runtime.js";

// virtual:.__kody_virtual__/runtime.js
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/entry.ts
export async function main() {
  return typeof kody.metaGetCurrentUser;
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath: 'bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain(
		'import { kody, email } from "./dep-runtime.js"',
	)
	expect(result.source).not.toMatch(
		/import\s*\{[^}]*\bkody\b[^}]*\}\s*from\s*["'][^"']*__kody_virtual__\/runtime\.js["']/,
	)
	expect(result.source).toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
})

test('rewrite rebinds esbuild __esm package-runtime inits and storage names', async () => {
	// npm-backed published bundles wrap package-runtime facades in __esm:
	// `var packageStorage5;` + assignment inside init_<hex>(). Stripping that
	// section without re-emitting the init and renamed storage binding leaves
	// retained author modules with ReferenceError under local workerd.
	// Esbuild also renames colliding factory helpers (`…Storage` → `…Storage2`)
	// and shared ALS exports (`packageContext` → `packageContext6`).
	const initName =
		'init_d646661662d346238642d613236612d616461393339323234303331'
	const source = `import { kody, createAuthenticatedFetch, email } from "./dep-runtime.js";

// virtual:.__kody_virtual__/runtime.js
function __kodyOptionalRuntimeFunctionExport(exportName) {
  return () => {};
}
function __kodyCreateRuntimeRecordExport(exportName) {
  return { exportName };
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundStorage2(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets2(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch2 = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var packageContext6 = __kodyCreateRuntimeRecordExport("packageContext");
var runtime_default = { createAuthenticatedFetch: createAuthenticatedFetch2, packageContext: packageContext6 };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_virtual__/package-runtime/${packageId}.js
var packageStorage5;
var packageSecrets5;
var ${initName} = __esm({
  "virtual:.__kody_virtual__/package-runtime/${packageId}.js"() {
    packageStorage5 = __kodyCreatePackageBoundStorage2(${JSON.stringify(packageId)});
    packageSecrets5 = __kodyCreatePackageBoundSecrets2(${JSON.stringify(packageId)});
  }
});

// virtual:.__kody_root__/src/storage.ts
async function readPaused() {
  return await packageStorage5().get("paused");
}
function readHostedUrl() {
  return typeof packageContext6?.hostedUrl === "string" ? packageContext6.hostedUrl : null;
}
var init_storage = __esm({
  "virtual:.__kody_root__/src/storage.ts"() {
    ${initName}();
  }
});
export async function main() {
  return [typeof kody, typeof packageStorage5, await readPaused(), readHostedUrl()];
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/kodykoala-activity/.__published_bundle__/2e2f7265636f6e63696c652d61637469766974792d6d6973736573/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toContain(
		`var packageStorage5 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(
		`var packageSecrets5 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});`,
	)
	expect(result.source).toContain(
		'var packageContext6 = __kodyShimPackageContext;',
	)
	expect(result.source).toContain(`var ${initName} = () => {};`)
	expect(result.source).toContain(`${initName}();`)
	expect(result.source).not.toContain('__kodyOptionalRuntimeFunctionExport')
	expect(result.source).not.toContain('__kodyCreateRuntimeRecordExport')
	const shimImportBodies = [
		...result.source.matchAll(
			/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
		),
	]
		.filter(
			(match) =>
				(match[2] ?? '').includes('.__kody_virtual__/runtime.js') &&
				!(match[2] ?? '').includes('.__kody_packages__'),
		)
		.map((match) => match[1] ?? '')
	expect(shimImportBodies.length).toBeGreaterThan(0)
	for (const body of shimImportBodies) {
		expect(body).not.toMatch(/(^|[\s,])kody([\s,]|$)/)
	}
	expect(
		shimImportBodies.some((body) =>
			/packageContext\s+as\s+__kodyShimPackageContext/.test(body),
		),
	).toBe(true)
})

test('rewrite aliases packageContextN to shim even when author binds packageContext', async () => {
	// Nested retained modules may declare a local `packageContext` that is not
	// the shared ALS export. Renamed inlined copies must still bind to the
	// CapabilityProxy shim, not that author local.
	const source = `const packageContext = { hostedUrl: "author" };

// virtual:.__kody_virtual__/runtime.js
function __kodyCreateRuntimeRecordExport(exportName) {
  return { exportName, hostedUrl: "runtime" };
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var packageContext6 = __kodyCreateRuntimeRecordExport("packageContext");
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
var runtime_default = { packageContext: packageContext6, packageStorage: packageStorage2 };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_root__/src/status.ts
export function main() {
  return typeof packageContext6?.hostedUrl === "string" ? packageContext6.hostedUrl : null;
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/demo/.__published_bundle__/2e2f737461747573/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain(
		'var packageContext6 = __kodyShimPackageContext;',
	)
	expect(result.source).toContain(
		'const packageContext = { hostedUrl: "author" };',
	)
	expect(result.source).toMatch(
		/packageContext\s+as\s+__kodyShimPackageContext/,
	)
	expect(result.source).not.toContain('var packageContext6 = packageContext;')
})

test('rewrite aliases packageContextN referenced only in retained author modules', async () => {
	// Real npm-backed bundles can leave `packageContext6` referenced from
	// retained author code while the removable preamble only still shows the
	// package-bound storage factories (the shared-export declaration shape is
	// lost to inlining). Fall back to scanning retained identifiers.
	const source = `import { kody } from "./dep-runtime.js";

// virtual:.__kody_virtual__/runtime.js
function __kodyOptionalRuntimeFunctionExport(exportName) {
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch2 = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var packageStorage6 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets6 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
var runtime_default = { createAuthenticatedFetch: createAuthenticatedFetch2, packageStorage: packageStorage6 };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });

// virtual:.__kody_root__/src/activity-status.ts
export function main() {
  return typeof packageContext6?.hostedUrl === "string" ? packageContext6.hostedUrl : null;
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath:
			'.__kody_packages__/@kentcdodds/kodykoala-activity/.__published_bundle__/2e2f61637469766974792d736d6f6b652d74657374/bundle.js',
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.source).toContain(
		'var packageContext6 = __kodyShimPackageContext;',
	)
	expect(result.source).toContain(
		`var packageStorage6 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
})

test('rewrite does not bind bare typeof probes for shared export names', async () => {
	// `typeof email2 === "undefined"` must stay true under --local when the
	// removable sections never declared email2. Binding it to the shim would
	// flip intentional unbound feature probes (including multiline `typeof`).
	const inlinedPreamble = `function __kodyOptionalRuntimeFunctionExport(exportName) {
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch2 = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
var runtime_default = { createAuthenticatedFetch: createAuthenticatedFetch2 };
var KodyRuntime = Object.freeze({ defaultValue: runtime_default });`
	const probeBodies = [
		{
			author: `export function main() {
  return typeof email2 === "undefined";
}`,
			expectProbe: (source: string) => {
				expect(source).toContain('typeof email2 === "undefined"')
			},
		},
		{
			author: `export function main() {
  return (
    typeof
      email2 === "undefined"
  );
}`,
			expectProbe: (source: string) => {
				expect(source).toMatch(/typeof\s+email2/)
			},
		},
	]
	for (const { author, expectProbe } of probeBodies) {
		const source = `import { kody } from "./dep-runtime.js";

// virtual:.__kody_virtual__/runtime.js
${inlinedPreamble}

// virtual:.__kody_root__/src/probe.ts
${author}
`
		const result = await rewriteInlinedLocalExecuteBundleSource({
			modulePath:
				'.__kody_packages__/@kentcdodds/demo/.__published_bundle__/2e2f70726f6265/bundle.js',
			source,
			primaryRuntimePath: runtimeModulePath,
		})
		expect(result.rewritten).toBe(true)
		expectProbe(result.source)
		expect(
			[...result.source.matchAll(/\bas\s+(__kodyShim\w+)\b/g)].map((m) => m[1]),
		).not.toContain('__kodyShimEmail')
		expect(
			[...result.source.matchAll(/\bvar\s+(email\d+)\s*=/g)].map((m) => m[1]),
		).toEqual([])
	}
})

test('rewriteInlinedLocalExecuteBundleSource aliases shim factories shadowed by a composed legacy runtime copy', async () => {
	const modulePath =
		'.__kody_packages__/@acme/shades/.__published_bundle__/2e2f706c616e2d646179/bundle.js'
	const source = `// virtual:.__kody_packages__/@acme/forecast/.__published_bundle__/2e2f686973746f7279/bundle.js
function __kodyResolvePackageStorage(id) { throw new Error("cloud runtime store " + id); }
function __kodyCreatePackageBoundStorage(id) { return () => __kodyResolvePackageStorage(id); }
function __kodyOptionalRuntimeFunctionExport(exportName) { return void 0; }
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(dependencyPackageId)});
async function getForecast() { return await packageStorage2().get("forecast"); }

// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage3 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});

// virtual:.__kody_root__/src/plan-day.ts
export default async function planDay() {
  await packageStorage3().set("config", await getForecast());
}
`
	const result = await rewriteInlinedLocalExecuteBundleSource({
		modulePath,
		source,
		primaryRuntimePath: runtimeModulePath,
	})
	expect(result.rewritten).toBe(true)
	expect(result.packageId).toBe(packageId)
	expect(result.source).toMatch(
		/import \{[^}]*\b__kodyCreatePackageBoundStorage as __kodyShimCreatePackageBoundStorage\b[^}]*\}/,
	)
	expect(result.source).toContain(
		`var packageStorage3 = __kodyShimCreatePackageBoundStorage(${JSON.stringify(packageId)});`,
	)
	// The composed copy keeps its own declaration and stamped dependency binding.
	expect(result.source).toContain(
		`var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(dependencyPackageId)});`,
	)
	expect(result.source).toMatch(
		/import \{[^}]*\b__kodyCreatePackageBoundSecrets\b[^}]*\}/,
	)
})
