// Private-key resolution.
//
// Three sources, in order: key material pasted into the settings, a configured
// path, and finally whatever this machine already has in `~/.ssh`. An entry
// that resolves to nothing passes no `-i` at all, which is the right answer for
// a machine whose keys live in `~/.ssh/config` or an agent.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverPrivateKeys, expandHome } from './config.js'

/**
 * A per-mount holder for the key files this plugin writes itself.
 *
 * Pasted key material has to become a file before ssh can use it. The file
 * lives in the system temp directory, is named after a digest so two servers
 * sharing one key share one file, and is removed when the plugin unloads.
 * @returns the store: `fileFor(server)` and `dispose()`.
 */
export function createKeyStore() {
  const directory = join(tmpdir(), 'dsh-ssh-compute')
  /** absolute path -> nothing; a Set so two entries can own the same file. */
  const written = new Set()

  /**
   * Describe what a server will authenticate with, without touching the disk
   * beyond what `fileFor` already does. The detail page shows this.
   * @param server - one normalized entry.
   * @returns a short label and the path when there is one.
   */
  const describe = (server) => {
    if (server.keyText !== '') return { source: 'inline', path: undefined, count: 1 }
    if (server.keyPath !== '') return { source: 'path', path: expandHome(server.keyPath), count: 1 }
    const detected = discoverPrivateKeys()
    return detected.length === 0
      ? { source: 'default', path: undefined, count: 0 }
      : { source: 'detected', path: detected[0], count: detected.length }
  }

  return {
    describe,

    /**
     * The `-i` paths for one server, or an empty list to let ssh decide.
     *
     * More than one is normal: a machine commonly holds two keys and only one of
     * them is authorised on a given server. Passing a single `-i` would suppress
     * ssh's own identity list and turn that into `Permission denied (publickey)`
     * for a key that works.
     * @param server - one normalized entry.
     * @returns existing private-key files, most preferred first.
     */
    fileFor(server) {
      let resolved = []
      if (server.keyText !== '') {
        const digest = createHash('sha256').update(server.keyText).digest('hex').slice(0, 16)
        const target = join(directory, `${digest}.key`)
        if (!written.has(target)) {
          mkdirSync(directory, { recursive: true })
          const body = server.keyText.endsWith('\n') ? server.keyText : `${server.keyText}\n`
          writeFileSync(target, body, { mode: 0o600 })
          try {
            // Windows ignores the POSIX mode; the deep temp directory and the
            // per-user profile ACL are what protect it there.
            chmodSync(target, 0o600)
          } catch {
            // Nothing to do: the write already succeeded with the mode above.
          }
          written.add(target)
        }
        resolved = [target]
      } else if (server.keyPath !== '') {
        const expanded = expandHome(server.keyPath)
        if (!existsSync(expanded)) {
          throw new Error(
            `dsh-ssh-compute: the key file for server "${server.name}" does not exist: ${expanded}`,
          )
        }
        resolved = [expanded]
      } else {
        resolved = discoverPrivateKeys()
      }
      return resolved
    },

    /** Remove the files this mount wrote. Configured keys are never touched. */
    dispose() {
      for (const target of written) {
        try {
          rmSync(target, { force: true })
        } catch {
          // A leftover temp file is harmless; removing it again next run is enough.
        }
      }
      written.clear()
    },
  }
}
