// The one process path.
//
// Everything here spawns from an argv array with no shell, so no local quoting
// is ever needed and a path with spaces reaches ssh intact. The remote command
// string is the only text a shell parses, and it is built in `remote.js`,
// `transfer.js` and `guard.js`.

import { spawn } from 'node:child_process'

/** Captured stdout beyond this is dropped; a job log belongs in `logs`, not here. */
const MAX_CAPTURE = 8 * 1024 * 1024

/**
 * Normalize a key option into a list of paths.
 * @param keyFiles - one path, several, or nothing.
 * @returns the paths to pass as `-i`.
 */
export function keyList(keyFiles) {
  if (keyFiles === undefined || keyFiles === null || keyFiles === '') return []
  return Array.isArray(keyFiles) ? keyFiles.filter((value) => typeof value === 'string' && value !== '') : [keyFiles]
}

/**
 * Build the ssh argv for one server.
 *
 * `BatchMode=yes` matters more than it looks: without it ssh asks for a
 * password on a terminal this process does not have, and the call hangs until
 * it times out. `accept-new` records an unknown host key once and still refuses
 * a CHANGED one, which is the only policy that works unattended.
 * @param config - the resolved configuration.
 * @param server - the target entry.
 * @param keyFiles - `-i` paths, or nothing to let ssh decide.
 * @returns the argv prefix, ending before the remote command.
 */
export function sshArgv(config, server, keyFiles) {
  const seconds = Math.max(1, Math.ceil(config.connectTimeoutMs / 1000))
  const argv = [
    'ssh',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${seconds}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'LogLevel=ERROR',
    '-p', String(server.port),
  ]
  // Every discovered key is offered in turn: a machine commonly holds two, and
  // only one of them is authorised on a given server.
  for (const file of keyList(keyFiles)) argv.push('-i', file)
  argv.push(`${server.user}@${server.host}`)
  return argv
}

/**
 * Run a process to completion, capturing bounded stdout.
 * @param argv - the program and its arguments.
 * @param options - stdin payload, working directory, deadline and abort signal.
 * @returns stdout bytes, stderr text, exit code and elapsed time.
 */
export function execProcess(argv, options = {}) {
  const { input, cwd, timeoutMs, signal, maxBytes = MAX_CAPTURE } = options
  return new Promise((resolve, reject) => {
    let settled = false
    const startedAt = Date.now()
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`dsh-ssh-compute: cannot start ${argv[0]}: ${error.message}`))
      return
    }

    const chunks = []
    let captured = 0
    let truncated = false
    let stderr = ''
    let timedOut = false
    let timer

    const finish = (error, code) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve({
        argv,
        code,
        stdout: Buffer.concat(chunks),
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    }

    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish(new Error('dsh-ssh-compute: the call was cancelled'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted === true) {
      onAbort()
      return
    }

    child.stdout?.on('data', (chunk) => {
      const room = maxBytes - captured
      if (room <= 0) {
        truncated = true
        return
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(Buffer.from(slice))
      captured += slice.length
      if (slice.length < chunk.length) truncated = true
    })
    child.stderr?.on('data', (chunk) => {
      // ssh diagnostics are short; keep the tail rather than growing forever.
      stderr += chunk.toString('utf8')
      if (stderr.length > 16384) stderr = stderr.slice(-16384)
    })

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(new Error(
          `dsh-ssh-compute: "${argv[0]}" was not found. SSH must be installed and on PATH for this plugin.`,
        ))
        return
      }
      finish(new Error(`dsh-ssh-compute: ${argv[0]} failed: ${error.message}`))
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish(new Error(
          `dsh-ssh-compute: "${argv[0]}" did not finish within ${timeoutMs} ms and was stopped.`,
        ))
        return
      }
      finish(undefined, code)
    })

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, timeoutMs)
      timer.unref?.()
    }

    if (input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => {
        // A closed pipe here means the remote end already gave up; the exit code
        // and stderr carry the reason.
      })
      child.stdin.end(input)
    }
  })
}

/**
 * Start a process whose stdin and stdout the caller pipes (file transfer).
 * @param argv - the program and its arguments.
 * @param options - working directory and stdio shape.
 * @returns the child process.
 */
export function spawnStreaming(argv, options = {}) {
  return spawn(argv[0], argv.slice(1), {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Run one ssh command and require success.
 * @param context - resolved configuration, server, key file and deadline.
 * @param command - the remote command string.
 * @returns the raw process result.
 */
export async function runSsh(context, command, options = {}) {
  const argv = [...sshArgv(context.config, context.server, context.keyFile), command]
  const result = await execProcess(argv, {
    timeoutMs: options.timeoutMs ?? context.config.commandTimeoutMs,
    maxBytes: options.maxBytes,
    input: options.input,
    signal: options.signal,
  })
  // A remote script may exit non-zero on purpose to report "no such job"; the
  // caller decides which codes are answers rather than failures.
  const answered = (options.expectedCodes ?? []).includes(result.code)
  if (result.code !== 0 && !answered) {
    const detail = result.stderr.trim() || `exit code ${result.code}`
    throw new Error(
      `dsh-ssh-compute: ${context.server.name} (${context.server.user}@${context.server.host}) ` +
      `refused or failed the call: ${detail}`,
    )
  }
  return result
}
