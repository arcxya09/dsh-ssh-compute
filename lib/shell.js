// Quoting helpers for the one place this plugin builds shell text: the command
// string that travels to a remote POSIX shell.
//
// Nothing here quotes for the LOCAL side. `ssh` is spawned from an argv array
// with no shell, so a path with spaces or `"` reaches ssh as one argument and
// only the remote shell ever parses it.

/**
 * Wrap a value in POSIX single quotes, escaping embedded quotes.
 * @param value - the text to quote.
 * @returns the quoted shell word.
 */
export function posixQuote(value) {
  const text = String(value)
  if (text === '') return "''"
  return `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * Escape a value for use INSIDE an already-double-quoted shell string.
 * `$HOME` expansion is why some paths use double quotes; anything else in the
 * value must not be re-expanded by the remote shell.
 * @param value - the text to escape.
 * @returns the escaped text with no surrounding quotes.
 */
export function doubleQuoteSafe(value) {
  return String(value).replace(/[\\"$`]/g, (character) => `\\${character}`)
}

/**
 * A remote directory expression that the remote shell can expand.
 *
 * `~/…` has to become `"$HOME/…"`, because a tilde inside quotes is literal. An
 * absolute path stays a single-quoted literal. The result always ends in a
 * closed quote, so callers may append `/segment` for generated names that need
 * no quoting.
 * @param remotePath - the configured directory, absolute or `~`-relative.
 * @returns the shell expression naming it.
 */
export function remotePathExpr(remotePath) {
  const text = String(remotePath ?? '').trim()
  const withoutTrailing = text.replace(/[/\\]+$/, '')
  if (text.startsWith('/') && withoutTrailing === '') return posixQuote('/')
  if (withoutTrailing === '' || withoutTrailing === '~') return '"$HOME"'
  if (withoutTrailing.startsWith('~/')) {
    return `"$HOME/${doubleQuoteSafe(withoutTrailing.slice(2))}"`
  }
  return posixQuote(withoutTrailing)
}

/**
 * The last path segment of a remote path, for display only.
 * @param remotePath - any path.
 * @returns the final segment.
 */
export function baseName(remotePath) {
  const text = String(remotePath ?? '').replace(/[/\\]+$/, '')
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return index < 0 ? text : text.slice(index + 1)
}

/**
 * Trim a trailing `\n` that a remote command adds to every one-line answer.
 * @param text - a captured stdout value.
 * @returns the value without its line ending.
 */
export function stripLineEnding(text) {
  return String(text ?? '').replace(/\r?\n$/, '')
}
