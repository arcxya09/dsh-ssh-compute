// dsh-ssh-compute — one tool that hands the agent a remote machine.
//
// The plugin owns exactly one capability: start a job on a configured SSH
// server, then look at it, read it, stop it, and move files both ways. It does
// not decide what is "compute-heavy" and it installs nothing: the agent probes
// the machine (`nproc`, `free`, `nvidia-smi`) and decides for itself.
//
// Shape of a job is a directory on the server — see `lib/remote.js`, which is
// also why this plugin keeps no state of its own.

import { resolve } from 'node:path'

import { resolveConfig, selectServer, serverNameFromJobId } from './lib/config.js'
import { createKeyStore } from './lib/keys.js'
import { assertCommandAllowed, assertUploadAllowed } from './lib/guard.js'
import { startJob, jobStatus, readLog, killJob, listJobs, probeServer } from './lib/remote.js'
import { readSshConfigFile } from './lib/sshconfig.js'
import { upload, download } from './lib/transfer.js'
import { loadSchemaBuilder } from './lib/schema.js'

export const name = 'dsh-ssh-compute'
export const inject = ['tools']

// The schema is what gives this plugin a settings surface: the platform
// projects the config of every entry that declares one. Loading the builder must
// never be what decides whether the tool exists, so a missing or incompatible
// package only costs the settings page.
const Schema = await loadSchemaBuilder()

/**
 * The settings the plugin exposes.
 *
 * EVERY field is `.volatile()`, and that is not decoration. DSH's settings
 * service projects a plugin's config into a form only through `volatileForm()`,
 * which keeps a field only when its nearest ancestor is marked volatile — a
 * schema without one disappears from `describe()` entirely, and the page sees
 * `configForms` report the namespace as unavailable. A volatile field also
 * resolves to a live cell rather than a value, so an edit is written in place
 * and read at call time without remounting this plugin; `resolveConfig`
 * unboxes them.
 *
 * A volatile field must not sit inside another volatile one, so the server
 * ARRAY is the volatile field and its element fields are plain.
 */
function defineConfig(builder) {
  return builder.object({
    servers: builder.array(builder.object({
      name: builder.string().default('').description('短名字，工具的 `server` 参数用它引用这台机器，如 gpu01。'),
      host: builder.string().default('').description('地址或域名。'),
      port: builder.number().default(22).description('SSH 端口，默认 22。'),
      user: builder.string().default('').description('登录用户名。'),
      keyPath: builder.string().default('').description('私钥文件路径。留空则自动使用 ~/.ssh 下的第一个私钥；一个都没找到就不传 -i，交给 ssh 自己的配置和 agent。'),
      keyText: builder.string().default('').description('直接粘贴私钥内容（优先级高于 keyPath）。会写到系统临时目录的 0600 文件，插件卸载时删除。'),
    }).description('一台远程服务器')).description('可用的远程服务器列表。省略 `server` 仅在只配了一台时有效。').volatile(),
    remoteRoot: builder.string().default('~/dsh-compute').description('远端任务目录。每个任务是其中的一个子目录，含 cmd.sh、pid、exit、output.log。').volatile(),
    guard: builder.boolean().default(true).description('拦截明显破坏性的远端命令（rm -rf /、mkfs、dd 到磁盘等）和往系统目录的上传。调用方传 allowDangerous: true 可放行。').volatile(),
    connectTimeoutMs: builder.number().default(15000).description('建立 SSH 连接的超时（毫秒）。').volatile(),
    commandTimeoutMs: builder.number().default(30000).description('非任务命令（status/logs/kill 等）的超时（毫秒）。').volatile(),
    logTailLines: builder.number().default(40).description('status 顺带返回的日志行数；0 表示不返回。').volatile(),
    maxLogBytes: builder.number().default(65536).description('logs 一次最多返回的字节数。').volatile(),
    listLimit: builder.number().default(60).description('list 最多返回多少个任务。').volatile(),
  }).description('dsh-ssh-compute 的远程服务器与默认值。')
}

/** This plugin's config schema, or undefined when no builder is available. */
export const Config = Schema === null ? undefined : defineConfig(Schema)

/** The read-only routes the detail page's test button calls. */
const SERVERS_ROUTE = '/dsh-ssh-compute/servers'
const TEST_ROUTE = '/dsh-ssh-compute/test'
/** The hosts this machine's own ssh already knows, offered to the settings form. */
const SSH_CONFIG_ROUTE = '/dsh-ssh-compute/ssh-config'

/** Read a JSON body with a small ceiling; these payloads are one server name. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 65536) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Answer one JSON value with the headers a page fetch needs. */
function answerJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** The session directory a relative local path resolves against. */
function sessionDirectory(exec) {
  const directory = exec?.agent?.session?.header?.cwd
  return typeof directory === 'string' && directory !== '' ? directory : process.cwd()
}

/**
 * Build the single model-facing tool.
 *
 * The settings row is held, not a resolved snapshot: every field is volatile and
 * resolves per call, so a server added or edited in the settings page is used by
 * the very next call without remounting this plugin.
 * @param context - the settings row and this mount's key store.
 * @returns the tool definition.
 */
function createTool(context) {
  const { settings, keyStore } = context

  return {
    name: 'ssh-compute',
    description:
      'Run work on a remote SSH server instead of this machine. Reach for it when a task is compute-heavy ' +
      '(long builds, training, large numerics, many parallel jobs) or when the local machine is the wrong ' +
      'place for it; quick local edits and reads stay local. ' +
      'The servers are the ones configured in this plugin\'s settings (Plugins → SSH compute); `list` names them. ' +
      'A run always starts a background job and returns a job id at once, so poll `status` for the exit code ' +
      'and `logs` for progress; `kill` stops a job. `upload` and `download` move files both ways. ' +
      'On a machine you have not used before, first run something like `nproc; free -g; nvidia-smi -L; df -h` ' +
      'to see what it actually is, then decide how to use it.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'status', 'logs', 'kill', 'list', 'upload', 'download'],
          description:
            '`run` starts a job; `status` reports one job; `logs` reads its output; `kill` stops it; ' +
            '`list` shows the servers, or the jobs on one server; `upload`/`download` copy files.',
        },
        server: {
          type: 'string',
          description:
            'Server name, as `list` prints it. Required for `run`/`upload`/`download` when more than one is ' +
            'configured, and optional when only one is; `status`/`logs`/`kill` can infer it from the job id. ' +
            'Omit `server` on `list` to list the servers.',
        },
        command: {
          type: 'string',
          description:
            'run: the shell command, run with bash on the server inside a subshell. Use it for everything ' +
            'from one command to a whole script; multi-line text is fine. Its exit code is captured.',
        },
        jobId: {
          type: 'string',
          description: 'status/logs/kill: the id `run` returned, e.g. `gpu01-20261115-020000-a1b2`.',
        },
        cwd: {
          type: 'string',
          description: 'run: the directory the command starts in on the server. Defaults to the login home.',
        },
        offset: {
          type: 'number',
          description:
            'logs: byte offset to continue from. Omit for the first read; pass the `nextOffset` of the ' +
            'previous answer to get only what is new.',
        },
        lines: {
          type: 'number',
          description:
            'logs: return the last N lines instead of reading from `offset`. status: how many trailing ' +
            'log lines to include.',
        },
        limit: {
          type: 'number',
          description: 'list: how many jobs to return, newest first.',
        },
        local: {
          type: 'array',
          items: { type: 'string' },
          description:
            'upload: local paths, relative to the session directory when not absolute. ' +
            '`*`, `?` and `**` patterns are expanded here.',
        },
        target: {
          type: 'string',
          description:
            'download: the local directory to extract into. Defaults to the session directory.',
        },
        remote: {
          type: 'string',
          description: 'upload: the destination directory on the server. It is created when missing.',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description:
            'download: paths on the server, absolute or `~/…`; a trailing pattern is expanded by the ' +
            'server itself.',
        },
        allowDangerous: {
          type: 'boolean',
          description: 'Permit a command the guard would otherwise refuse. Only for a genuinely intended write.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },

    async execute(args, exec) {
      // Every field is volatile, so this is the user's latest edit even when the
      // row was saved after this plugin mounted.
      const config = resolveConfig(settings)
      const action = args.action
      const signal = exec?.signal
      const cwd = sessionDirectory(exec)

      /** Resolve the target of a job-scoped action. */
      const jobServer = (jobId) => selectServer(
        config,
        args.server,
        serverNameFromJobId(config, jobId),
      )

      if (action === 'run') {
        const command = typeof args.command === 'string' ? args.command : ''
        if (command.trim() === '') throw new Error('dsh-ssh-compute: `run` needs a `command`')
        assertCommandAllowed(config, command, args.allowDangerous === true)
        const server = selectServer(config, args.server)
        const keyFile = keyStore.fileFor(server)
        const started = await startJob({
          config,
          server,
          keyFile,
          command,
          cwd: args.cwd,
          signal,
        })
        return {
          text: [
            `started ${started.jobId} on ${server.name} (pid ${started.pid || 'unknown'})`,
            `directory: ${config.remoteRoot}/${started.jobId}`,
            `connect: ${started.durationMs} ms`,
            '',
            `poll it with action="status" jobId="${started.jobId}", read output with action="logs"`,
          ].join('\n'),
        }
      }

      if (action === 'status') {
        if (typeof args.jobId !== 'string' || args.jobId === '') {
          throw new Error('dsh-ssh-compute: `status` needs `jobId`')
        }
        const server = jobServer(args.jobId)
        const keyFile = keyStore.fileFor(server)
        const status = await jobStatus({
          config,
          server,
          keyFile,
          jobId: args.jobId,
          signal,
          tailLines: args.lines ?? config.logTailLines,
        })
        const lines = [
          `job: ${status.jobId} on ${server.name}`,
          `state: ${status.state}${status.killed ? ' (killed)' : ''}`,
          status.exitCode === undefined ? 'exit: not yet recorded' : `exit: ${status.exitCode}`,
          `pid: ${status.pid || 'unknown'}`,
          status.started > 0 ? `started: ${new Date(status.started * 1000).toISOString()}` : 'started: unknown',
          `log: ${status.logSize} bytes`,
        ]
        if (status.label !== '') lines.push(`command: ${status.label.split('\n')[0].slice(0, 400)}`)
        if (status.logTail.trim() !== '') {
          lines.push('', `--- last ${Math.min(args.lines ?? config.logTailLines, 400)} lines ---`, status.logTail.trimEnd())
        }
        return { text: lines.join('\n') }
      }

      if (action === 'logs') {
        if (typeof args.jobId !== 'string' || args.jobId === '') {
          throw new Error('dsh-ssh-compute: `logs` needs `jobId`')
        }
        const server = jobServer(args.jobId)
        const keyFile = keyStore.fileFor(server)
        const log = await readLog({
          config,
          server,
          keyFile,
          jobId: args.jobId,
          signal,
          offset: args.offset,
          lines: args.lines,
        })
        // The cursor is printed even at the end of the log: an answer without one
        // forces the next read to start over and repeat everything.
        const footer = log.nextOffset >= log.size
          ? `[end of log · ${log.size} bytes · nextOffset ${log.nextOffset}]`
          : `[nextOffset ${log.nextOffset} of ${log.size} bytes${log.truncated ? ', more is waiting' : ''}]`
        return {
          text: log.text.trimEnd() === '' ? footer : `${log.text.trimEnd()}\n\n${footer}`,
        }
      }

      if (action === 'kill') {
        if (typeof args.jobId !== 'string' || args.jobId === '') {
          throw new Error('dsh-ssh-compute: `kill` needs `jobId`')
        }
        const server = jobServer(args.jobId)
        const keyFile = keyStore.fileFor(server)
        const outcome = await killJob({ config, server, keyFile, jobId: args.jobId, signal })
        return {
          text: outcome.killedProcess
            ? `stopped ${outcome.jobId} on ${server.name} (exit ${outcome.exitCode ?? 'unknown'})`
            : `${outcome.jobId} on ${server.name} was not running any more (exit ${outcome.exitCode ?? 'unknown'})`,
        }
      }

      if (action === 'list') {
        const serverName = typeof args.server === 'string' ? args.server.trim() : ''
        if (serverName === '') {
          if (config.servers.length === 0) {
            return { text: 'no servers configured — add one in Settings → Plugins → SSH compute' }
          }
          const rows = config.servers.map((server) => {
            const key = keyStore.describe(server)
            const more = key.count > 1 ? ` (+${key.count - 1} more)` : ''
            const keyLabel = key.source === 'default'
              ? 'ssh default (no key found in ~/.ssh)'
              : key.source === 'inline'
                ? 'key from settings'
                : `${key.source === 'detected' ? 'auto-detected' : 'configured'}: ${key.path}${more}`
            return `${server.name}\t${server.user}@${server.host}:${server.port}\t${keyLabel}`
          })
          return {
            text: [
              `servers (${config.servers.length}), jobs live in ${config.remoteRoot}/<jobId> on each:`,
              ...rows,
            ].join('\n'),
          }
        }
        const server = selectServer(config, serverName)
        const keyFile = keyStore.fileFor(server)
        const jobs = await listJobs({ config, server, keyFile, signal, limit: args.limit })
        if (jobs.length === 0) return { text: `no jobs on ${server.name} yet` }
        const rows = jobs.map((job) => {
          const when = job.started > 0 ? new Date(job.started * 1000).toISOString() : 'unknown'
          const exit = job.exitCode === undefined ? '' : `\texit ${job.exitCode}`
          return `${job.jobId}\t${when}\t${job.state}${exit}`
        })
        return { text: [`jobs on ${server.name} (newest first):`, ...rows].join('\n') }
      }

      if (action === 'upload') {
        const server = selectServer(config, args.server)
        const remoteTarget = typeof args.remote === 'string' ? args.remote.trim() : ''
        if (remoteTarget === '') throw new Error('dsh-ssh-compute: `upload` needs `remote`, the target directory')
        assertUploadAllowed(config, remoteTarget, args.allowDangerous === true)
        const keyFile = keyStore.fileFor(server)
        const moved = await upload({
          config,
          server,
          keyFile,
          local: args.local,
          remote: remoteTarget,
          cwd,
        })
        const notes = [`uploaded ${moved.count} path(s) to ${server.name}:${remoteTarget} via ${moved.transport}`]
        if (moved.missing.length > 0) notes.push(`no match for: ${moved.missing.join(', ')}`)
        return { text: notes.join('\n') }
      }

      if (action === 'download') {
        const server = selectServer(config, args.server)
        const keyFile = keyStore.fileFor(server)
        // A bare `target` is relative to the conversation, not to wherever the
        // DSH host process happens to have been launched.
        const requested = typeof args.target === 'string' ? args.target.trim() : ''
        const target = requested === '' ? cwd : resolve(cwd, requested)
        const moved = await download({
          config,
          server,
          keyFile,
          remote: args.sources,
          local: target,
          cwd,
        })
        return { text: `downloaded ${moved.count} argument(s) from ${server.name} into ${moved.target} via ${moved.transport}` }
      }

      throw new Error(
        `dsh-ssh-compute: unknown action ${JSON.stringify(action)}; ` +
        'use run, status, logs, kill, list, upload or download',
      )
    },
  }
}

/**
 * Mount the plugin: the tool, the two routes the detail page calls, and the
 * key store's lifetime.
 * @param ctx - the plugin context.
 * @param settings - the config row.
 */
export function apply(ctx, settings = {}) {
  const keyStore = createKeyStore()
  ctx.effect(() => () => keyStore.dispose(), 'dsh-ssh-compute: key files')

  const disposeTool = ctx.tools.register(createTool({ settings, keyStore }))
  ctx.effect(() => disposeTool, 'dsh-ssh-compute: tool')

  // A server list is only a warning at mount: the settings form saves the whole
  // array, so a card that is still half-filled must not take the plugin down.
  const initial = resolveConfig(settings)
  for (const problem of initial.problems) console.warn(`dsh-ssh-compute: ${problem}`)

  ctx.inject(['webServer'], (inner) => {
    const webServer = inner.webServer
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return

    const publish = (path, handler, label) => {
      const dispose = webServer.register({ kind: 'exact', path, handler })
      if (typeof inner.effect === 'function') inner.effect(() => dispose, label)
    }

    publish(SERVERS_ROUTE, (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      const config = resolveConfig(settings)
      answerJson(response, 200, {
        remoteRoot: config.remoteRoot,
        problems: config.problems,
        servers: config.servers.map((server) => {
          const key = keyStore.describe(server)
          return {
            name: server.name,
            host: server.host,
            port: server.port,
            user: server.user,
            keySource: key.source,
            keyPath: key.path ?? null,
          }
        }),
      })
    }, 'dsh-ssh-compute: servers route')

    publish(TEST_ROUTE, async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      try {
        const config = resolveConfig(settings)
        const body = await readJsonBody(request)
        const server = selectServer(config, typeof body?.name === 'string' ? body.name : undefined)
        const keyFile = keyStore.fileFor(server)
        const probe = await probeServer({ config, server, keyFile })
        answerJson(response, 200, {
          ok: true,
          server: server.name,
          durationMs: probe.durationMs,
          facts: Object.fromEntries(probe.facts),
        })
      } catch (error) {
        answerJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }, 'dsh-ssh-compute: connection test route')

    // Read-only: the settings form asks what this machine's ssh already knows,
    // offers the list, and writes only the entries the user ticks.
    publish(SSH_CONFIG_ROUTE, (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      try {
        const found = readSshConfigFile()
        answerJson(response, 200, {
          path: found.path,
          exists: found.exists,
          entries: found.entries,
          problems: found.problems,
        })
      } catch (error) {
        answerJson(response, 200, {
          path: '',
          exists: false,
          entries: [],
          problems: [error instanceof Error ? error.message : String(error)],
        })
      }
    }, 'dsh-ssh-compute: ssh config route')
  })
}
