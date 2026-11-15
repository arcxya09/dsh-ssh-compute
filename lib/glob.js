// Local path expansion for upload.
//
// `upload` accepts plain paths, several of them, directories, and `*` / `?` /
// `**` patterns. A local shell never sees the patterns (ssh is spawned from an
// argv array), so the expansion has to happen here or a pattern would travel to
// the server as a literal filename.

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Whether one path segment contains pattern syntax. */
function hasMagic(segment) {
  return /[*?[\]]/.test(segment)
}

/**
 * Compile one pattern segment into an anchored regular expression.
 * @param segment - one path segment.
 * @returns the matcher.
 */
function segmentMatcher(segment) {
  let pattern = ''
  for (const character of segment) {
    if (character === '*') pattern += '[^/]*'
    else if (character === '?') pattern += '[^/]'
    else if (character === '[') pattern += '['
    else if (character === ']') pattern += ']'
    else pattern += character.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`, WINDOWS ? 'i' : '')
}

/** List the entries of one directory, or nothing when it is unreadable. */
function entries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Walk one segment list from a starting directory.
 * @param directory - where the walk stands (forward slashes).
 * @param segments - the remaining pattern segments.
 * @param index - which segment is next.
 * @param found - the accumulator.
 */
function walk(directory, segments, index, found) {
  if (index >= segments.length) {
    found.push(directory)
    return
  }
  const segment = segments[index]
  if (segment === '**') {
    // `**` matches zero or more directories: continue here, or descend once and retry.
    walk(directory, segments, index + 1, found)
    for (const entry of entries(directory)) {
      if (!entry.isDirectory()) continue
      walk(`${directory}/${entry.name}`, segments, index, found)
    }
    return
  }
  if (!hasMagic(segment)) {
    const candidate = `${directory}/${segment}`
    if (index === segments.length - 1) {
      try {
        statSync(candidate)
        found.push(candidate)
      } catch {
        // A missing final segment is a missing match, reported by the caller.
      }
      return
    }
    walk(candidate, segments, index + 1, found)
    return
  }
  const matcher = segmentMatcher(segment)
  for (const entry of entries(directory)) {
    if (!matcher.test(entry.name)) continue
    const candidate = `${directory}/${entry.name}`
    if (index === segments.length - 1) {
      found.push(candidate)
      continue
    }
    if (entry.isDirectory()) walk(candidate, segments, index + 1, found)
  }
}

/** Convert a platform path to the forward-slash form the walker uses. */
function toForwardSlashes(path) {
  return String(path).replace(/\\/g, '/')
}

/**
 * Expand the caller's local paths into existing absolute paths.
 * @param patterns - paths or patterns, relative to `cwd` when not absolute.
 * @param cwd - the directory a relative pattern resolves against.
 * @returns the matched paths and the patterns that matched nothing.
 */
export function expandLocalPaths(patterns, cwd) {
  const matches = []
  const missing = []
  for (const raw of patterns) {
    const text = String(raw ?? '').trim()
    if (text === '') continue
    const absolute = isAbsolute(text) ? text : join(cwd, text)
    const forward = toForwardSlashes(absolute)
    if (!/[*?[\]]/.test(forward)) {
      try {
        statSync(absolute)
        matches.push(normalize(absolute))
        continue
      } catch {
        missing.push(text)
        continue
      }
    }
    const rooted = forward.startsWith('/')
    const segments = forward.split('/').filter((segment) => segment !== '' && segment !== '.')
    // A Windows drive keeps its `C:` as the first segment and is not a child of `/`.
    const drive = /^[A-Za-z]:$/.test(segments[0] ?? '') ? segments.shift() : undefined
    const start = drive !== undefined ? `${drive}/` : rooted ? '/' : ''
    const found = []
    walk(start === '' ? '.' : start, segments, 0, found)
    if (found.length === 0) {
      missing.push(text)
      continue
    }
    for (const hit of found) matches.push(normalize(hit))
  }
  const unique = [...new Set(matches)]
  unique.sort((left, right) => left.localeCompare(right))
  return { matches: unique, missing }
}

/**
 * The deepest directory that contains every path.
 *
 * tar needs one `-C` directory and relative names, and this is how both are
 * derived without ever passing an absolute path to tar.
 * @param paths - absolute file or directory paths.
 * @returns the shared ancestor directory.
 */
export function commonParent(paths) {
  if (paths.length === 0) return undefined
  const roots = paths.map((path) => toForwardSlashes(path).split('/').filter(Boolean))
  const shared = []
  const shortest = Math.min(...roots.map((parts) => parts.length))
  for (let index = 0; index < shortest; index += 1) {
    const value = roots[0][index]
    if (!roots.every((parts) => parts[index] === value)) break
    shared.push(value)
  }
  // A Windows drive is its own root: `C:/x`, never `/C:/x`. Building the path as a
  // POSIX one turned every Windows upload into an archive rooted at the drive,
  // which extracted a `Users/` tree instead of the files.
  const toAbsolute = (segments) => {
    const joined = segments.join('/')
    return /^[A-Za-z]:$/.test(segments[0]) ? `${joined}/` : `/${joined}`
  }
  // The last shared element may be a FILE, so step back one when it is not a directory.
  while (shared.length > 0) {
    const absolute = toAbsolute(shared)
    try {
      if (statSync(absolute).isDirectory()) return absolute
    } catch {
      // Fall through to the parent.
    }
    shared.pop()
  }
  return undefined
}

/**
 * A path relative to a base directory, in the platform's separators.
 * @param base - the containing directory.
 * @param path - an absolute path inside it.
 * @returns the relative path.
 */
export function relativeTo(base, path) {
  const value = relative(base, path)
  return value === '' ? '.' : value
}

/** Re-export for callers that need the platform separator. */
export { sep }
