# dsh-ssh-compute

A DeepSeek Harness (DSH) plugin that hands the agent one remote machine over
SSH, and nothing else.

A job is a directory on the server. The plugin starts it, leaves it running, and
reports what is there when asked. It never decides what "compute-heavy" means,
never installs software, and never trusts its own memory over the machine's
files: the agent probes the machine (`nproc`, `free`, `nvidia-smi`) and decides
for itself, exactly as it would on a local shell.

```
you: build the toolchain on the big box and run the benchmark suite there
agent: [ssh-compute run]  started box-20261115-031846-d197 on box (pid 21147)
       [ssh-compute status] state: running
       [ssh-compute logs]   ... 99% Built target benchmark
       [ssh-compute status] state: exited   exit: 0
```

## Install

In the DSH GUI: **Plugins → Add plugin**, and enter a git spec.

```
github:arcxya09/dsh-ssh-compute
```

or the equivalent, if you prefer an explicit URL:

```
git+https://github.com/arcxya09/dsh-ssh-compute.git
```

The same spec works from the agent side:

```
plugin_manager action=install_bundle target="github:arcxya09/dsh-ssh-compute"
```

Then open **Plugins → SSH compute**, add a server, and press **Test** on its row.
The tool is called `ssh-compute` and is registered process-wide by this bundle's
`cordis.patch.yml`, so no agent preset needs to mention it.

Nothing is built or installed to use it: the package is plain ESM, has no runtime
dependencies, and needs `ssh` on `PATH`.

> **Network:** a git install fetches from github.com, so it needs a route there.
> Behind a proxy, set `HTTPS_PROXY` for the DSH process or add
> `https-proxy=…` to the profile's `.npmrc`; otherwise clone the repository and
> install from the checkout path instead — that is exactly what a local
> development install does.

## The tool

One tool, `ssh-compute`, with an `action` that selects the verb:

| action | what it does |
| --- | --- |
| `run` | starts a command in the background on a server and returns a job id immediately |
| `wait` | blocks until the job ends or the timeout, then returns the exit code and the log tail |
| `status` | state, pid, start time, exit code, duration, peak memory and the last log lines of one job |
| `logs` | the job's output, either from a byte `offset` (incremental) or as the last N lines |
| `kill` | terminates the job's process group |
| `list` | the configured servers, or the jobs on one server |
| `upload` | copies local files or directories to the server |
| `download` | copies files from the server back |

`run` never waits for the command. A training run or a long build would otherwise
hold one tool call open for hours, and a cancelled call would lose the result.

**Prefer `wait` over polling.** It holds one SSH connection on the remote side
until the job writes its exit marker, so a five-minute job costs one round trip
instead of a hundred:

```
[ssh-compute run]  started gpu01-20261115-054127-1fe1 on gpu01 (pid 292654)
[ssh-compute wait] state: exited   exit: 0   waited: 96.4 s   … last 40 lines
```

The timeout is a ceiling, not a kill: when it elapses you get `state: still
running` and the tail so far, and the job keeps going. Use `status`/`logs` for a
cheap glance, and pass the `nextOffset` a `logs` answer returns to read only what
is new.

## Configure

Everything is on the plugin's own page: **Plugins → SSH compute**.

Each server has:

- `name`, the short name the tool's `server` argument uses, e.g. `box`. It becomes
  a directory name and part of every job id, so it may only use letters, digits,
  `.`, `-` and `_`; a name with a space or a shell character is refused rather than
  silently mangled.
- `host`, `port`, `user`
- `keyPath`, a private key file. Leave it empty and the plugin tries the keys it
  finds in `~/.ssh` (`id_ed25519`, `id_ecdsa`, `id_rsa`, …) in order of
  preference; if there are none it passes no `-i` at all, so `~/.ssh/config` and
  ssh-agent decide.
- `keyText`, paste key material instead. It is written to a `0600` file in the
  system temp directory and removed when the plugin unloads.
- `extraArgs`, space-separated ssh arguments passed straight through, e.g.
  `-J bastion` for a jump host or `-o UseKeychain=no`. They travel as argv, never
  through a shell, so a value that needs its own spaces cannot be expressed here
  (rsync transfers split the same string on spaces again).

Three settings bound what a job can do to the server:

- `maxFileSizeMb` (default 10240, `0` disables), applied by the job wrapper as
  `ulimit -f`, so a run-away output dies on SIGXFSZ (exit 153) instead of filling
  the disk. Core dumps are disabled unconditionally (`ulimit -c 0`).
- `minFreeSpaceMb` (default 1024): `run` refuses to start when the volume holding
  the jobs is below it, naming the numbers.
- `waitTimeoutMs` (default 300000): the default ceiling for `wait`.
- `maxRunningJobs` (default 64, `0` disables): `run` refuses to start a job when
  that many are already running under the same root, and names the count and the
  limit. Counting happens inside the launcher, so the check costs no extra round
  trip.

Connection reuse and job metadata:

- `reuseConnection` (default on) multiplexes calls over one ssh master; see below.
- `reuseIdleSeconds` (default 300): how long an idle master lingers.
- `recordResources` (default on): write `env.txt` and sample peak memory.

With exactly one server, `server` may be omitted. With several it is required,
except that `status`, `logs` and `kill` read it from the job id.

### Import from `~/.ssh/config`

**Import from ~/.ssh/config** reads this machine's ssh config and lists every
concrete `Host` alias with the address, port, user and identity file that ssh
itself would resolve. Tick the ones you want and press **Import selected**: they
are appended to the form, and nothing is written until you press **Save**.

Resolution follows ssh's own rules rather than appearance: the first value met
while walking the file wins, so a `Host *` block above a host supplies that
host's value too. Only plain aliases are offered; `Host *` and `Host *.corp`
patterns are skipped. `ProxyJump` is imported as `-J <host>` in the entry's extra
arguments. An entry whose block uses `ProxyCommand`, `LocalCommand` or
`RemoteCommand` is listed but not importable: a `ProxyCommand` is a shell command
line, and importing it would connect somewhere other than the user's own ssh
does. `Include` and `Match` are reported, not followed.

## Status panel

The plugin adds **Server status** to the left rail. It samples every configured
server and shows, one row each: reachability, 1/5/15-minute load against the core
count, memory used against total, free space where jobs live, how many jobs are
running, uptime, and a twenty-minute trend of the 1-minute load.

- One poll is one SSH connection per server, all servers in parallel, and nothing
  is installed on them. A server that cannot be reached is reported in its row
  rather than blanking the panel.
- Polling every 30 s stops while the document is hidden, so a background tab does
  not open connections all day. The trend lives in the browser and is never
  written anywhere.
- `running jobs` uses the same rule as the concurrency gate, so the panel and the
  gate never disagree about what "running" means.

## Connection reuse

Every call opens its own ssh connection, which costs a full handshake. With
`reuseConnection` on, the first call creates an `ssh` master under the system
temp directory and later calls ride it. Measured against one Ubuntu 24.04 host:
**969 ms per call without, 199 ms with** (4.9×), because only the handshake
disappears — the remote command still runs.

This is off on Windows and cannot be turned on there: Windows OpenSSH accepts the
`ControlMaster` options and prints them in `ssh -G`, but setting a `ControlPath`
makes it fail with `getsockname failed: Not a socket` and drop the connection it
was opening (measured on `OpenSSH_for_Windows_9.5p2`). The plugin therefore never
emits those options on `win32`, rather than trusting what ssh says about itself.

## On the server

Every job lives in `<remoteRoot>/<jobId>/` (default `~/dsh-compute`):

```
cmd.sh      the wrapper that ran; its #DSHCMD comment holds the original command
started     epoch seconds, written before the process starts
pid         the process-group leader
output.log  combined stdout and stderr
exit        the exit code, written when the command finishes
ended       epoch seconds when it finished
duration    seconds it ran, measured on the server
rss         peak memory of the whole job tree, in KiB (Linux only)
env.txt     hostname, user, cwd, kernel, start time and the python/gcc versions found
killed      present when this plugin stopped the job
```

`env.txt` exists so a result can be attributed to a compiler and an OS later; turn
it off with `recordResources` if the extra probes bother you.

Nothing is cleaned up automatically. Delete old directories when you no longer
want them:

```bash
ssh box 'rm -rf ~/dsh-compute/box-20261115-031846-d197'
```

## Transfers

`upload` and `download` use `rsync` when both this machine and the server have
it, and otherwise stream a `tar` archive through the same SSH connection. The
fallback is the common case on Windows, where rsync is usually absent; it needs
only `ssh` and a `tar` (`tar.exe` ships with Windows).

Local patterns (`*`, `?`, `**`) are expanded by the plugin, because ssh is
spawned without a local shell. Remote patterns are expanded by the server.
Downloaded members are named relative to their own directory, so
`download sources=["~/work/run.out"]` produces `run.out`, not the whole path.

## Guard

Two refusals are on by default, and both are escapable with
`allowDangerous: true`, so the guard is a speed bump on accidents rather than a
permission system:

- `run` refuses commands that would destroy the machine — `rm -rf /`, `mkfs`,
  `dd` onto a block device, a fork bomb, `shutdown`/`reboot`
- `upload` refuses to write into `/etc`, `/boot`, `/usr`, `/bin`, `/sbin`,
  `/lib*`, `/dev`, `/proc`, `/sys`, `/var/lib`. `.` and `..` are resolved first,
  so `/tmp/../etc/passwd` is refused like `/etc/passwd`.

Turn it off with the `guard` setting.

## Limitations

- **Key authentication only.** There is no password path: ssh runs with
  `BatchMode=yes` so it can never stop on a password prompt. Use a key, or
  `~/.ssh/config` with an agent.
- **No `ProxyCommand`.** `ProxyJump` and any other plain ssh option work through
  `extraArgs`, but a `ProxyCommand` is a shell command line and this plugin has
  no field for it; the import lists such an entry and refuses it instead of
  connecting somewhere else.
- **Host keys are recorded, not verified.** ssh runs with
  `StrictHostKeyChecking=accept-new`: an unknown host key is written to
  `known_hosts` once, and a *changed* one is still refused.
- **No local job state.** Everything lives on the server, so a restarted DSH, a
  second machine, or a colleague with the same key sees the same jobs.
- **Jobs outlive DSH.** That is the point, but it also means nothing stops a job
  when you close the app; `kill` is the way to stop one.

## Where the time goes

Measured against one Ubuntu 24.04 host, medians of repeated calls. The numbers
that matter are the ones that were fixed, but the profile is here so nobody has
to guess where a slow call comes from.

| step | cost |
| --- | --- |
| one ssh round trip, direct | 870–940 ms |
| the same, with `reuseConnection` | 119 ms |
| the remote launcher (staging one job) | 45 ms, was 67 |
| `recordResources` on the critical path | ~0 ms, was 43 |
| `status`, remote shell work | 9 ms, was 23 |
| `wait`, overshoot past the job's own end | ~0.1 s, was up to 1 s |
| `list` walking 1000 job directories | 23 ms |
| the settings form rendering 50 servers | 0.7 ms |
| local work per call (config, guard, wrapper text) | 1–3 µs |

What that says: on Windows, where connections cannot be reused, the round trip
*is* the cost and the remote shell work is noise. On Linux or macOS with reuse on,
the remote shell work is a tenth of a call, which is why the launcher was worth
rewriting — one `printf` instead of a `cat` per field, the environment probes moved
off the critical path, and the memory sampler started before them so a short job is
still sampled.

## Compatibility

Requires DSH `>=0.2.2-rc.1`. `engines.dsh` refuses older hosts; the floor is the
oldest release whose surfaces this plugin was checked against, and every newer
release is admitted.

| Surface | rc.1 | rc.3 and later |
| --- | --- | --- |
| the `ssh-compute` tool, all eight actions | yes | yes |
| settings form (`plugins.row.config` + `configForms`) | yes | yes |
| server list on the plugin page (`plugins.detail.section`) | yes | yes |
| status panel in the left rail | only where `sidebar.panellist` exists | yes |

Checked on `0.2.2-rc.5` end to end: the tool registers, its Config entry projects
with every field volatile, the rail panel registers, and the peer dependency
resolves against schemastery `3.19.0` (the declared range is `^3.18.1`).

Checked for `0.2.2-rc.1` by reading that release's published packages:
`plugins.row.config`, `plugins.bundle.config` and `plugins.detail.section` are all
present in its plugin manager, `configForms` is present, and its settings client
already handles volatile fields. The upgrade guides shipped with rc.5 record no
break between rc.1 and rc.5 on any surface used here — the only plugin-related
item is `BundleInfo.updatable` becoming `update`, which concerns
`pluginManager.listBundles()` and is not called by this plugin.

The status panel is registered through `ctx.slots.inject`, so on a host that does
not declare `sidebar.panellist` the panel never appears and nothing else is
affected: the pair is registered from inside the injection callback, and the
slots contract makes registering into an undeclared slot fail at activation.

## Releasing

`.github/workflows/release.yml` publishes on a tag:

```bash
# bump the version, then tag it with a matching name
git commit -am "1.3.0"
git tag v1.3.0
git push --follow-tags
```

The workflow refuses a tag that does not match `package.json`, syntax-checks
every source file, verifies the manifest still names the bundle patch, and
publishes with `--provenance` through npm **trusted publishing** (OIDC): no
token and no one-time password. A prerelease version such as `1.3.0-rc.1` goes to
the `next` dist-tag instead of `latest`.

That needs one registration, once, on npmjs.com: **package settings → Trusted
publishing** → owner `arcxya09`, repository `dsh-ssh-compute`, workflow filename
`release.yml`, environment empty. Before that registration exists the workflow
fails at the last step, and the fix is the registration rather than a token.

Publishing by hand from a checkout also works, for an account whose token may
still write: `npm publish --access public`.

## License

MIT. See [LICENSE](LICENSE).
