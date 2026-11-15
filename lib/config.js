// Configuration: what a server entry means, which entry a call names, and the
// defaults that keep the tool usable with an almost-empty settings form.

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A server name that can be a path segment and part of a job id. */
export const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** An address or user name with no whitespace, quote or control character. */
const TOKEN_RE = /^[^\s'"`\\\x00-\x1f\x7f]+$/

/** Where job directories live when the settings leave `remoteRoot` empty. */
export const DEFAULT_REMOTE_ROOT = '~/dsh-compute'

/**
 * Private keys tried, in order, when an entry names none. These are the names
 * `ssh-keygen` gives its own defaults, so an existing setup needs no copying.
 */
const KEY_CANDIDATES = [
  'id_ed25519',
  'id_ecdsa',
  'id_rsa',
  'id_dsa',
  'id_ed25519_sk',
]

/**
 * Expand a leading `~` to the home directory of the user DSH runs as.
 *
 * Only a LEADING `~` is expanded; ssh itself does not expand anything, and a
 * path from the settings form is handed to `-i` verbatim.
 * @param path - a configured path, possibly `~`-relative.
 * @returns an absolute path, or the input when it has no leading `~`.
 */
export function expandHome(path) {
  const text = String(path ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/**
 * The private keys that exist in `~/.ssh`, best-known names first.
 *
 * Discovery is a convenience, not a decision: the first hit is what a server
 * entry without `keyPath` uses, and an empty answer means ssh falls back to its
 * own configuration and agent.
 * @returns absolute paths, most preferred first.
 */
export function discoverPrivateKeys() {
  const directory = join(homedir(), '.ssh')
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const usable = (name) => {
    if (name.endsWith('.pub')) return false
    if (name === 'known_hosts' || name === 'config' || name === 'authorized_keys') return false
    if (name.endsWith('.backup') || name.endsWith('.old')) return false
    try {
      return statSync(join(directory, name)).isFile()
    } catch {
      return false
    }
  }
  const ordered = []
  for (const candidate of KEY_CANDIDATES) {
    if (usable(candidate)) ordered.push(join(directory, candidate))
  }
  // Anything else key-shaped is still better than nothing, after the defaults.
  for (const name of names.sort()) {
    if (!name.startsWith('id_') || !usable(name)) continue
    const full = join(directory, name)
    if (!ordered.includes(full)) ordered.push(full)
  }
  return ordered
}

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does not resolve to its value: schemastery wraps
 * it with cosmokit's `createVolatile(default)`. The cell is written IN PLACE
 * when the user edits the row, which is what makes an edit apply without
 * remounting the plugin — so reading through `.get()` is both required for
 * correctness and how live updates arrive. A plain value (a hand-built settings
 * object in a test, or an older host) passes through untouched.
 * @param value - a configuration field, possibly a volatile cell.
 * @returns the current value.
 */
export function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * One server entry, with the fields the tool needs and nothing else.
 *
 * A half-written entry is reported and skipped rather than thrown: the settings
 * form writes the whole array at once, so saving a card that is still missing
 * its host must not take the plugin down.
 * @param raw - the configured object.
 * @param index - its position, for messages.
 * @param problems - where an unusable entry is reported.
 * @returns the normalized entry, or undefined when it cannot be used.
 */
function normalizeServer(raw, index, problems) {
  if (raw === null || typeof raw !== 'object') {
    problems.push(`servers[${index}] is not an object and was ignored`)
    return undefined
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const user = typeof raw.user === 'string' ? raw.user.trim() : ''
  // The name is not decoration: a job id starts with it, and the job directory is
  // built as `<quoted root>/<job id>` with the id OUTSIDE the quotes. A name with a
  // space, a quote or a shell metacharacter would therefore change the remote
  // command, so only a path-safe token is accepted.
  if (name !== '' && !SERVER_NAME_RE.test(name)) {
    problems.push(`server name "${name}" may only use letters, digits, dot, dash and underscore (1-64 characters) and was ignored`)
    return undefined
  }
  if (name === '' && host === '' && user === '') {
    // An empty card the user added and has not filled in yet: silent, since it is
    // the expected state during editing.
    return undefined
  }
  if (name === '') {
    problems.push(`servers[${index}] ("${host}") has no name and was ignored`)
    return undefined
  }
  if (host === '') {
    problems.push(`server "${name}" has no address and was ignored`)
    return undefined
  }
  if (user === '') {
    problems.push(`server "${name}" has no user and was ignored`)
    return undefined
  }
  // `user@host` travels as one argv element, so whitespace is legal for ssh but
  // never for anything this plugin builds out of it; quotes and control bytes are
  // refused outright.
  for (const [field, value] of [['address', host], ['user', user]]) {
    if (!TOKEN_RE.test(value)) {
      problems.push(`server "${name}" has an unusable ${field} (${JSON.stringify(value)}) and was ignored`)
      return undefined
    }
  }
  const port = Number(raw.port ?? 22)
  return {
    name,
    host,
    user,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    keyPath: typeof raw.keyPath === 'string' ? raw.keyPath.trim() : '',
    keyText: typeof raw.keyText === 'string' ? raw.keyText.trim() : '',
  }
}

/**
 * Turn the plugin's settings row into the values the tool reads.
 *
 * Called on every tool call rather than once at mount: every field is volatile,
 * so the cells it reads hold the user's latest edit without a remount.
 * @param settings - the row's config, possibly every field a volatile cell.
 * @returns the resolved configuration and the entries that could not be used.
 */
export function resolveConfig(settings = {}) {
  const raw = unbox(settings.servers)
  const list = Array.isArray(raw) ? raw : []
  const problems = []
  const servers = []
  const seen = new Set()
  for (let index = 0; index < list.length; index += 1) {
    const server = normalizeServer(list[index], index, problems)
    if (server === undefined) continue
    const key = server.name.toLowerCase()
    if (seen.has(key)) {
      problems.push(`server "${server.name}" is defined twice; only the first entry is used`)
      continue
    }
    seen.add(key)
    servers.push(server)
  }
  const number = (value, fallback) => {
    const parsed = Number(unbox(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const text = (value) => {
    const raw = unbox(value)
    return typeof raw === 'string' ? raw.trim() : ''
  }
  return {
    servers,
    problems,
    remoteRoot: text(settings.remoteRoot) || DEFAULT_REMOTE_ROOT,
    guard: unbox(settings.guard) !== false,
    connectTimeoutMs: number(settings.connectTimeoutMs, 15000),
    commandTimeoutMs: number(settings.commandTimeoutMs, 30000),
    logTailLines: number(settings.logTailLines, 40),
    maxLogBytes: number(settings.maxLogBytes, 65536),
    listLimit: number(settings.listLimit, 60),
  }
}

/**
 * The one server a call runs against.
 *
 * A single configured server needs no name; with several, the name is required
 * so a typo cannot silently run a job on the wrong machine.
 * @param config - the resolved configuration.
 * @param requested - the call's `server` argument.
 * @param fallback - a server name inferred from a job id, used when the call names none.
 * @returns the server entry.
 */
export function selectServer(config, requested, fallback) {
  const wanted = (typeof requested === 'string' && requested.trim() !== '')
    ? requested.trim()
    : (typeof fallback === 'string' ? fallback : '')
  if (wanted === '') {
    if (config.servers.length === 0) {
      throw new Error('dsh-ssh-compute: no servers are configured. Add one in Plugins → SSH compute.')
    }
    if (config.servers.length === 1) return config.servers[0]
    throw new Error(
      `dsh-ssh-compute: more than one server is configured, so \`server\` is required. ` +
      `Available: ${config.servers.map((server) => server.name).join(', ')}`,
    )
  }
  const exact = config.servers.find((server) => server.name === wanted)
  const loose = exact ?? config.servers.find((server) => server.name.toLowerCase() === wanted.toLowerCase())
  if (loose !== undefined) return loose
  const names = config.servers.map((server) => server.name).join(', ')
  throw new Error(
    config.servers.length === 0
      ? `dsh-ssh-compute: server "${wanted}" is not configured; no servers are configured yet.`
      : `dsh-ssh-compute: server "${wanted}" is not configured. Available: ${names}`,
  )
}

/**
 * The server name a job id starts with, or `undefined` when it names none.
 *
 * A job id is `<server>-<stamp>-<random>`, so `status`, `logs` and `kill` can
 * find their machine without the caller repeating it.
 * @param config - the resolved configuration.
 * @param jobId - the call's job id.
 * @returns the matching server name.
 */
export function serverNameFromJobId(config, jobId) {
  if (typeof jobId !== 'string') return undefined
  return config.servers
    .filter((server) => jobId.startsWith(`${server.name}-`))
    .sort((left, right) => right.name.length - left.name.length)
    .at(0)?.name
}
