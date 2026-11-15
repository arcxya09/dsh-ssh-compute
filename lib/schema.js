// How this plugin gets the schema builder behind `Config`.
//
// Two facts make this more than a one-line import:
//
// 1. `@deepseek-ai/schemastery` exports the builder as its DEFAULT export, so
//    the namespace of `await import(...)` is `{ default: Schema }`. Destructuring
//    a named `Schema` yields `undefined` without any error, the plugin then
//    declares no `Config`, and its settings page silently disappears.
// 2. A bundle installed from a local directory is a `link:` symlink. Node
//    resolves a module to its REAL path, so `@deepseek-ai/schemastery` is looked
//    up beside the source checkout instead of beside the profile that provides
//    it — and is not found. The settings page would be missing for exactly the
//    install shape this plugin ships in.
//
// So resolution tries the normal way first and then the profile's own copy, and
// failing both costs only the settings page: the tool keeps working on defaults.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGE = '@deepseek-ai/schemastery'

/**
 * Pick the schema builder out of a module namespace.
 *
 * A named `Schema` export and a `Schema` property on the default are accepted
 * too: other DSH packages re-export the builder in those shapes, and the check
 * is about what can actually build a schema, not about one package.
 * @param namespace - a module namespace (`await import(...)`), or anything else.
 * @returns the builder, or null when the namespace carries none.
 */
export function pickSchemaBuilder(namespace) {
  if (namespace === null || typeof namespace !== 'object') return null
  const candidates = [namespace.Schema, namespace.default?.Schema, namespace.default]
  for (const candidate of candidates) {
    // `object` is the entry point every Config needs: requiring it turns a wrong
    // export shape into "no settings page" instead of a throw while the
    // composition is already being built.
    if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') {
      return candidate
    }
  }
  return null
}

/**
 * The entry file of an installed copy of the package.
 * @param directory - a directory whose `node_modules` holds the package.
 * @returns an absolute path, or undefined when it is not installed there.
 */
function entryIn(directory) {
  const root = join(directory, 'node_modules', ...PACKAGE.split('/'))
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const exported = manifest.exports?.['.']
    const relative = typeof exported === 'string'
      ? exported
      : exported?.import ?? exported?.default ?? manifest.module ?? manifest.main
    if (typeof relative === 'string') return join(root, relative)
  } catch {
    // Fall through to `createRequire`, which honours the exports map itself.
  }
  try {
    return createRequire(join(directory, 'noop.cjs')).resolve(PACKAGE)
  } catch {
    return undefined
  }
}

/**
 * Load the schema builder, wherever this installation keeps it.
 * @param env - the process environment; `DSH_PROFILE_DIR` is the useful one.
 * @returns the builder, or null when no usable copy was found.
 */
export async function loadSchemaBuilder(env = process.env) {
  const tried = []
  try {
    const builder = pickSchemaBuilder(await import(PACKAGE))
    if (builder !== null) return builder
    tried.push('package resolved but exported no builder')
  } catch (error) {
    tried.push(`package not resolvable from the plugin: ${error.message}`)
  }

  const directories = [env.DSH_PROFILE_DIR]
  // A checkout launched without a profile still has the installation beside it.
  if (env.DSH_HOME !== undefined) directories.push(env.DSH_HOME)
  for (const directory of directories) {
    if (typeof directory !== 'string' || directory === '') continue
    const entry = entryIn(directory)
    if (entry === undefined) {
      tried.push(`no copy in ${directory}`)
      continue
    }
    try {
      const builder = pickSchemaBuilder(await import(pathToFileURL(entry).href))
      if (builder !== null) return builder
      tried.push(`no builder exported by ${entry}`)
    } catch (error) {
      tried.push(`${entry}: ${error.message}`)
    }
  }

  console.warn(`dsh-ssh-compute: no settings schema (${tried.join('; ')})`)
  return null
}
