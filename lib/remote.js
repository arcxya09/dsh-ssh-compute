// The remote job protocol.
//
// A job is a directory on the server and nothing else: no local table, no
// plugin state. Every later call re-reads the directory, so a restarted DSH, a
// second machine, or a colleague with the same key sees the same jobs.
//
//   ~/dsh-compute/<jobId>/
//     cmd.sh      the wrapper that was run (its first comment carries the command)
//     started     epoch seconds, written before the process starts
//     pid         the job process group leader
//     output.log  combined stdout and stderr
//     exit        the exit code, written when the command finishes
//     killed      present when this plugin terminated the job

import { randomBytes } from 'node:crypto'

import { posixQuote, remotePathExpr } from './shell.js'
import { runSsh } from './ssh.js'

/**
 * A new job id.
 *
 * The server name leads, so `status`, `logs` and `kill` can find the machine
 * from the id alone. The stamp is UTC, which keeps ids sortable across servers.
 * @param serverName - the server the job will run on.
 * @returns the job id.
 */
export function newJobId(serverName) {
  const now = new Date()
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('')
  return `${serverName}-${stamp}-${randomBytes(2).toString('hex')}`
}

/**
 * The shell expression naming one job directory.
 *
 * The id is generated here (letters, digits, dashes), so appending it outside
 * the root's quotes is safe and needs no second escape.
 * @param config - the resolved configuration.
 * @param jobId - the job id.
 * @returns a shell expression, quoted as needed.
 */
export function jobDirExpr(config, jobId) {
  return `${remotePathExpr(config.remoteRoot)}/${jobId}`
}

/** Reject an id that could not be one this plugin generated. */
export function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/.test(jobId)) {
    throw new Error(
      'dsh-ssh-compute: jobId must look like a job id this plugin created, e.g. `gpu01-20260101-120000-a1b2`',
    )
  }
}

/**
 * The wrapper script a job runs.
 *
 * The command goes inside a subshell so a lone `exit` in it ends the job rather
 * than the wrapper, and the exit code is captured after it either way. The
 * command itself is base64 in a comment, which keeps a multi-line or quoted
 * command out of the shell's parser when `list` shows it back.
 * @param context - job directory expression, working directory and command.
 * @returns the script text.
 */
export function buildWrapperScript(context) {
  const { dirExpr, workdirExpr, command, maxFileSizeMb } = context
  const label = Buffer.from(command, 'utf8').toString('base64')
  // bash reads `ulimit -f` in 1024-byte blocks, so the configured MiB value is the
  // block count. A job that exceeds it dies on SIGXFSZ (exit 153) instead of
  // filling the disk, which is the failure this plugin has already caused once.
  const limit = Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0
    ? [`ulimit -f ${Math.max(1, Math.round(maxFileSizeMb * 1024))} 2>/dev/null`]
    : []
  return [
    '#!/bin/bash',
    `#DSHCMD ${label}`,
    // No core dumps: a crashing numerical job must not fill the disk with a
    // multi-gigabyte core file next to its own output.
    'ulimit -c 0 2>/dev/null',
    ...limit,
    `cd ${workdirExpr} || { printf '127\\n' > ${dirExpr}/exit; exit 127; }`,
    '(',
    command,
    ')',
    `rc=$?`,
    // Duration is measured on the server, so it excludes the SSH round trip and
    // stays right even when the caller was disconnected while the job ran.
    `ended=$(date +%s)`,
    `printf '%s\\n' "$ended" > ${dirExpr}/ended`,
    `began=; read -r began 2>/dev/null < ${dirExpr}/started || :`,
    `case "$began" in ''|*[!0-9]*) began=$ended ;; esac`,
    `printf '%s\\n' "$(( ended - began ))" > ${dirExpr}/duration`,
    // `exit` is the completion marker, so it is written LAST: a reader that sees
    // it can rely on the duration (and the RSS sample) already being on disk.
    `printf '%s\\n' "$rc" > ${dirExpr}/exit`,
    'exit "$rc"',
    '',
  ].join('\n')
}

/** The command decoded back out of a wrapper script, for display. */
export function decodeLabel(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return ''
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * The remote launcher: one shell script that stages and starts a job.
 *
 * Three things here are deliberate. The concurrency gate counts inside this same
 * shell, so a `run` stays one round trip. The peak-memory sampler starts as soon
 * as the pid exists, because a job that allocates and exits in 100 ms would
 * otherwise be sampled after it was gone. And the environment probes run in the
 * background: they cost ~40 ms, nothing before the job starts reads `env.txt`,
 * and that latency belongs to the caller's round trip rather than to the record.
 * @param context - config, server and the job directory expression.
 * @returns the shell script to run on the server.
 */
export function buildLauncher(context) {
  const { config, server, dirExpr } = context
  const max = Math.max(0, Math.round(config.maxRunningJobs))
  const floor = Math.max(0, Math.round(config.minFreeSpaceMb))

  // A cap of 0 means "no cap", so the gate is not merely disabled — it is not
  // emitted. Compared as `running >= max` it would refuse every job, which is
  // what this code did until the bench caught it.
  const gate = max > 0 ? [
    `R=${remotePathExpr(config.remoteRoot)}`,
    'if [ -d "$R" ]; then',
    '  running=0',
    '  for d in "$R"/*/; do',
    '    [ -f "$d/pid" ] || continue',
    '    [ -f "$d/exit" ] && continue',
    '    p=; read -r p 2>/dev/null < "$d/pid" || :',
    '    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then running=$((running + 1)); fi',
    '  done',
    `  if [ "$running" -ge ${max} ]; then printf 'DSHMAXJOBS %s\\n' "$running"; exit 7; fi`,
    'fi',
  ] : []

  const space = floor > 0 ? [
    `avail=$(df -Pm "$D" 2>/dev/null | awk 'NR==2 {print $4}')`,
    `if [ -n "$avail" ] && [ "$avail" -lt ${floor} ]; then printf 'DSHNOSPACE %s\\n' "$avail"; exit 8; fi`,
  ] : []

  const record = config.recordResources === false ? [] : [
    '  {',
    "    printf 'hostname=%s\\n' \"$(hostname 2>/dev/null)\"",
    "    printf 'user=%s\\n' \"$(id -un 2>/dev/null)\"",
    "    printf 'cwd=%s\\n' \"$PWD\"",
    "    printf 'kernel=%s\\n' \"$(uname -srm 2>/dev/null)\"",
    "    printf 'started=%s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"",
    '    for c in python3 gcc g++ nvcc; do',
    '      v=$("$c" --version 2>/dev/null | head -n 1)',
    "      [ -n \"$v\" ] && printf '%s=%s\\n' \"$c\" \"$v\"",
    '    done',
    '  } > "$D/env.txt" 2>/dev/null &',
  ]

  const sample = config.recordResources === false ? [] : [
    // Peak memory of the whole job, not of the wrapper: `setsid` made the wrapper
    // a session leader, so every process the command started shares that id. The
    // page size is asked for rather than assumed to be 4 KiB.
    'if [ -n "$pid" ] && [ -r "/proc/$pid/stat" ]; then',
    '  ( pagesz=$(getconf PAGESIZE 2>/dev/null)',
    '    case "$pagesz" in \'\'|*[!0-9]*) pagesz=4096 ;; esac',
    '    best=0',
    '    while kill -0 "$pid" 2>/dev/null; do',
    "      cur=$(awk -v sid=\"$pid\" -v ps=\"$pagesz\" '$6 + 0 == sid + 0 { s += $24 } END { printf \"%d\", s * ps / 1024 }' /proc/[0-9]*/stat 2>/dev/null)",
    "      case \"$cur\" in ''|*[!0-9]*) cur=0 ;; esac",
    "      if [ \"$cur\" -gt \"$best\" ]; then best=$cur; printf '%s\\n' \"$best\" > \"$D/rss\"; fi",
    '      sleep 1',
    '    done ) >/dev/null 2>&1 &',
    'fi',
  ]

  return [
    `D=${dirExpr}`,
    'mkdir -p "$D" || exit 9',
    ...gate,
    ...space,
    'cat > "$D/cmd.sh" || exit 9',
    'chmod +x "$D/cmd.sh" 2>/dev/null',
    'date +%s > "$D/started"',
    'cd "$D" || exit 9',
    'if command -v setsid >/dev/null 2>&1; then',
    '  setsid nohup bash "$D/cmd.sh" > "$D/output.log" 2>&1 < /dev/null &',
    'else',
    '  nohup bash "$D/cmd.sh" > "$D/output.log" 2>&1 < /dev/null &',
    'fi',
    "printf '%s\\n' \"$!\" > \"$D/pid\"",
    'pid=; read -r pid 2>/dev/null < "$D/pid" || :',
    ...sample,
    ...record,
    'cat "$D/pid"',
  ].join('\n')
}

/**
 * Start a job and return its id and pid.
 * @param context - config, server, key file, command, working directory and deadline.
 * @returns the job id and the process-group leader.
 */
export async function startJob(context) {
  const { config, server, command, signal } = context
  const jobId = context.jobId ?? newJobId(server.name)
  const dirExpr = jobDirExpr(config, jobId)
  const workdirExpr = context.cwd === undefined || context.cwd === ''
    ? '"$HOME"'
    : remotePathExpr(context.cwd)
  const script = buildWrapperScript({
    dirExpr,
    workdirExpr,
    command,
    maxFileSizeMb: config.maxFileSizeMb,
  })

  // One connection: `cat` consumes this script from stdin, and the launcher only
  // starts after it has been written, so a dropped connection can never leave a
  // half-written script behind a running process.
  const remote = buildLauncher({ config, server, dirExpr, maxFileSizeMb: config.maxFileSizeMb })


  const result = await runSsh({ ...context, config, server }, remote, {
    input: script,
    timeoutMs: config.connectTimeoutMs + 15000,
    signal,
    expectedCodes: [7, 8],
  })
  const overLimit = /DSHMAXJOBS (\d+)/.exec(result.stdout.toString('utf8'))
  if (overLimit !== null) {
    throw new Error(
      `dsh-ssh-compute: ${server.name} already has ${overLimit[1]} jobs running, at the ` +
      `${config.maxRunningJobs} limit (maxRunningJobs). Wait for one to finish, kill one, ` +
      'or raise the limit in the settings.',
    )
  }
  const refusal = /DSHNOSPACE (\d+)/.exec(result.stdout.toString('utf8'))
  if (refusal !== null) {
    throw new Error(
      `dsh-ssh-compute: ${server.name} has only ${refusal[1]} MB free where jobs live, ` +
      `below the ${config.minFreeSpaceMb} MB floor. Free space, or lower minFreeSpaceMb.`,
    )
  }
  // A login shell may print a banner before the launcher's own line, so the pid is
  // the last non-empty line and only when it really is a number; `status` re-reads
  // the pid file anyway, this value is informational.
  const lines = result.stdout.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  const last = lines.at(-1) ?? ''
  const pid = /^\d+$/.test(last) ? last : ''
  return { jobId, dirExpr, pid, durationMs: result.durationMs }
}

/** Parse the `key=value` head of a status answer. */
function parseFacts(text) {
  const facts = new Map()
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (!/^[a-z]+$/.test(key)) continue
    facts.set(key, line.slice(index + 1))
  }
  return facts
}

/**
 * Read one job's state.
 * @param context - config, server, key file, job id and deadline.
 * @returns the parsed status and the log tail.
 */
export async function jobStatus(context) {
  const { config, server, jobId, signal } = context
  assertJobId(jobId)
  const dirExpr = jobDirExpr(config, jobId)
  const tail = Math.max(0, Math.min(400, context.tailLines ?? config.logTailLines))
  // One `printf` for every field, read with the `read` builtin: the first version
  // forked a `cat` per field, which is twelve processes for a five-line answer and
  // about 23 ms of the call. The only forks left are the size probe and `tail`.
  const remote = [
    `D=${dirExpr}`,
    '[ -d "$D" ] || { printf \'dsh=missing\\n\'; exit 3; }',
    'started=; read -r started 2>/dev/null < "$D/started" || :',
    'pid=; read -r pid 2>/dev/null < "$D/pid" || :',
    'exit_code=; read -r exit_code 2>/dev/null < "$D/exit" || :',
    'duration=; read -r duration 2>/dev/null < "$D/duration" || :',
    'rss=; read -r rss 2>/dev/null < "$D/rss" || :',
    'label=; { read -r first_line; read -r label_line; } 2>/dev/null < "$D/cmd.sh" || :',
    'label=${label_line#\\#DSHCMD }',
    'killed=no; [ -f "$D/killed" ] && killed=yes',
    'state=exited',
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then state=running; fi',
    'logsize=$(wc -c < "$D/output.log" 2>/dev/null)',
    'printf \'dsh=present\\nstarted=%s\\npid=%s\\nkilled=%s\\nstate=%s\\nexit=%s\\nlogsize=%s\\nduration=%s\\nrss=%s\\nlabel=%s\\n\' \\',
    '  "$started" "$pid" "$killed" "$state" "$exit_code" "${logsize// /}" "$duration" "$rss" "$label"',
    'printf -- \'---tail---\\n\'',
    `tail -n ${tail} "$D/output.log" 2>/dev/null`,
  ].join('\n')

  const result = await runSsh({ ...context, config, server }, remote, { signal, expectedCodes: [3] })
  const text = result.stdout.toString('utf8')
  const marker = text.indexOf('---tail---\n')
  const head = marker < 0 ? text : text.slice(0, marker)
  const logTail = marker < 0 ? '' : text.slice(marker + '---tail---\n'.length)
  const facts = parseFacts(head)
  if (facts.get('dsh') === 'missing') {
    throw new Error(
      `dsh-ssh-compute: no job ${jobId} on ${server.name}. ` +
      `Look in ${config.remoteRoot} on that server, or call action=list.`,
    )
  }
  return {
    jobId,
    server: server.name,
    state: facts.get('state') ?? 'unknown',
    pid: facts.get('pid') ?? '',
    started: Number(facts.get('started') ?? 0),
    exitCode: facts.get('exit') === undefined || facts.get('exit') === ''
      ? undefined
      : Number(facts.get('exit')),
    killed: facts.get('killed') === 'yes',
    logSize: Number(facts.get('logsize') ?? 0),
    label: decodeLabel(facts.get('label') ?? ''),
    durationSeconds: facts.get('duration') === undefined || facts.get('duration') === ''
      ? undefined
      : Number(facts.get('duration')),
    peakRssKb: facts.get('rss') === undefined || facts.get('rss') === ''
      ? undefined
      : Number(facts.get('rss')),
    logTail,
    durationMs: result.durationMs,
  }
}

/**
 * Block until a job finishes or the caller runs out of patience.
 *
 * One connection replaces a polling loop: the remote side watches for the `exit`
 * marker and answers once, so a five-minute job costs one 0.9 s round trip
 * instead of a hundred of them. The loop is also why the granularity is a
 * second — that is the price of not streaming.
 * @param context - config, server, key file, job id, timeout, tail lines and signal.
 * @returns the final state, the exit code when known, and the log tail.
 */
export async function waitJob(context) {
  const { config, server, jobId, signal } = context
  assertJobId(jobId)
  const dirExpr = jobDirExpr(config, jobId)
  const seconds = Math.max(1, Math.ceil((context.timeoutMs ?? config.waitTimeoutMs) / 1000))
  const tail = Math.max(0, Math.min(400, context.tailLines ?? config.logTailLines))
  const remote = [
    `D=${dirExpr}`,
    '[ -d "$D" ] || { printf \'dsh=missing\\n\'; exit 3; }',
    'pid=$(cat "$D/pid" 2>/dev/null)',
    `deadline=$(( $(date +%s) + ${seconds} ))`,
    // Poll finely at first and coarsely later: the moment a user notices is the
    // first few seconds, and a 1 s tick would add up to a second of tail latency
    // to every short job at almost no cost saved.
    'wait_start=$(date +%s)',
    'state=timeout',
    'while :; do',
    '  if [ -f "$D/exit" ]; then state=exited; break; fi',
    '  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then',
    // The process is gone but the wrapper has not written its marker yet: give it
    // a second, then report `lost` instead of burning the whole deadline.
    '    sleep 1',
    '    if [ -f "$D/exit" ]; then state=exited; break; fi',
    '    state=lost; break',
    '  fi',
    '  now=$(date +%s)',
    '  if [ "$now" -ge "$deadline" ]; then state=timeout; break; fi',
    '  if [ "$(( now - wait_start ))" -lt 3 ]; then sleep 0.1; else sleep 1; fi',
    'done',
    'printf \'dsh=present\\nstate=%s\\n\' "$state"',
    'printf \'exit=%s\\n\' "$(cat "$D/exit" 2>/dev/null)"',
    'pid=$(cat "$D/pid" 2>/dev/null)',
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf \'running=yes\\n\'; else printf \'running=no\\n\'; fi',
    'printf \'started=%s\\n\' "$(cat "$D/started" 2>/dev/null)"',
    'printf \'killed=%s\\n\' "$([ -f "$D/killed" ] && printf yes || printf no)"',
    'printf -- \'---tail---\\n\'',
    `tail -n ${tail} "$D/output.log" 2>/dev/null`,
  ].join('\n')

  const started = Date.now()
  const result = await runSsh({ ...context, config, server }, remote, {
    signal,
    expectedCodes: [3],
    // The remote loop bounds itself; this only has to outlive it by the connect
    // time plus a margin for a busy link.
    timeoutMs: (seconds + 20) * 1000,
  })
  const text = result.stdout.toString('utf8')
  if (text.includes('dsh=missing')) {
    throw new Error(
      `dsh-ssh-compute: no job ${jobId} on ${server.name}. Call action=list to see what is there.`,
    )
  }
  const marker = text.indexOf('---tail---\n')
  const facts = parseFacts(marker < 0 ? text : text.slice(0, marker))
  const logTail = marker < 0 ? '' : text.slice(marker + '---tail---\n'.length)
  return {
    jobId,
    server: server.name,
    state: facts.get('state') ?? 'unknown',
    exitCode: facts.get('exit') === undefined || facts.get('exit') === ''
      ? undefined
      : Number(facts.get('exit')),
    running: facts.get('running') === 'yes',
    killed: facts.get('killed') === 'yes',
    started: Number(facts.get('started') ?? 0),
    logTail,
    waitedMs: Date.now() - started,
  }
}

/**
 * Read a job's log, from an offset or as the last N lines.
 * @param context - config, server, key file, job id, offset, lines and deadline.
 * @returns the new bytes, the next offset and the total size.
 */
export async function readLog(context) {
  const { config, server, jobId, signal } = context
  assertJobId(jobId)
  const dirExpr = jobDirExpr(config, jobId)
  const maxBytes = Math.max(1024, Math.min(512 * 1024, context.maxBytes ?? config.maxLogBytes))

  if (context.lines !== undefined) {
    const lines = Math.max(1, Math.min(5000, Math.trunc(context.lines)))
    const remote = [
      `D=${dirExpr}`,
      '[ -f "$D/output.log" ] || { printf \'dsh=missing\\n\'; exit 4; }',
      `printf 'dsh=present\\nsize=%s\\n' "$(wc -c < "$D/output.log" | tr -d ' ')"`,
      "printf -- '---log---\\n'",
      `tail -n ${lines} "$D/output.log"`,
    ].join('\n')
    const result = await runSsh({ ...context, config, server }, remote, { signal, maxBytes: maxBytes + 4096, expectedCodes: [4] })
    const text = result.stdout.toString('utf8')
    const marker = text.indexOf('---log---\n')
    if (text.startsWith('dsh=missing')) {
      throw new Error(`dsh-ssh-compute: job ${jobId} on ${server.name} has no output log yet.`)
    }
    const facts = parseFacts(marker < 0 ? text : text.slice(0, marker))
    const body = marker < 0 ? '' : text.slice(marker + '---log---\n'.length)
    const size = Number(facts.get('size') ?? 0)
    return { text: body, nextOffset: size, size, truncated: result.truncated, durationMs: result.durationMs }
  }

  const offset = Math.max(0, Math.trunc(context.offset ?? 0))
  const remote = [
    `D=${dirExpr}`,
    '[ -f "$D/output.log" ] || { printf \'dsh=missing\\n\'; exit 4; }',
    `printf 'dsh=present\\nsize=%s\\n' "$(wc -c < "$D/output.log" | tr -d ' ')"`,
    "printf -- '---log---\\n'",
    `tail -c +${offset + 1} "$D/output.log" | head -c ${maxBytes}`,
  ].join('\n')

  const result = await runSsh({ ...context, config, server }, remote, { signal, maxBytes: maxBytes + 4096, expectedCodes: [4] })
  const buffer = result.stdout
  const marker = buffer.indexOf('---log---\n')
  if (marker < 0) {
    throw new Error(
      `dsh-ssh-compute: reading the log of ${jobId} on ${server.name} returned an unexpected answer.`,
    )
  }
  const head = buffer.subarray(0, marker).toString('utf8')
  if (head.startsWith('dsh=missing')) {
    throw new Error(`dsh-ssh-compute: job ${jobId} on ${server.name} has no output log yet.`)
  }
  const facts = parseFacts(head)
  const size = Number(facts.get('size') ?? 0)
  const body = buffer.subarray(marker + '---log---\n'.length)
  // A byte window can end inside a multi-byte character; drop that partial tail
  // so the next call starts on a character boundary.
  const cut = trimIncompleteUtf8(body)
  return {
    text: cut.toString('utf8'),
    nextOffset: offset + cut.length,
    size,
    truncated: result.truncated || (offset + body.length < size),
    durationMs: result.durationMs,
  }
}

/**
 * Drop a trailing incomplete UTF-8 sequence.
 * @param buffer - captured bytes.
 * @returns a buffer that decodes without a replacement character at its end.
 */
function trimIncompleteUtf8(buffer) {
  let end = buffer.length
  let seen = 0
  while (end > 0 && seen < 4) {
    const byte = buffer[end - 1]
    if ((byte & 0x80) === 0) return buffer.subarray(0, end)
    if ((byte & 0xc0) === 0xc0) {
      const needed = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4
      return end - 1 + needed <= buffer.length ? buffer : buffer.subarray(0, end - 1)
    }
    end -= 1
    seen += 1
  }
  return buffer
}

/**
 * Terminate a job.
 * @param context - config, server, key file, job id and deadline.
 * @returns whether a live process was found and what happened.
 */
export async function killJob(context) {
  const { config, server, jobId, signal } = context
  assertJobId(jobId)
  const dirExpr = jobDirExpr(config, jobId)
  const remote = [
    `D=${dirExpr}`,
    '[ -d "$D" ] || { printf \'dsh=missing\\n\'; exit 3; }',
    'pid=$(cat "$D/pid" 2>/dev/null)',
    'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
    '  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
    '  i=0',
    '  while [ "$i" -lt 5 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; i=$((i+1)); done',
    '  if kill -0 "$pid" 2>/dev/null; then',
    '    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null',
    '    sleep 1',
    '  fi',
    '  printf yes > "$D/killed"',
    '  printf \'dsh=present\\nkilled=yes\\nstate=running\\n\'',
    'else',
    '  printf \'dsh=present\\nkilled=no\\nstate=exited\\n\'',
    'fi',
    'if [ ! -f "$D/exit" ]; then printf \'143\\n\' > "$D/exit"; fi',
    'printf \'exit=%s\\n\' "$(cat "$D/exit" 2>/dev/null)"',
  ].join('\n')

  const result = await runSsh({ ...context, config, server }, remote, { signal, timeoutMs: 30000, expectedCodes: [3] })
  const text = result.stdout.toString('utf8')
  if (text.includes('dsh=missing')) {
    throw new Error(
      `dsh-ssh-compute: no job ${jobId} on ${server.name}. Call action=list to see what is there.`,
    )
  }
  const facts = parseFacts(text)
  return {
    jobId,
    server: server.name,
    killedProcess: facts.get('killed') === 'yes',
    exitCode: facts.get('exit') === undefined || facts.get('exit') === ''
      ? undefined
      : Number(facts.get('exit')),
  }
}

/**
 * List the jobs on one server, newest first.
 * @param context - config, server, key file, limit and deadline.
 * @returns one row per job directory.
 */
export async function listJobs(context) {
  const { config, server, signal } = context
  const rootExpr = remotePathExpr(config.remoteRoot)
  const limit = Math.max(1, Math.min(200, context.limit ?? config.listLimit))
  const remote = [
    `root=${rootExpr}`,
    '[ -d "$root" ] || { printf \'dsh=nodir\\n\'; exit 0; }',
    "printf 'dsh=present\\n---jobs---\\n'",
    'for d in "$root"/*/; do',
    '  [ -d "$d" ] || continue',
    '  # Only directories this plugin created are jobs; an upload target is not one.',
    '  [ -f "$d/cmd.sh" ] || continue',
    '  b=${d%/}; b=${b##*/}',
    // `read`, not `$(cat ...)`: this loop runs once per job directory, and a fork
    // per field per job is what turns `list` from 50 ms into seconds at scale.
    '  started=; read -r started 2>/dev/null < "$d/started" || :',
    '  pid=; read -r pid 2>/dev/null < "$d/pid" || :',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then st=running; else st=finished; fi',
    '  ex=; read -r ex 2>/dev/null < "$d/exit" || :',
    '  printf \'%s\\t%s\\t%s\\t%s\\n\' "$b" "$started" "$st" "$ex"',
    'done | sort -k2,2nr | head -n ' + String(limit),
  ].join('\n')

  const result = await runSsh({ ...context, config, server }, remote, { signal, timeoutMs: 30000 })
  const text = result.stdout.toString('utf8')
  if (text.includes('dsh=nodir')) return []
  const marker = text.indexOf('---jobs---\n')
  const body = marker < 0 ? '' : text.slice(marker + '---jobs---\n'.length)
  return body.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [jobId, started, state, exitCode] = line.split('\t')
    return {
      jobId,
      started: Number(started ?? 0),
      state,
      exitCode: exitCode === undefined || exitCode === '' ? undefined : Number(exitCode),
    }
  })
}

/**
 * Normalize one monitor sample's `key=value` text.
 *
 * Split out from the ssh call so the arithmetic can be tested without a server:
 * a wrong total or a load triple in the wrong order is invisible until the panel
 * draws it.
 * @param text - the launcher's key=value lines.
 * @returns the metrics the panel draws.
 */
export function parseMonitorFacts(text) {
  const facts = parseFacts(text)
  const numbers = (value) => {
    const text = (value ?? '').trim()
    // An absent value is not zero: `Number('')` is 0, which would draw a load
    // line of exactly 0 for a host that simply did not report one.
    if (text === '') return []
    return text.split(/\s+/).map(Number).filter(Number.isFinite)
  }
  const load = numbers(facts.get('load')).slice(0, 3)
  const mem = numbers(facts.get('mem'))
  const disk = numbers(facts.get('disk'))
  return {
    hostname: (facts.get('hostname') ?? '').trim(),
    kernel: (facts.get('kernel') ?? '').trim(),
    cpus: numbers(facts.get('cpus'))[0] ?? 0,
    load,
    memTotalMb: mem[0] ?? 0,
    memAvailableMb: mem[1] ?? 0,
    diskTotalMb: disk[0] ?? 0,
    diskUsedMb: disk[1] ?? 0,
    diskFreeMb: disk[2] ?? 0,
    uptimeSec: numbers(facts.get('uptime'))[0] ?? 0,
    runningJobs: numbers(facts.get('jobs'))[0] ?? 0,
  }
}

/**
 * Read one server's current state in a single connection.
 *
 * Everything the panel shows comes out of one shell invocation: a poll that cost
 * three round trips would be the whole cost of the panel. Values that a system
 * does not expose degrade to zero rather than failing the sample, because a
 * missing `/proc/loadavg` is not a reason to show the server as offline.
 * @param context - config, server, key file and signal.
 * @returns the parsed metrics and how long the call took.
 */
export async function monitorServer(context) {
  const { config, server, keyFile, signal } = context
  const remote = [
    `R=${remotePathExpr(config.remoteRoot)}`,
    'printf \'hostname=%s\\n\' "$(hostname 2>/dev/null)"',
    'printf \'kernel=%s\\n\' "$(uname -sr 2>/dev/null)"',
    'printf \'cpus=%s\\n\' "$(nproc 2>/dev/null || echo 0)"',
    'L=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)',
    'printf \'load=%s\\n\' "$L"',
    'M=$(awk \'/MemTotal/ { t = $2 } /MemAvailable/ { a = $2 } END { if (t) printf "%d %d", t / 1024, a / 1024 }\' /proc/meminfo 2>/dev/null)',
    'printf \'mem=%s\\n\' "$M"',
    'D=$(df -Pm "$R" 2>/dev/null | awk \'NR == 2 { printf "%d %d %d", $2, $3, $4 }\')',
    'printf \'disk=%s\\n\' "$D"',
    'printf \'uptime=%s\\n\' "$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
    // Live jobs: the same rule the concurrency gate uses, so the panel and the
    // gate never disagree about what "running" means.
    'n=0',
    'if [ -d "$R" ]; then',
    '  for d in "$R"/*/; do',
    '    [ -f "$d/pid" ] || continue',
    '    [ -f "$d/exit" ] && continue',
    '    p=; read -r p < "$d/pid" || :',
    '    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then n=$((n + 1)); fi',
    '  done',
    'fi',
    'printf \'jobs=%s\\n\' "$n"',
  ].join('\n')

  const result = await runSsh({ ...context, config, server }, remote, {
    signal,
    timeoutMs: config.connectTimeoutMs + 10000,
  })
  return { ...parseMonitorFacts(result.stdout.toString('utf8')), durationMs: result.durationMs }
}

/**
 * Ask a server what it is. Used by the detail page's test button and by the
 * agent's own first call on a new machine.
 * @param context - config, server, key file and deadline.
 * @returns the facts and how long the round trip took.
 */
export async function probeServer(context) {
  const { config, server, signal } = context
  const remote = [
    "printf 'hostname=%s\\n' \"$(hostname 2>/dev/null || uname -n)\"",
    "printf 'kernel=%s\\n' \"$(uname -srm)\"",
    "printf 'cpu=%s\\n' \"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '?')\"",
    "printf 'mem_mb=%s\\n' \"$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo '?')\"",
    "printf 'load=%s\\n' \"$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)\"",
    "printf 'gpu=%s\\n' \"$(command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | tr '\\n' ';' || echo none)\"",
    "printf 'rsync=%s\\n' \"$(command -v rsync >/dev/null 2>&1 && echo yes || echo no)\"",
    "printf 'tar=%s\\n' \"$(command -v tar >/dev/null 2>&1 && echo yes || echo no)\"",
    "printf 'home=%s\\n' \"${HOME:-?}\"",
  ].join('\n')
  const result = await runSsh({ ...context, config, server }, remote, {
    signal,
    timeoutMs: Math.max(10000, config.connectTimeoutMs + 5000),
  })
  return { facts: parseFacts(result.stdout.toString('utf8')), durationMs: result.durationMs }
}

/** A `keyword=value` line pair, exported for the detail page's route. */
export function factPairs(map) {
  return [...map.entries()].map(([key, value]) => [key, value])
}

/** Quote one path for a remote shell, re-exported so callers need one import fewer. */
export { posixQuote }
