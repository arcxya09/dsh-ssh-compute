// Reading `~/.ssh/config`.
//
// The file is a list of blocks: a `Host` line names the patterns the block
// applies to, and the lines under it set options. ssh resolves one connection by
// walking the file top to bottom and taking the FIRST value it meets for each
// keyword, so a `Host *` block at the bottom supplies defaults and one at the top
// would win instead. This module reproduces that, because a config that looks
// fine by eye often resolves differently — `Port 2222` under a `Host *` that
// sits above `Host lab` is the small version of that surprise.
//
// What it deliberately does not do: `Include`, `Match`, and `ProxyCommand`.
// Those change which file or which options apply, and guessing would produce a
// server entry that connects somewhere else than the user's own ssh does.

import { readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/** A value that carries a wildcard or a negation, so it can never BE a server. */
const PATTERN_CHARS = /[*?!]/

/**
 * Split one line into a keyword and its value, dropping a trailing comment.
 *
 * ssh_config has no general quoting; a `#` starts a comment, and a double-quoted
 * run protects its own spaces and `#`. This is the same rule the client uses.
 * @param line - one non-empty, non-comment line.
 * @returns the lowercased keyword and the trimmed value.
 */
function splitLine(line) {
  let out = ''
  let quoted = false
  for (const character of line) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === '#' && !quoted) break
    out += character
  }
  const trimmed = out.trim()
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*)$/.exec(trimmed)
  if (match === null) return undefined
  return { keyword: match[1].toLowerCase(), value: (match[2] ?? '').trim() }
}

/**
 * Compile one `Host` pattern into a matcher.
 * @param pattern - a literal alias, or one with `*` / `?` / a leading `!`.
 * @returns the matcher and whether it is a negation.
 */
function compilePattern(pattern) {
  const negated = pattern.startsWith('!')
  const body = negated ? pattern.slice(1) : pattern
  const source = body
    .split('')
    .map((character) => {
      if (character === '*') return '.*'
      if (character === '?') return '.'
      return character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return { negated, test: new RegExp(`^${source}$`, 'i') }
}

/**
 * Whether one block applies to an alias.
 *
 * ssh applies the last matching pattern rule of a negation: a block whose
 * patterns all fail, or whose matching pattern is negated, does not apply.
 * @param patterns - the block's compiled patterns.
 * @param alias - the host alias being resolved.
 * @returns true when the block applies.
 */
function appliesTo(patterns, alias) {
  let matched = false
  for (const pattern of patterns) {
    if (!pattern.test.test(alias)) continue
    if (pattern.negated) return false
    matched = true
  }
  return matched
}

/**
 * Parse the text of an ssh config into ordered blocks.
 * @param text - the file's contents.
 * @returns the blocks, and the directives that were not understood.
 */
export function parseSshConfig(text) {
  const blocks = []
  const problems = []
  let current
  let lineNumber = 0
  for (const raw of String(text).split(/\r?\n/)) {
    lineNumber += 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const parsed = splitLine(raw)
    if (parsed === undefined) {
      problems.push(`line ${lineNumber}: not a directive (${line})`)
      continue
    }
    if (parsed.keyword === 'host') {
      const aliases = parsed.value.split(/\s+/).filter((value) => value !== '')
      current = { patterns: aliases.map(compilePattern), aliases, options: {}, lineNumber }
      blocks.push(current)
      continue
    }
    if (parsed.keyword === 'match') {
      // A Match block's options are conditional on more than the host name, so
      // nothing after it may be attributed to a host without evaluating it.
      current = undefined
      problems.push(`line ${lineNumber}: Match blocks are not read, so the options under this line are ignored`)
      continue
    }
    if (parsed.keyword === 'include') {
      problems.push(`line ${lineNumber}: Include is not followed, so the hosts it names are not listed`)
      continue
    }
    if (current === undefined) {
      // Directives before the first Host line apply to every connection in ssh's
      // own model; this plugin cannot represent them, so it reports them once.
      if (!problems.includes('options before the first Host block are ignored')) {
        problems.push('options before the first Host block are ignored')
      }
      continue
    }
    // First occurrence within a block wins, as it does in ssh.
    if (current.options[parsed.keyword] === undefined) current.options[parsed.keyword] = parsed.value
  }
  return { blocks, problems }
}

/** Expand a leading `~` the way ssh treats an identity file path. */
function expandTilde(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Turn one block's resolved options into a server entry for this plugin.
 * @param alias - the block's own alias.
 * @param options - every keyword resolved for it, first match wins.
 * @returns the importable entry.
 */
function toEntry(alias, options) {
  const notes = []
  const unsupported = []
  if (options.proxycommand !== undefined || options.proxyjump !== undefined) {
    unsupported.push('ProxyCommand/ProxyJump')
  }
  if (options.localcommand !== undefined) unsupported.push('LocalCommand')
  if (options.remotecommand !== undefined) unsupported.push('RemoteCommand')

  const host = options.hostname !== undefined && options.hostname !== '' ? options.hostname : alias
  if (options.hostname === undefined) notes.push('no HostName, so the alias is the address')

  const port = Number(options.port ?? 22)
  const usablePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 22
  if (options.port !== undefined && usablePort !== port) notes.push(`Port ${options.port} was not a usable port, so 22 is used`)

  let user = options.user ?? ''
  if (user === '') {
    user = userInfo().username
    notes.push('no User in the config, so this machine\'s user name is filled in')
  }

  let keyPath = ''
  const identity = options.identityfile ?? ''
  if (identity !== '') {
    // %d is the local home; the other tokens name remote-side facts this plugin
    // does not know before it connects.
    if (/%[a-z]/i.test(identity.replace(/%d/gi, ''))) {
      notes.push(`IdentityFile ${identity} uses ssh tokens; the path is kept as written`)
    }
    keyPath = expandTilde(identity.replace(/%d/gi, '~'))
  }

  return {
    alias,
    name: alias,
    host,
    port: usablePort,
    user,
    keyPath,
    notes,
    unsupported,
  }
}

/**
 * Every host in a config that can become a server, in file order.
 *
 * Only blocks whose `Host` line is a plain alias are candidates: `Host foo bar`
 * declares two, and a pattern like `Host *` or `Host *.example.com` declares
 * none this plugin could connect to.
 * @param text - the file's contents.
 * @returns the entries, plus the directives that were not understood.
 */
export function readHosts(text) {
  const { blocks, problems } = parseSshConfig(text)
  const entries = []
  const seen = new Set()
  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (alias === '' || PATTERN_CHARS.test(alias)) continue
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      // ssh resolves each keyword to the first value met while walking the file,
      // from every block that applies — including `Host *` defaults.
      const options = {}
      for (const candidate of blocks) {
        if (!appliesTo(candidate.patterns, alias)) continue
        for (const [keyword, value] of Object.entries(candidate.options)) {
          if (options[keyword] === undefined) options[keyword] = value
        }
      }
      entries.push(toEntry(alias, options))
    }
  }
  return { entries, problems }
}

/**
 * Read this machine's `~/.ssh/config`.
 * @param path - an override, used by tests.
 * @returns the path, whether it exists, the entries and any parsing problems.
 */
export function readSshConfigFile(path = join(homedir(), '.ssh', 'config')) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { path, exists: false, entries: [], problems: [] }
  }
  const { entries, problems } = readHosts(text)
  return { path, exists: true, entries, problems }
}
