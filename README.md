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
| `status` | state, pid, start time, exit code and the last log lines of one job |
| `logs` | the job's output, either from a byte `offset` (incremental) or as the last N lines |
| `kill` | terminates the job's process group |
| `list` | the configured servers, or the jobs on one server |
| `upload` | copies local files or directories to the server |
| `download` | copies files from the server back |

`run` never waits for the command. A training run or a long build would otherwise
hold one tool call open for hours, and a cancelled call would lose the result.
Poll `status` for the exit code and `logs` for progress; pass the `nextOffset` a
`logs` answer returns to read only what is new.

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
patterns are skipped. An entry whose block uses `ProxyCommand`, `ProxyJump`,
`LocalCommand` or `RemoteCommand` is listed but not importable, because this
plugin has no field for a proxy and importing it would connect somewhere other
than the user's own ssh does. `Include` and `Match` are reported, not followed.

## On the server

Every job lives in `<remoteRoot>/<jobId>/` (default `~/dsh-compute`):

```
cmd.sh      the wrapper that ran; its #DSHCMD comment holds the original command
started     epoch seconds, written before the process starts
pid         the process-group leader
output.log  combined stdout and stderr
exit        the exit code, written when the command finishes
killed      present when this plugin stopped the job
```

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
- **No proxy field.** A host that needs `ProxyCommand`/`ProxyJump` cannot be
  represented; the import lists it and refuses it instead of connecting somewhere
  else.
- **Host keys are recorded, not verified.** ssh runs with
  `StrictHostKeyChecking=accept-new`: an unknown host key is written to
  `known_hosts` once, and a *changed* one is still refused.
- **No local job state.** Everything lives on the server, so a restarted DSH, a
  second machine, or a colleague with the same key sees the same jobs.
- **Jobs outlive DSH.** That is the point, but it also means nothing stops a job
  when you close the app; `kill` is the way to stop one.

## Compatibility

Requires DSH `>=0.2.2-rc.3` (`engines.dsh` refuses older hosts, because the
settings form uses the `plugins.row.config` slot and the `configForms` client
service). Verified against 0.2.2-rc.3 on Windows 11 (Windows OpenSSH,
`tar.exe`) with Ubuntu 24.04 remotes.

## License

MIT. See [LICENSE](LICENSE).
