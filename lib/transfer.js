// File movement.
//
// rsync is preferred when BOTH ends have it, because it resumes and only sends
// what changed. It is not assumed: this plugin also runs on Windows, where rsync
// is usually absent, so the fallback streams a tar archive through the ssh
// connection — one channel, no extra daemon, and the same path for one file,
// many files, whole directories and patterns.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

import { commonParent, expandLocalPaths, relativeTo } from './glob.js'
import { posixQuote, remotePathExpr } from './shell.js'
import { controlPath, execProcess, keyList, sshArgv } from './ssh.js'

/** Transfers legitimately run longer than a command round trip. */
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000

/** Whether a local `rsync` exists. Probed once per process, not per call. */
let localRsync

/** server name -> whether that server has rsync. */
const remoteRsync = new Map()

/**
 * Whether the local host can run rsync.
 * @returns true when `rsync --version` succeeds.
 */
async function hasLocalRsync() {
  if (localRsync !== undefined) return localRsync
  try {
    await execProcess(['rsync', '--version'], { timeoutMs: 8000, maxBytes: 4096 })
    localRsync = true
  } catch {
    localRsync = false
  }
  return localRsync
}

/**
 * Whether one server has rsync.
 * @param context - config, server and key file.
 * @returns true when the remote shell finds `rsync`.
 */
async function hasRemoteRsync(context) {
  const cached = remoteRsync.get(context.server.name)
  if (cached !== undefined) return cached
  try {
    const result = await execProcess(
      [...sshArgv(context.config, context.server, context.keyFile), 'command -v rsync >/dev/null 2>&1 && echo yes || echo no'],
      { timeoutMs: context.config.connectTimeoutMs + 5000, maxBytes: 1024 },
    )
    const found = result.stdout.toString('utf8').includes('yes')
    remoteRsync.set(context.server.name, found)
    return found
  } catch {
    remoteRsync.set(context.server.name, false)
    return false
  }
}

/**
 * The `-e` value rsync hands to its own ssh invocation.
 *
 * rsync splits this string on spaces, so every ssh option travels in its
 * attached form (`-oName=value`). A spaced `-o Name=value` would be torn apart.
 * @param context - config, server and key file.
 * @returns the rsh command string.
 */
function rsyncRemoteShell(context) {
  const parts = [
    'ssh',
    '-p', String(context.server.port),
    '-oBatchMode=yes',
    '-oStrictHostKeyChecking=accept-new',
    `-oConnectTimeout=${Math.max(1, Math.ceil(context.config.connectTimeoutMs / 1000))}`,
  ]
  if (context.keyFile !== undefined && context.keyFile !== null && context.keyFile !== '') {
    for (const file of keyList(context.keyFile)) parts.push('-i', file)
  }
  // rsync splits `-e` on spaces itself, so an extra argument that needs its own
  // space (a ProxyCommand, say) is not expressible here — `-J host` and single
  // tokens are. Documented in the README rather than silently dropped.
  for (const token of context.server.extraArgs ?? []) parts.push(token)
  // rsync splits `-e` on spaces, so the multiplexing options travel attached.
  if (context.config.reuseConnection !== false && process.platform !== 'win32') {
    parts.push(
      '-oControlMaster=auto',
      `-oControlPath=${controlPath(context.server)}`,
      `-oControlPersist=${Math.max(0, Math.round(context.config.reuseIdleSeconds ?? 300))}`,
    )
  }
  return parts.join(' ')
}

/**
 * Split one remote path into the directory tar reads from and the name inside it.
 *
 * Doing this per source lets `tar -C <dir> <name>` name every member relative to
 * its own directory, so downloading `~/dsh-compute/run/out.txt` produces
 * `out.txt` rather than `root/dsh-compute/run/out.txt`.
 * @param source - an absolute or `~`-relative path, possibly ending in a pattern.
 * @returns the directory expression and the name within it.
 */
function splitRemoteSource(source) {
  // A trailing slash names the directory itself, and `tar -C <dir> ''` fails with a
  // confusing message, so it is removed before the split.
  const text = String(source ?? '').trim().replace(/\/+$/, '')
  if (text === '') return { directory: '/', name: '' }
  const index = text.lastIndexOf('/')
  if (index < 0) return { directory: '.', name: text }
  if (index === 0) return { directory: '/', name: text.slice(1) }
  return { directory: text.slice(0, index), name: text.slice(index + 1) }
}

/**
 * A remote name tar can take: unquoted when it carries a pattern the server
 * should expand, single-quoted otherwise so a space or a dash stays literal.
 * @param name - the last segment of a remote path.
 * @returns the shell word.
 */
function remoteNameWord(name) {
  return /[*?[\]]/.test(name) ? name : posixQuote(name)
}

/**
 * Pipe one process's stdout into another's stdin and wait for both.
 *
 * Both ends are reported even when one fails: a non-zero producer with a clean
 * consumer means "nothing was sent", which reads very differently from a
 * consumer that could not unpack what arrived.
 * @param producer - the packing side.
 * @param consumer - the unpacking side.
 * @param timeoutMs - deadline for the whole pair.
 * @returns both exit codes and both stderr tails.
 */
function pipePair(producer, consumer, timeoutMs) {
  return new Promise((resolve, reject) => {
    let producerErr = ''
    let consumerErr = ''
    let producerCode
    let consumerCode
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        try { producer.kill('SIGKILL') } catch { /* gone */ }
        try { consumer.kill('SIGKILL') } catch { /* gone */ }
        finish(new Error(`dsh-ssh-compute: the transfer did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`))
      }, timeoutMs)
      : undefined
    timer?.unref?.()

    producer.on('error', (error) => finish(new Error(`dsh-ssh-compute: ${error.message}`)))
    consumer.on('error', (error) => finish(new Error(`dsh-ssh-compute: ${error.message}`)))
    // A consumer that exits early closes the pipe; the producer's EPIPE is the
    // shape of that failure and its cause is reported by the consumer instead.
    producer.stdout.on('error', () => {})
    consumer.stdin.on('error', () => {})
    producer.stderr.on('data', (chunk) => {
      producerErr += chunk.toString('utf8')
      if (producerErr.length > 16384) producerErr = producerErr.slice(-16384)
    })
    consumer.stderr.on('data', (chunk) => {
      consumerErr += chunk.toString('utf8')
      if (consumerErr.length > 16384) consumerErr = consumerErr.slice(-16384)
    })
    producer.stdout.pipe(consumer.stdin)
    producer.on('close', (code) => {
      producerCode = code
      if (code !== 0) {
        try { consumer.stdin.end() } catch { /* already gone */ }
      }
      if (consumerCode !== undefined) {
        finish(undefined, { producerCode, consumerCode, producerErr, consumerErr })
      }
    })
    consumer.on('close', (code) => {
      consumerCode = code
      if (producerCode !== undefined) {
        finish(undefined, { producerCode, consumerCode, producerErr, consumerErr })
      }
    })
  })
}

/**
 * Copy local paths to a directory on the server.
 * @param context - config, server, key file, local patterns, remote target, cwd
 *   and an optional `transport` override used by tests.
 * @returns how many paths were sent, which transport ran, and what matched nothing.
 */
export async function upload(context) {
  const { config, server } = context
  const sources = Array.isArray(context.local) ? context.local : [context.local]
  const { matches, missing } = expandLocalPaths(sources, context.cwd)
  if (matches.length === 0) {
    throw new Error(`dsh-ssh-compute: none of these local paths exist: ${missing.join(', ')}`)
  }
  const remoteTarget = String(context.remote ?? '').trim()
  if (remoteTarget === '') throw new Error('dsh-ssh-compute: upload needs `remote`, the target directory on the server')

  const targetExpr = remotePathExpr(remoteTarget)
  await execProcess(
    [...sshArgv(config, server, context.keyFile), `mkdir -p ${targetExpr}`],
    { timeoutMs: config.connectTimeoutMs + 15000 },
  )

  const allowRsync = context.transport !== 'tar'
    && await hasLocalRsync()
    && await hasRemoteRsync(context)

  if (allowRsync) {
    const argv = [
      'rsync', '-az', '--partial',
      '-e', rsyncRemoteShell(context),
      '--', ...matches, `${server.user}@${server.host}:${remoteTarget}`,
    ]
    const result = await execProcess(argv, { timeoutMs: TRANSFER_TIMEOUT_MS, maxBytes: 65536 })
    if (result.code !== 0) {
      throw new Error(
        `dsh-ssh-compute: rsync upload to ${server.name} failed: ` +
        `${result.stderr.trim() || `exit code ${result.code}`}`,
      )
    }
    return { transport: 'rsync', count: matches.length, missing }
  }

  const base = commonParent(matches)
  if (base === undefined) throw new Error('dsh-ssh-compute: these paths share no common parent directory')
  const relatives = matches.map((path) => relativeTo(base, path).replace(/\\/g, '/'))
  const packer = spawn('tar', ['-cf', '-', '--', ...relatives], {
    cwd: base,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const unpackArgv = sshArgv(config, server, context.keyFile)
  unpackArgv.push(`tar -xf - -C ${targetExpr}`)
  const unpacker = spawn(unpackArgv[0], unpackArgv.slice(1), {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  unpacker.stdout.on('data', () => {})
  const outcome = await pipePair(packer, unpacker, TRANSFER_TIMEOUT_MS)
  if (outcome.consumerCode !== 0) {
    throw new Error(
      `dsh-ssh-compute: extracting the archive on ${server.name} failed: ` +
      `${outcome.consumerErr.trim() || `exit code ${outcome.consumerCode}`}`,
    )
  }
  if (outcome.producerCode !== 0) {
    throw new Error(
      `dsh-ssh-compute: packing the local files failed: ` +
      `${outcome.producerErr.trim() || `exit code ${outcome.producerCode}`}`,
    )
  }
  return { transport: 'tar', count: matches.length, missing }
}

/**
 * Copy paths from the server into a local directory.
 * @param context - config, server, key file, remote patterns, local target, cwd
 *   and an optional `transport` override used by tests.
 * @returns how many remote arguments were requested and where they landed.
 */
export async function download(context) {
  const { config, server } = context
  const sources = (Array.isArray(context.remote) ? context.remote : [context.remote])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '')
  if (sources.length === 0) throw new Error('dsh-ssh-compute: download needs at least one remote path')
  if (sources.some((source) => source.replace(/^\/+$|^~\/*$/, '') === '')) {
    throw new Error('dsh-ssh-compute: download needs a file or directory path, not the server root')
  }
  const localTarget = String(context.local ?? '').trim() || context.cwd
  // tar -C needs the directory to exist; creating it is what a user expects from
  // "download into this path", and the alternative is a bare tar error.
  mkdirSync(localTarget, { recursive: true })

  if (context.transport !== 'tar' && await hasLocalRsync() && await hasRemoteRsync(context)) {
    const argv = [
      'rsync', '-az', '--partial',
      '-e', rsyncRemoteShell(context),
      '--', ...sources.map((value) => `${server.user}@${server.host}:${value}`), localTarget,
    ]
    const result = await execProcess(argv, { timeoutMs: TRANSFER_TIMEOUT_MS, maxBytes: 65536 })
    if (result.code !== 0) {
      throw new Error(
        `dsh-ssh-compute: rsync download from ${server.name} failed: ` +
        `${result.stderr.trim() || `exit code ${result.code}`}`,
      )
    }
    return { transport: 'rsync', count: sources.length, target: localTarget }
  }

  // GNU tar and bsdtar both accept repeated `-C`, so every member is named
  // relative to its own directory and the extracted tree stays flat.
  const parts = []
  for (const source of sources) {
    const { directory, name } = splitRemoteSource(source)
    parts.push(`-C ${remotePathExpr(directory)}`, remoteNameWord(name))
  }
  const remoteCommand = `tar -cf - ${parts.join(' ')}`
  const packArgv = sshArgv(config, server, context.keyFile)
  packArgv.push(remoteCommand)
  const packer = spawn(packArgv[0], packArgv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const unpacker = spawn('tar', ['-xf', '-', '-C', localTarget], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  packer.stdout.on('error', () => {})
  unpacker.stdout.on('data', () => {})
  const outcome = await pipePair(packer, unpacker, TRANSFER_TIMEOUT_MS)
  if (outcome.consumerCode !== 0) {
    throw new Error(
      `dsh-ssh-compute: extracting the archive locally failed: ` +
      `${outcome.consumerErr.trim() || `exit code ${outcome.consumerCode}`}`,
    )
  }
  if (outcome.producerCode !== 0) {
    throw new Error(
      `dsh-ssh-compute: ${server.name} could not produce the archive: ` +
      `${outcome.producerErr.trim() || `exit code ${outcome.producerCode}`}`,
    )
  }
  return { transport: 'tar', count: sources.length, target: localTarget }
}
