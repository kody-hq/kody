/**
 * Ad hoc execute code is a TypeScript ES module everywhere it runs. Kody
 * cloud bundles it as {@link executeModuleEntryFile}; the CLI (`execute
 * --local` and execution context daemons) transpiles it with the same loader
 * and target, so TypeScript that runs in one place runs in the others.
 */
export const executeModuleEntryFile = 'entry.ts'
export const executeModuleLoader = 'ts'
export const executeModuleTarget = 'es2022'
