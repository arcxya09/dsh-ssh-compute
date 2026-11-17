// dsh-ssh-compute, browser half.
//
// A plain hand-written bundle, exactly like the ones DSH ships: no build step,
// no import/export keywords, no JSX. The page loads it as a script, the module
// loader hands it a `require`, and the only module it asks for is React.
//
// It contributes two things, and nothing else:
//   - `plugins.row.config` / `plugins.bundle.config`: the settings form for this
//     plugin's one row. DSH does not draw a form for a Config schema by itself —
//     a plugin supplies the form and gets `form.state` / `form.mutate` to read
//     and write the row.
//   - `plugins.detail.section`: the server list on this bundle's page, with one
//     test button per server. The ssh call happens on the Host, because a page
//     cannot start a process and should not hold a key.

window.__ModuleLoader__.load({
  id: 'dsh-ssh-compute',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** This plugin's package name; both the detail slot and the config slot are mounted for every plugin. */
    const PACKAGE = 'dsh-ssh-compute'
    /** The row id this bundle's `cordis.patch.yml` declares; `plugins.row.config` is keyed by it. */
    const ROW_ID = 'dsh-ssh-compute'
    const SERVERS_ROUTE = '/dsh-ssh-compute/servers'
    const TEST_ROUTE = '/dsh-ssh-compute/test'
    const SSH_CONFIG_ROUTE = '/dsh-ssh-compute/ssh-config'
    /** One poll of the status panel. */
    const MONITOR_ROUTE = '/dsh-ssh-compute/monitor'
    /** The rail entry and the main panel that shares this id. */
    const PANEL_ID = 'dsh-ssh-servers'
    /** How often the panel polls while it is the visible tab. */
    const POLL_MS = 30000
    /** Samples kept per server for the trend line (40 x 30 s = 20 minutes). */
    const HISTORY = 40
    const LOCALE_NAMESPACE = 'dshSshCompute'

    /** The scalar settings, in the order the form draws them. */
    const NUMBER_FIELDS = ['connectTimeoutMs', 'commandTimeoutMs', 'logTailLines', 'maxLogBytes', 'listLimit',
      'maxFileSizeMb', 'minFreeSpaceMb', 'waitTimeoutMs', 'maxRunningJobs', 'reuseIdleSeconds']
    /** Switches, drawn as checkboxes in the same grid. */
    const BOOLEAN_FIELDS = ['guard', 'reuseConnection', 'recordResources']
    const SERVER_FIELDS = [
      { key: 'name', label: 'fieldName', hint: 'hintName' },
      { key: 'host', label: 'fieldHost', hint: 'hintHost' },
      { key: 'user', label: 'fieldUser', hint: undefined },
      { key: 'port', label: 'fieldPort', hint: undefined, number: true },
      { key: 'keyPath', label: 'fieldKeyPath', hint: 'hintKeyPath' },
      { key: 'keyText', label: 'fieldKeyText', hint: 'hintKeyText', multiline: true },
      { key: 'extraArgs', label: 'fieldExtraArgs', hint: 'hintExtraArgs', wide: true },
    ]

    const en = {
      title: 'Servers',
      panelTitle: 'Server status',
      panelRefresh: 'Refresh',
      panelAuto: 'Auto',
      panelUpdated: 'sampled',
      panelLoading: 'Sampling every server…',
      panelFailed: 'Could not sample the servers',
      panelEmpty: 'No servers configured. Add one in the plugin settings.',
      panelOffline: 'unreachable',
      panelLoad: 'load',
      panelCores: 'cores',
      panelMemory: 'memory',
      panelDisk: 'disk free',
      panelJobs: 'jobs',
      panelUptime: 'up',
      panelTrend: 'load, last 20 minutes',
      panelHint: 'One SSH connection per server per poll; nothing is installed on them.',
      intro: 'Each row is one entry from this plugin\'s settings. Test opens one SSH connection and reports what the machine is.',
      remoteRoot: 'Jobs directory',
      noServers: 'No servers configured yet. Add one below, or in the plugin settings.',
      loading: 'Reading the configured servers…',
      loadFailed: 'Could not read the configured servers',
      test: 'Test',
      testing: 'Testing…',
      keyInline: 'key from settings',
      keyConfigured: 'key file',
      keyDetected: 'auto-detected key',
      keyDefault: 'ssh default (no key in ~/.ssh)',
      latency: 'round trip',
      hostname: 'host',
      kernel: 'kernel',
      cpu: 'cpu',
      memory: 'memory',
      load: 'load',
      gpu: 'gpu',
      cores: 'cores',
      megabytes: 'MB',
      unavailable: 'not reported',

      configLoading: 'Reading this plugin\'s configuration…',
      configUnavailable: 'This DSH does not expose this plugin\'s configuration to the page.',
      configReadOnly: 'The profile does not accept configuration writes.',
      sectionServers: 'Remote servers',
      sectionServersHint: 'The tool\'s `server` argument names one of these. With a single entry it may be omitted.',
      sectionDefaults: 'Defaults',
      sectionDefaultsHint: 'Leave a field empty to fall back to the built-in default.',
      addServer: 'Add a server',
      removeServer: 'Remove',
      importButton: 'Import from ~/.ssh/config',
      importTitle: 'Hosts in your ssh config',
      importHint: 'Read from',
      importLoading: 'Reading the ssh config…',
      importMissing: 'There is no ssh config on this machine.',
      importFailed: 'Could not read the ssh config',
      importEmpty: 'The ssh config has no concrete Host entry to import.',
      importConfirm: 'Import selected',
      importCancel: 'Close',
      importAlready: 'already configured',
      importUnsupported: 'not supported',
      importUnsupportedHint: 'Uses {detail}, which this plugin has no field for; add it by hand if you need it.',
      importBadName: 'The alias has characters this plugin cannot use in a name; rename it by hand.',
      importAdded: 'Added {count} server(s) to the form. Save to apply.',
      emptyServers: 'No server configured. The tool will refuse to run until you add one.',
      fieldName: 'Name',
      fieldHost: 'Address',
      fieldUser: 'User',
      fieldPort: 'Port',
      fieldKeyPath: 'Private key file',
      fieldKeyText: 'Private key contents',
      fieldExtraArgs: 'Extra ssh arguments',
      hintExtraArgs: 'Space-separated, passed straight to ssh, e.g. -J bastion. A value that needs its own spaces cannot be expressed here.',
      fieldMaxFileSizeMb: 'Max file size (MiB)',
      fieldMinFreeSpaceMb: 'Minimum free space (MiB)',
      fieldWaitTimeoutMs: 'Default wait timeout (ms)',
      fieldMaxRunningJobs: 'Jobs per server',
      fieldReuseConnection: 'Reuse ssh connections',
      fieldReuseIdleSeconds: 'Idle reuse (s)',
      fieldRecordResources: 'Record job environment',
      hintName: 'The short name the tool uses, e.g. gpu01.',
      hintHost: 'Hostname or IP address.',
      hintKeyPath: 'Empty: the first key in ~/.ssh, then ssh\'s own default.',
      hintKeyText: 'Paste key material to store it here instead of a file. Higher priority than the path.',
      fieldRemoteRoot: 'Jobs directory',
      fieldGuard: 'Command guard',
      hintGuard: 'Refuse obviously destructive remote commands and uploads into system directories.',
      fieldConnectTimeoutMs: 'Connect timeout (ms)',
      fieldCommandTimeoutMs: 'Command timeout (ms)',
      fieldLogTailLines: 'Log lines in status',
      fieldMaxLogBytes: 'Bytes per log read',
      fieldListLimit: 'Jobs per list',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      saved: 'Saved. The new settings apply to the next call.',
      saveFailed: 'The Host refused the change.',
      noChanges: 'No changes to save.',
      dirty: 'Unsaved changes',
      summaryServers: 'servers',
      summaryNone: 'no servers configured',
      summaryUnknown: 'configuration not loaded yet',
    }

    const zh = {
      title: '服务器',
      panelTitle: '服务器状态',
      panelRefresh: '刷新',
      panelAuto: '自动',
      panelUpdated: '采样于',
      panelLoading: '正在采样所有服务器…',
      panelFailed: '无法采样服务器',
      panelEmpty: '还没有配置服务器。去插件设置里添加。',
      panelOffline: '无法连接',
      panelLoad: '负载',
      panelCores: '核',
      panelMemory: '内存',
      panelDisk: '可用磁盘',
      panelJobs: '运行中任务',
      panelUptime: '已运行',
      panelTrend: '负载，最近 20 分钟',
      panelHint: '每次刷新每台服务器一条 SSH 连接；不在服务器上安装任何东西。',
      intro: '每一行是插件设置里的一台服务器。点「测试」会建立一次 SSH 连接，并报告这台机器是什么。',
      remoteRoot: '任务目录',
      noServers: '还没有配置服务器。在下面添加一台，或去插件设置里添加。',
      loading: '正在读取已配置的服务器…',
      loadFailed: '无法读取已配置的服务器',
      test: '测试',
      testing: '测试中…',
      keyInline: '设置里粘贴的私钥',
      keyConfigured: '私钥文件',
      keyDetected: '自动探测的私钥',
      keyDefault: 'ssh 默认（~/.ssh 里没找到私钥）',
      latency: '往返耗时',
      hostname: '主机名',
      kernel: '内核',
      cpu: 'CPU',
      memory: '内存',
      load: '负载',
      gpu: 'GPU',
      cores: '核',
      megabytes: 'MB',
      unavailable: '未报告',

      configLoading: '正在读取插件的配置…',
      configUnavailable: '这个 DSH 没有把插件配置暴露给页面。',
      configReadOnly: '当前 profile 不接受配置写入。',
      sectionServers: '远程服务器',
      sectionServersHint: '工具的 `server` 参数用这里的名字；只有一台时可省略。',
      sectionDefaults: '默认值',
      sectionDefaultsHint: '留空则使用内置默认值。',
      addServer: '添加服务器',
      removeServer: '删除',
      importButton: '从 ~/.ssh/config 导入',
      importTitle: 'ssh config 里的主机',
      importHint: '读取自',
      importLoading: '正在读取 ssh config…',
      importMissing: '这台机器上没有 ssh config 文件。',
      importFailed: '无法读取 ssh config',
      importEmpty: 'ssh config 里没有可导入的具体 Host。',
      importConfirm: '导入所选',
      importCancel: '关闭',
      importAlready: '已存在',
      importUnsupported: '不支持',
      importUnsupportedHint: '用了 {detail}，这个插件没有对应字段；确实需要就手动添加。',
      importBadName: '这个别名的字符不能用作服务器名，需要手动改名。',
      importAdded: '已把 {count} 台服务器加入表单，记得保存。',
      emptyServers: '还没有服务器。添加之前工具会拒绝执行。',
      fieldName: '名称',
      fieldHost: '地址',
      fieldUser: '用户名',
      fieldPort: '端口',
      fieldKeyPath: '私钥文件路径',
      fieldKeyText: '私钥内容',
      fieldExtraArgs: '额外 ssh 参数',
      hintExtraArgs: '空格分隔，原样交给 ssh，例如 -J bastion。本身需要空格的参数无法在这里表达。',
      fieldMaxFileSizeMb: '单文件上限（MiB）',
      fieldMinFreeSpaceMb: '最小可用空间（MiB）',
      fieldWaitTimeoutMs: 'wait 默认超时（毫秒）',
      fieldMaxRunningJobs: '每台服务器并发上限',
      fieldReuseConnection: '复用 ssh 连接',
      fieldReuseIdleSeconds: '复用空闲（秒）',
      fieldRecordResources: '记录任务环境',
      hintName: '工具里引用它的短名字，例如 gpu01。',
      hintHost: '主机名或 IP。',
      hintKeyPath: '留空：先用 ~/.ssh 里的第一个私钥，再交给 ssh 自己的默认行为。',
      hintKeyText: '把私钥内容粘贴到这里代替文件；优先级高于路径。',
      fieldRemoteRoot: '任务目录',
      fieldGuard: '命令护栏',
      hintGuard: '拦截明显破坏性的远端命令，以及往系统目录的上传。',
      fieldConnectTimeoutMs: '连接超时（毫秒）',
      fieldCommandTimeoutMs: '命令超时（毫秒）',
      fieldLogTailLines: 'status 附带日志行数',
      fieldMaxLogBytes: '单次日志字节上限',
      fieldListLimit: 'list 返回任务数',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存，下一次调用即生效。',
      saveFailed: 'Host 拒绝了这次修改。',
      noChanges: '没有需要保存的修改。',
      dirty: '有未保存的修改',
      summaryServers: '台服务器',
      summaryNone: '尚未配置服务器',
      summaryUnknown: '配置尚未加载',
    }

    const CSS = [
      '.dsh-ssh-compute-section { display: flex; flex-direction: column; gap: 12px; }',
      '.dsh-ssh-compute-head { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-ssh-compute-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-compute-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-compute-root { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-compute-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; overflow: hidden; }',
      '.dsh-ssh-compute-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }',
      '.dsh-ssh-compute-row + .dsh-ssh-compute-row { border-top: 1px solid var(--dsw-alias-border-l1); }',
      '.dsh-ssh-compute-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }',
      '.dsh-ssh-compute-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-compute-target { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }',
      '.dsh-ssh-compute-key { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }',
      '.dsh-ssh-compute-button { flex: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }',
      '.dsh-ssh-compute-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }',
      '.dsh-ssh-compute-button:disabled { opacity: 0.55; cursor: default; }',
      '.dsh-ssh-compute-result { margin: 0; padding: 8px 12px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); overflow-wrap: anywhere; }',
      '.dsh-ssh-compute-ok { color: var(--dsw-alias-state-success-primary); }',
      '.dsh-ssh-compute-error { color: var(--dsw-alias-state-error-primary); }',

      '.dsh-ssh-form { display: flex; flex-direction: column; gap: 20px; }',
      '.dsh-ssh-group { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-ssh-group + .dsh-ssh-group { margin-top: 4px; }',
      '.dsh-ssh-group-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-group-hint { margin: 0 0 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-server { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.dsh-ssh-server + .dsh-ssh-server { margin-top: 10px; }',
      '.dsh-ssh-server-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
      '.dsh-ssh-server-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }',
      '.dsh-ssh-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }',
      '.dsh-ssh-field-wide { grid-column: 1 / -1; }',
      '.dsh-ssh-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 8px; font-size: 12px; font-family: inherit; }',
      '.dsh-ssh-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
      '.dsh-ssh-input:disabled { opacity: 0.6; }',
      '.dsh-ssh-textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.dsh-ssh-field-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-actions { display: flex; align-items: center; gap: 10px; padding-top: 4px; }',
      '.dsh-ssh-primary { border: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-radius: 6px; padding: 5px 14px; font-size: 12px; cursor: pointer; }',
      '.dsh-ssh-primary:disabled { opacity: 0.5; cursor: default; }',
      '.dsh-ssh-note { font-size: 12px; line-height: 1.5; }',
      '.dsh-ssh-dirty { margin-left: auto; font-size: 12px; color: var(--dsw-alias-state-warn-primary); }',
      '.dsh-ssh-link { border: none; background: none; padding: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-state-error-primary); cursor: pointer; }',
      '.dsh-ssh-monitor { display: flex; flex-direction: column; gap: 14px; padding: 20px; max-width: 1080px; margin: 0 auto; }',
      '.dsh-ssh-monitor-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }',
      '.dsh-ssh-monitor-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-monitor-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }',
      '.dsh-ssh-monitor-stamp { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-monitor-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }',
      '.dsh-ssh-monitor-row { display: grid; grid-template-columns: minmax(200px, 1.1fr) minmax(300px, 2fr) 140px; gap: 16px; align-items: center; padding: 12px 14px; }',
      '.dsh-ssh-monitor-row + .dsh-ssh-monitor-row { border-top: 1px solid var(--dsw-alias-border-l1); }',
      '.dsh-ssh-monitor-main { display: flex; align-items: center; gap: 8px; min-width: 0; }',
      '.dsh-ssh-monitor-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; background: var(--dsw-alias-state-success-primary); }',
      '.dsh-ssh-monitor-dot[data-state="busy"] { background: var(--dsw-alias-state-warn-primary); }',
      '.dsh-ssh-monitor-dot[data-state="down"] { background: var(--dsw-alias-state-error-primary); }',
      '.dsh-ssh-monitor-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-monitor-target { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }',
      '.dsh-ssh-monitor-metrics { display: flex; flex-wrap: wrap; gap: 4px 16px; }',
      '.dsh-ssh-monitor-metric { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-monitor-metric b { font-weight: 600; color: var(--dsw-alias-label-primary); }',
      '.dsh-ssh-monitor-error { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }',
      '.dsh-ssh-spark { display: block; color: var(--dsw-alias-brand-primary); }',
      '.dsh-ssh-spark-empty { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
      '.dsh-ssh-monitor-foot { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }',
      '@media (max-width: 820px) { .dsh-ssh-monitor-row { grid-template-columns: 1fr; gap: 8px; } }',
      '.dsh-ssh-import { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.dsh-ssh-import-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }',
      '.dsh-ssh-import-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 4px; border-radius: 6px; cursor: pointer; }',
      '.dsh-ssh-import-row:hover { background: var(--dsw-alias-bg-layer-1); }',
      '.dsh-ssh-import-blocked { opacity: 0.6; cursor: default; }',
      '.dsh-ssh-import-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
      '.dsh-ssh-import-alias { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }',
      '.dsh-ssh-import-tag { font-size: 10px; font-weight: 400; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }',
    ].join('')

    /**
     * A slot's translator, or a fallback that keeps the entry renderable.
     *
     * The `locale` registration supplies `t`; if a build ever hands the entry
     * props without it, a thrown error would blank the slot instead of showing
     * untranslated labels, so the fallback reads the English dictionary.
     */
    function translator(translate) {
      if (typeof translate === 'function') return translate
      // The fallback also has to interpolate, because a few strings carry a
      // `{name}` placeholder the host translator would fill.
      return (key, params) => {
        const text = typeof en[key] === 'string' ? en[key] : key
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
      }
    }

    /**
     * Append the picked ssh-config entries to the draft's server list.
     *
     * Pure, so the merge rule is testable without a renderer: an entry is added
     * only when it is ticked, has a name, and does not collide with a name already
     * in the draft (case-insensitively — ssh aliases are case-sensitive, but two
     * cards that differ only in case would be ambiguous in the tool).
     * @param draftServers - the form's current server cards.
     * @param entries - what the Host reported from `~/.ssh/config`.
     * @param picked - alias -> whether the box is ticked.
     * @returns the new list and how many were added.
     */
    function mergeImportedServers(draftServers, entries, picked) {
      const servers = Array.isArray(draftServers) ? draftServers : []
      const taken = new Set(servers.map((server) => String(server.name ?? '').trim().toLowerCase()).filter((name) => name !== ''))
      const added = []
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (picked[entry.alias] !== true) continue
        // Defense in depth: the form disables an unusable row, and the merge
        // refuses it too so a caller cannot import what the Host would drop.
        if (entry.nameOk === false) continue
        if (Array.isArray(entry.unsupported) && entry.unsupported.length > 0) continue
        const name = String(entry.name ?? entry.alias ?? '').trim()
        if (name === '' || taken.has(name.toLowerCase())) continue
        taken.add(name.toLowerCase())
        added.push({
          name,
          host: String(entry.host ?? ''),
          user: String(entry.user ?? ''),
          port: Number(entry.port ?? 22),
          keyPath: String(entry.keyPath ?? ''),
          keyText: '',
          extraArgs: String(entry.extraArgs ?? ''),
        })
      }
      return { servers: [...servers, ...added], added }
    }

    /** Fetch JSON from one of this plugin's own routes. */
    async function readJson(route, init) {
      const response = await fetch(route, {
        ...init,
        headers: { accept: 'application/json', ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** One label per key source, so a wrong key is visible before the first call. */
    function keyLabel(server, t) {
      if (server.keySource === 'inline') return t('keyInline')
      if (server.keySource === 'default') return t('keyDefault')
      const prefix = server.keySource === 'detected' ? t('keyDetected') : t('keyConfigured')
      return server.keyPath === null || server.keyPath === '' ? prefix : `${prefix}: ${server.keyPath}`
    }

    /** The facts a probe reported, in reading order. */
    function factList(facts, t) {
      const rows = []
      const push = (label, value) => {
        if (value !== undefined && value !== null && String(value).trim() !== '' && String(value) !== '?') {
          rows.push(`${label} ${value}`)
        }
      }
      push(t('hostname'), facts.hostname)
      push(t('kernel'), facts.kernel)
      push(t('cpu'), facts.cpu === undefined ? undefined : `${facts.cpu} ${t('cores')}`)
      push(t('memory'), facts.mem_mb === undefined ? undefined : `${facts.mem_mb} ${t('megabytes')}`)
      push(t('load'), facts.load)
      push(t('gpu'), facts.gpu === 'none' ? undefined : facts.gpu)
      return rows
    }

    // ------------------------------------------------------------- status panel

    /** A megabyte count as a short human string; zero means "not reported". */
    function formatMb(mb) {
      if (!Number.isFinite(mb) || mb <= 0) return '—'
      return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GiB` : `${Math.round(mb)} MiB`
    }

    /** Seconds of uptime as `3d 4h` / `4h 12m` / `12m`. */
    function formatUptime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      return `${minutes}m`
    }

    /** A local wall-clock time, or nothing when the browser refuses to format. */
    function formatClock(ms) {
      try {
        return new Date(ms).toLocaleTimeString()
      } catch {
        return ''
      }
    }

    /**
     * The trend line. It lives in the browser and is never written anywhere: the
     * panel is a glance at the last twenty minutes, not a time-series store.
     */
    function Sparkline(props) {
      const values = props.values
      const empty = props.empty
      if (!Array.isArray(values) || values.length < 2) {
        return h('span', { className: 'dsh-ssh-spark-empty' }, empty)
      }
      const width = 132
      const height = 30
      const max = Math.max(...values, 1)
      const step = width / (values.length - 1)
      const points = values
        .map((value, index) => `${(index * step).toFixed(1)},${(height - 3 - (value / max) * (height - 6)).toFixed(1)}`)
        .join(' ')
      return h('svg', {
        className: 'dsh-ssh-spark',
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': props.label,
      }, h('polyline', {
        points,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinejoin: 'round',
        strokeLinecap: 'round',
      }))
    }

    /**
     * Append one poll to a server's trend.
     *
     * A failed sample keeps the line it had: an unreachable host is not zero
     * load, and drawing it as zero would read as "the machine went idle".
     * @param series - server name -> load samples.
     * @param server - one entry from the monitor route.
     * @returns the series map with this sample folded in.
     */
    function appendSample(series, server) {
      const previous = series[server.name] ?? []
      const load = Array.isArray(server.load) ? server.load[0] : undefined
      const next = server.ok === true && Number.isFinite(load) ? [...previous, load].slice(-HISTORY) : previous
      return { ...series, [server.name]: next }
    }

    /** The rail entry: an 18x18 rack glyph in `currentColor`, so the sidebar's own state colours show through. */
    function ServerIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('rect', { x: '3.5', y: '3.5', width: '13', height: '5', rx: '1.2' }),
      h('rect', { x: '3.5', y: '11.5', width: '13', height: '5', rx: '1.2' }),
      h('path', { d: 'M6 6h.01M6 14h.01' }))
    }

    /**
     * The main panel. One row per configured server: reachability, load, memory,
     * free space, live jobs, uptime, and a twenty-minute trend of the 1-minute
     * load. Polling stops while the document is hidden, so a background tab does
     * not open SSH connections all day.
     */
    function MonitorPanel(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading', at: 0, servers: [], series: {}, problems: [], error: '' })
      const [auto, setAuto] = useState(true)
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const payload = await readJson(MONITOR_ROUTE)
          setState((current) => {
            let series = current.series
            for (const server of Array.isArray(payload?.servers) ? payload.servers : []) {
              series = appendSample(series, server)
            }
            return {
              status: 'ready',
              at: Number(payload?.at) || Date.now(),
              servers: Array.isArray(payload?.servers) ? payload.servers : [],
              series,
              problems: Array.isArray(payload?.problems) ? payload.problems : [],
              error: '',
            }
          })
        } catch (error) {
          setState((current) => ({ ...current, status: 'failed', error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        let live = true
        const tick = () => {
          if (!live) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void refresh()
        }
        tick()
        if (!auto) return () => { live = false }
        const timer = setInterval(tick, POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [auto, refresh])

      const rows = state.servers.map((server) => {
        const series = state.series[server.name] ?? []
        const load = Array.isArray(server.load) ? server.load : []
        const busyScore = server.cpus > 0 && load[0] > server.cpus
        const dotState = server.ok !== true ? 'down' : (busyScore ? 'busy' : 'ok')
        return h('div', { className: 'dsh-ssh-monitor-row', key: server.name },
          h('div', { className: 'dsh-ssh-monitor-main' },
            h('span', { className: 'dsh-ssh-monitor-dot', 'data-state': dotState }),
            h('span', { className: 'dsh-ssh-monitor-name' }, server.name),
            h('span', { className: 'dsh-ssh-monitor-target' }, `${server.user}@${server.host}:${server.port}`)),
          server.ok === true
            ? h('div', { className: 'dsh-ssh-monitor-metrics' },
              h('span', { className: 'dsh-ssh-monitor-metric' }, `${t('panelLoad')} `,
                h('b', null, load.length > 0 ? load.map((value) => value.toFixed(2)).join(' / ') : '—'),
                server.cpus > 0 ? ` · ${server.cpus} ${t('panelCores')}` : ''),
              h('span', { className: 'dsh-ssh-monitor-metric' }, `${t('panelMemory')} `,
                h('b', null, server.memTotalMb > 0
                  ? `${formatMb(server.memTotalMb - server.memAvailableMb)} / ${formatMb(server.memTotalMb)}`
                  : '—')),
              h('span', { className: 'dsh-ssh-monitor-metric' }, `${t('panelDisk')} `,
                h('b', null, formatMb(server.diskFreeMb))),
              h('span', { className: 'dsh-ssh-monitor-metric' }, `${t('panelJobs')} `,
                h('b', null, String(server.runningJobs ?? 0))),
              h('span', { className: 'dsh-ssh-monitor-metric' }, `${t('panelUptime')} `,
                h('b', null, formatUptime(server.uptimeSec))))
            : h('div', { className: 'dsh-ssh-monitor-error' },
              `${t('panelOffline')}: ${server.error ?? ''}`),
          h(Sparkline, { values: series, empty: t('panelTrend'), label: t('panelTrend') }))
      })

      return h('div', { className: 'dsh-ssh-monitor' },
        h('div', { className: 'dsh-ssh-monitor-head' },
          h('h2', { className: 'dsh-ssh-monitor-title' }, t('panelTitle')),
          state.at === 0
            ? null
            : h('span', { className: 'dsh-ssh-monitor-stamp' }, `${t('panelUpdated')} ${formatClock(state.at)}`),
          h('div', { className: 'dsh-ssh-monitor-actions' },
            h('label', { className: 'dsh-ssh-check' },
              h('input', {
                type: 'checkbox',
                checked: auto,
                onChange: (event) => setAuto(event.target.checked),
              }),
              h('span', null, t('panelAuto'))),
            h('button', {
              type: 'button',
              className: 'dsh-ssh-compute-button',
              disabled: busy,
              onClick: () => { void refresh() },
            }, t('panelRefresh')))),
        state.status === 'loading'
          ? h('p', { className: 'dsh-ssh-compute-hint' }, t('panelLoading'))
          : null,
        state.status === 'failed'
          ? h('p', { className: 'dsh-ssh-monitor-error' }, `${t('panelFailed')}: ${state.error}`)
          : null,
        state.status !== 'loading' && state.servers.length === 0
          ? h('p', { className: 'dsh-ssh-compute-hint' }, t('panelEmpty'))
          : null,
        state.servers.length > 0
          ? h('div', { className: 'dsh-ssh-monitor-card' }, rows)
          : null,
        state.problems.length > 0
          ? h('p', { className: 'dsh-ssh-monitor-error' }, state.problems.join('; '))
          : null,
        h('p', { className: 'dsh-ssh-monitor-foot' }, t('panelHint')))
    }

    // ---------------------------------------------------------------- detail page

    /** No hooks: the guard returns null for every page that is not this bundle's. */
    function ComputeSection(props) {
      const subject = props.subject
      if (subject === undefined || subject === null) return null
      if (subject.kind === 'item') return null
      if (subject.pkg === undefined || subject.pkg === null) return null
      if (subject.pkg.name !== PACKAGE) return null
      return h(DetailServers, { t: translator(props.t), source: props.source })
    }

    /**
     * The server list, re-mounted whenever the Host publishes a new accepted
     * configuration, so a server saved in the form above appears here without a
     * page reload.
     */
    function DetailServers(props) {
      const source = props.source
      const snapshot = useSnapshot(source)
      return h(ServerList, { t: props.t, key: snapshot?.revision ?? 0 })
    }

    function ServerList(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading', servers: [], remoteRoot: '', problems: [], error: '' })
      const [tests, setTests] = useState({})

      useEffect(() => {
        let live = true
        readJson(SERVERS_ROUTE)
          .then((value) => {
            if (!live) return
            setState({
              status: 'ready',
              servers: Array.isArray(value?.servers) ? value.servers : [],
              remoteRoot: typeof value?.remoteRoot === 'string' ? value.remoteRoot : '',
              problems: Array.isArray(value?.problems) ? value.problems : [],
              error: '',
            })
          })
          .catch((error) => {
            if (!live) return
            setState({ status: 'failed', servers: [], remoteRoot: '', problems: [], error: String(error?.message ?? error) })
          })
        return () => { live = false }
      }, [])

      const runTest = useCallback((name) => {
        setTests((current) => ({ ...current, [name]: { busy: true } }))
        readJson(TEST_ROUTE, { method: 'POST', body: JSON.stringify({ name }) })
          .then((value) => setTests((current) => ({ ...current, [name]: { busy: false, value } })))
          .catch((error) => setTests((current) => ({
            ...current,
            [name]: { busy: false, value: { ok: false, error: String(error?.message ?? error) } },
          })))
      }, [])

      const header = h('div', { className: 'dsh-ssh-compute-head' },
        h('h3', { className: 'dsh-ssh-compute-title' }, t('title')),
        state.remoteRoot === ''
          ? null
          : h('p', { className: 'dsh-ssh-compute-hint' },
            `${t('remoteRoot')}: `,
            h('span', { className: 'dsh-ssh-compute-root' }, `${state.remoteRoot}/<jobId>`)),
        h('p', { className: 'dsh-ssh-compute-hint' }, t('intro')),
      )

      // Entries the plugin could not use: a server card saved without a host, or a
      // name used twice. The tool skips them, so the page has to say which.
      const problems = (state.problems ?? []).map((problem) => h(
        'p',
        { key: problem, className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' },
        problem,
      ))

      if (state.status === 'loading') {
        return h('section', { className: 'dsh-ssh-compute-section', 'aria-label': t('title') },
          header, h('p', { className: 'dsh-ssh-compute-hint' }, t('loading')))
      }
      if (state.status === 'failed') {
        return h('section', { className: 'dsh-ssh-compute-section', 'aria-label': t('title') },
          header,
          h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, `${t('loadFailed')}: ${state.error}`))
      }
      if (state.servers.length === 0) {
        return h('section', { className: 'dsh-ssh-compute-section', 'aria-label': t('title') },
          header, problems, h('p', { className: 'dsh-ssh-compute-hint' }, t('noServers')))
      }

      const rows = state.servers.map((server) => {
        const test = tests[server.name]
        const result = test?.value
        const busy = test?.busy === true
        const facts = result?.ok === true && result.facts !== undefined && result.facts !== null
          ? factList(result.facts, t)
          : []
        return h('div', { key: server.name },
          h('div', { className: 'dsh-ssh-compute-row' },
            h('div', { className: 'dsh-ssh-compute-body' },
              h('span', { className: 'dsh-ssh-compute-name' }, server.name),
              h('span', { className: 'dsh-ssh-compute-target' }, `${server.user}@${server.host}:${server.port}`),
              h('span', { className: 'dsh-ssh-compute-key' }, keyLabel(server, t))),
            h('button', {
              type: 'button',
              className: 'dsh-ssh-compute-button',
              disabled: busy,
              onClick: () => runTest(server.name),
            }, busy ? t('testing') : t('test'))),
          result === undefined
            ? null
            : h('p', {
              className: result.ok ? 'dsh-ssh-compute-result dsh-ssh-compute-ok' : 'dsh-ssh-compute-result dsh-ssh-compute-error',
              role: 'status',
            }, result.ok
              ? [`${t('latency')} ${result.durationMs} ms`, ...facts].join(' · ')
              : result.error),
        )
      })

      return h('section', { className: 'dsh-ssh-compute-section', 'aria-label': t('title') },
        header, problems, h('div', { className: 'dsh-ssh-compute-card' }, rows))
    }

    // ------------------------------------------------------------- configuration
    //
    // Two slots can show this plugin's configuration and they hand different
    // things in. `plugins.row.config` receives the page's own `form`
    // (`{ state, mutate }`); `plugins.bundle.config` receives only `view`, with
    // no form at all. So the page reads the `configForms` service itself and
    // uses the page's form only when one is supplied — without that, the bundle
    // page would render nothing and the settings would be unreachable from
    // where the user actually lands.

    /** One form source: read the snapshot, optionally subscribe, write ops. */
    function sourceFromRecord(record) {
      return {
        read: () => record.getSnapshot(),
        subscribe: (listener) => record.subscribe(listener),
        mutate: (ops, revision) => record.mutate(ops, revision),
      }
    }

    /** A source over the page-supplied form, which has no subscription of its own. */
    function sourceFromProp(form) {
      return {
        read: () => form.state,
        subscribe: undefined,
        mutate: (ops, revision) => form.mutate(ops, revision),
      }
    }

    /** Follow one source's snapshot; a source without subscribe just reads once. */
    function useSnapshot(source) {
      const [snapshot, setSnapshot] = useState(() => (source === undefined ? undefined : source.read()))
      useEffect(() => {
        if (source === undefined) {
          setSnapshot(undefined)
          return undefined
        }
        setSnapshot(source.read())
        if (typeof source.subscribe !== 'function') return undefined
        return source.subscribe(() => setSnapshot(source.read()))
      }, [source])
      return snapshot
    }

    /** One text or number input bound to the draft. */
    function Field(props) {
      const { label, hint, value, onChange, disabled, multiline, number, wide } = props
      const className = wide ? 'dsh-ssh-field dsh-ssh-field-wide' : 'dsh-ssh-field'
      const common = {
        className: multiline ? 'dsh-ssh-input dsh-ssh-textarea' : 'dsh-ssh-input',
        value: value === undefined || value === null ? '' : String(value),
        disabled,
        onChange: (event) => onChange(event.target.value),
        spellCheck: false,
      }
      return h('label', { className },
        h('span', { className: 'dsh-ssh-label' }, label),
        multiline
          ? h('textarea', common)
          : h('input', { ...common, type: number ? 'number' : 'text', inputMode: number ? 'numeric' : undefined }),
        hint === undefined ? null : h('span', { className: 'dsh-ssh-field-hint' }, hint))
    }

    /** The draft a form starts from: the Host's resolved values, defaults filled in. */
    function toDraft(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const servers = Array.isArray(source.servers) ? source.servers : []
      return {
        servers: servers.map((entry) => {
          const server = entry !== null && typeof entry === 'object' ? entry : {}
          return {
            name: typeof server.name === 'string' ? server.name : '',
            host: typeof server.host === 'string' ? server.host : '',
            user: typeof server.user === 'string' ? server.user : '',
            port: server.port === undefined || server.port === null ? 22 : server.port,
            keyPath: typeof server.keyPath === 'string' ? server.keyPath : '',
            keyText: typeof server.keyText === 'string' ? server.keyText : '',
            extraArgs: typeof server.extraArgs === 'string' ? server.extraArgs : '',
          }
        }),
        remoteRoot: typeof source.remoteRoot === 'string' ? source.remoteRoot : '',
        guard: source.guard !== false,
        connectTimeoutMs: source.connectTimeoutMs ?? '',
        commandTimeoutMs: source.commandTimeoutMs ?? '',
        logTailLines: source.logTailLines ?? '',
        maxLogBytes: source.maxLogBytes ?? '',
        listLimit: source.listLimit ?? '',
        maxFileSizeMb: source.maxFileSizeMb ?? '',
        minFreeSpaceMb: source.minFreeSpaceMb ?? '',
        waitTimeoutMs: source.waitTimeoutMs ?? '',
        maxRunningJobs: source.maxRunningJobs ?? '',
        reuseIdleSeconds: source.reuseIdleSeconds ?? '',
        reuseConnection: source.reuseConnection !== false,
        recordResources: source.recordResources !== false,
      }
    }

    /** Whether the draft still matches what the Host holds. */
    function sameDraft(original, draft) {
      // Comparing the ops rather than the drafts keeps the two in step: if the
      // save button is enabled, the save has something to write, and vice versa.
      return toOps(original, draft).length === 0
    }

    /**
     * The exact shape that is written back for one server entry.
     *
     * The Host validates the array against the schema, so an empty port string or
     * an all-blank optional field must not travel: a single invalid element would
     * make the Host refuse the whole write.
     */
    function canonicalServers(entries) {
      if (!Array.isArray(entries)) return []
      return entries.map((raw) => {
        const server = raw !== null && typeof raw === 'object' ? raw : {}
        const port = Number(server.port ?? 22)
        const entry = {
          name: String(server.name ?? '').trim(),
          host: String(server.host ?? '').trim(),
          user: String(server.user ?? '').trim(),
          port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
        }
        const keyPath = String(server.keyPath ?? '').trim()
        if (keyPath !== '') entry.keyPath = keyPath
        const keyText = String(server.keyText ?? '')
        if (keyText.trim() !== '') entry.keyText = keyText
        const extraArgs = String(server.extraArgs ?? '').trim()
        if (extraArgs !== '') entry.extraArgs = extraArgs
        return entry
      })
    }

    /** Turn the draft into the Host's ordered field operations. */
    function toOps(original, draft) {
      const source = original !== null && typeof original === 'object' ? original : {}
      const baseline = toDraft(source)
      const ops = []
      const nextServers = canonicalServers(draft.servers)
      if (JSON.stringify(canonicalServers(baseline.servers)) !== JSON.stringify(nextServers)) {
        // One atomically replaced array: a half-edited server list never reaches
        // the Host, and removing the last entry clears the field instead.
        if (nextServers.length === 0) ops.push({ op: 'unset', path: ['servers'] })
        else ops.push({ op: 'set', path: ['servers'], value: nextServers })
      }
      const scalars = ['remoteRoot', ...BOOLEAN_FIELDS, ...NUMBER_FIELDS]
      for (const key of scalars) {
        const before = baseline[key]
        const after = draft[key]
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        if (after === '' || after === undefined || after === null) ops.push({ op: 'unset', path: [key] })
        else ops.push({ op: 'set', path: [key], value: after })
      }
      return ops
    }

    function ConfigPage(props) {
      const { source, t } = props
      const snapshot = useSnapshot(source)
      const value = snapshot?.value
      const revision = snapshot?.revision
      const [draft, setDraft] = useState(() => toDraft(value))
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(undefined)

      // Re-seed from the Host whenever it publishes a new accepted section, so a
      // saved write, a rejected one, or another window's change is visible.
      // Re-seed the fields, but leave the note alone: a successful save publishes a
      // new section, and clearing here would wipe the "saved" line a moment after
      // it appeared. An edit clears the note through the field handlers instead.
      useEffect(() => {
        setDraft(toDraft(value))
      }, [value, revision])

      const writable = snapshot?.writable === true
      const disabled = !writable || busy
      const dirty = !sameDraft(value, draft)

      const patch = (key, value) => {
        setNote(undefined)
        setDraft((current) => ({ ...current, [key]: value }))
      }
      const patchServer = (index, key, value) => (setNote(undefined), setDraft((current) => ({
        ...current,
        servers: current.servers.map((server, position) => (position === index ? { ...server, [key]: value } : server)),
      })))
      const addServer = () => (setNote(undefined), setDraft((current) => ({
        ...current,
        servers: [...current.servers, { name: '', host: '', user: 'root', port: 22, keyPath: '', keyText: '' }],
      })))
      const removeServer = (index) => (setNote(undefined), setDraft((current) => ({
        ...current,
        servers: current.servers.filter((_server, position) => position !== index),
      })))

      const save = async () => {
        if (source === undefined) return
        const ops = toOps(value, draft)
        if (ops.length === 0) {
          setNote({ ok: true, text: t('noChanges') })
          return
        }
        setBusy(true)
        setNote(undefined)
        try {
          const accepted = await source.mutate(ops, revision)
          setNote(accepted
            ? { ok: true, text: t('saved') }
            : { ok: false, text: t('saveFailed') })
        } catch (error) {
          setNote({ ok: false, text: `${t('saveFailed')} ${String(error?.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }

      // ------------------------------------------------------------- ssh config
      //
      // Import is deliberately two steps: the Host reads the file and offers what
      // it found, and only the entries the user ticks are appended to the DRAFT.
      // Nothing is written until the form is saved, so Import is undoable by
      // closing the page.
      const [importer, setImporter] = useState({
        open: false, status: 'idle', path: '', entries: [], problems: [], error: '',
      })
      const [picked, setPicked] = useState({})

      const openImport = useCallback(async () => {
        setImporter({ open: true, status: 'loading', path: '', entries: [], problems: [], error: '' })
        setPicked({})
        try {
          const found = await readJson(SSH_CONFIG_ROUTE)
          setImporter({
            open: true,
            status: found?.exists === true ? 'ready' : 'missing',
            path: typeof found?.path === 'string' ? found.path : '',
            entries: Array.isArray(found?.entries) ? found.entries : [],
            problems: Array.isArray(found?.problems) ? found.problems : [],
            error: '',
          })
        } catch (error) {
          setImporter({
            open: true, status: 'failed', path: '', entries: [], problems: [],
            error: String(error?.message ?? error),
          })
        }
      }, [])

      const closeImport = () => {
        setImporter((current) => ({ ...current, open: false }))
        setPicked({})
      }

      const importSelected = () => {
        const merged = mergeImportedServers(draft.servers, importer.entries, picked)
        if (merged.added.length > 0) {
          setDraft((current) => ({ ...current, servers: merged.servers }))
          setNote({ ok: true, text: t('importAdded', { count: merged.added.length }) })
        }
        closeImport()
      }

      if (snapshot === undefined) {
        // No record attached yet: the Host may never serve this namespace, or it
        // has not answered. Either way there is nothing to fill in, so say that
        // rather than showing a spinner that can never finish.
        return h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, t('configUnavailable'))
      }
      if (snapshot.status === 'loading' && value === undefined) {
        return h('p', { className: 'dsh-ssh-compute-hint' }, t('configLoading'))
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, t('configUnavailable'))
      }

      const serverCards = draft.servers.map((server, index) => {
        const title = server.name.trim() === '' ? `${t('fieldName')} ${index + 1}` : server.name.trim()
        const fields = SERVER_FIELDS.map((field) => h(Field, {
          key: field.key,
          label: t(field.label),
          hint: field.hint === undefined ? undefined : t(field.hint),
          value: server[field.key],
          number: field.number === true,
          multiline: field.multiline === true,
          wide: field.multiline === true || field.wide === true,
          disabled,
          onChange: (value) => patchServer(
            index,
            field.key,
            field.number === true ? (value === '' ? '' : Number(value)) : value,
          ),
        }))
        const head = h('div', { className: 'dsh-ssh-server-head' },
          h('span', { className: 'dsh-ssh-server-name' }, title),
          h('button', {
            type: 'button',
            className: 'dsh-ssh-link',
            disabled,
            onClick: () => removeServer(index),
          }, t('removeServer')))
        const grid = h('div', { className: 'dsh-ssh-grid' }, fields)
        return h('div', { className: 'dsh-ssh-server', key: index }, head, grid)
      })

      const importPanel = importer.open
        ? h('div', { className: 'dsh-ssh-import' },
          h('div', { className: 'dsh-ssh-server-head' },
            h('span', { className: 'dsh-ssh-server-name' }, t('importTitle')),
            h('button', { type: 'button', className: 'dsh-ssh-link', onClick: closeImport }, t('importCancel'))),
          h('p', { className: 'dsh-ssh-field-hint' },
            importer.path === '' ? t('importHint') : `${t('importHint')} ${importer.path}`),
          importer.status === 'loading'
            ? h('p', { className: 'dsh-ssh-compute-hint' }, t('importLoading'))
            : null,
          importer.status === 'missing'
            ? h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, t('importMissing'))
            : null,
          importer.status === 'failed'
            ? h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, `${t('importFailed')} ${importer.error}`)
            : null,
          importer.status === 'ready' && importer.entries.length === 0
            ? h('p', { className: 'dsh-ssh-compute-hint' }, t('importEmpty'))
            : null,
          importer.status === 'ready' && importer.entries.length > 0
            ? h('div', { className: 'dsh-ssh-import-list' }, importer.entries.map((entry) => {
              const name = String(entry.name ?? entry.alias ?? '').trim()
              const exists = name !== ''
                && draft.servers.some((server) => server.name.trim().toLowerCase() === name.toLowerCase())
              const unsupported = Array.isArray(entry.unsupported) ? entry.unsupported : []
              const badName = entry.nameOk === false
              const blocked = exists || badName || unsupported.length > 0
              return h('label', {
                key: entry.alias,
                className: blocked ? 'dsh-ssh-import-row dsh-ssh-import-blocked' : 'dsh-ssh-import-row',
              },
              h('input', {
                type: 'checkbox',
                checked: picked[entry.alias] === true,
                disabled: blocked,
                onChange: (event) => setPicked((current) => ({ ...current, [entry.alias]: event.target.checked })),
              }),
              h('span', { className: 'dsh-ssh-import-body' },
                h('span', { className: 'dsh-ssh-import-alias' },
                  entry.alias,
                  exists ? h('span', { className: 'dsh-ssh-import-tag' }, t('importAlready')) : null,
                  !exists && (badName || unsupported.length > 0)
                    ? h('span', { className: 'dsh-ssh-import-tag' }, t('importUnsupported'))
                    : null),
                h('span', { className: 'dsh-ssh-compute-target' }, `${entry.user}@${entry.host}:${entry.port}`),
                entry.keyPath ? h('span', { className: 'dsh-ssh-compute-key' }, entry.keyPath) : null,
                entry.extraArgs ? h('span', { className: 'dsh-ssh-compute-key' }, `ssh ${entry.extraArgs}`) : null,
                !exists && badName
                  ? h('span', { className: 'dsh-ssh-compute-key dsh-ssh-compute-error' }, t('importBadName'))
                  : null,
                !exists && !badName && unsupported.length > 0
                  ? h('span', { className: 'dsh-ssh-compute-key dsh-ssh-compute-error' },
                    t('importUnsupportedHint', { detail: unsupported.join(', ') }))
                  : null,
                Array.isArray(entry.notes) && entry.notes.length > 0
                  ? h('span', { className: 'dsh-ssh-compute-key' }, entry.notes.join('; '))
                  : null))
            }))
            : null,
          importer.problems.length > 0
            ? h('p', { className: 'dsh-ssh-compute-hint' }, importer.problems.join('; '))
            : null,
          importer.status === 'ready' && importer.entries.length > 0
            ? h('div', { className: 'dsh-ssh-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-ssh-primary',
                disabled,
                onClick: importSelected,
              }, t('importConfirm')),
              h('button', { type: 'button', className: 'dsh-ssh-compute-button', onClick: closeImport }, t('importCancel')))
            : null)
        : null

      const serversGroup = h('div', { className: 'dsh-ssh-group' },
        h('h4', { className: 'dsh-ssh-group-title' }, t('sectionServers')),
        h('p', { className: 'dsh-ssh-group-hint' }, t('sectionServersHint')),
        draft.servers.length === 0
          ? h('p', { className: 'dsh-ssh-compute-hint' }, t('emptyServers'))
          : h('div', null, serverCards),
        h('div', { className: 'dsh-ssh-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ssh-compute-button',
            disabled,
            onClick: addServer,
          }, t('addServer')),
          h('button', {
            type: 'button',
            className: 'dsh-ssh-compute-button',
            disabled: disabled || importer.status === 'loading',
            onClick: () => { void openImport() },
          }, t('importButton'))),
        importPanel)

      const defaultsGroup = h('div', { className: 'dsh-ssh-group' },
        h('h4', { className: 'dsh-ssh-group-title' }, t('sectionDefaults')),
        h('p', { className: 'dsh-ssh-group-hint' }, t('sectionDefaultsHint')),
        h('div', { className: 'dsh-ssh-grid' },
          h(Field, {
            label: t('fieldRemoteRoot'),
            value: draft.remoteRoot,
            disabled,
            onChange: (value) => patch('remoteRoot', value),
          }),
          BOOLEAN_FIELDS.map((key) => h('label', {
            key,
            className: 'dsh-ssh-check',
            style: { alignSelf: 'end', paddingBottom: '6px' },
          },
          h('input', {
            type: 'checkbox',
            checked: draft[key] !== false,
            disabled,
            onChange: (event) => patch(key, event.target.checked),
          }),
          h('span', null, t(`field${key.charAt(0).toUpperCase()}${key.slice(1)}`)))),
          NUMBER_FIELDS.map((key) => h(Field, {
            key,
            label: t(`field${key.charAt(0).toUpperCase()}${key.slice(1)}`),
            value: draft[key],
            number: true,
            disabled,
            onChange: (value) => patch(key, value === '' ? '' : Number(value)),
          }))),
        h('p', { className: 'dsh-ssh-compute-hint' }, t('hintGuard')))

      return h('div', { className: 'dsh-ssh-form' },
        !writable
          ? h('p', { className: 'dsh-ssh-compute-hint dsh-ssh-compute-error' }, t('configReadOnly'))
          : null,
        serversGroup,
        defaultsGroup,
        h('div', { className: 'dsh-ssh-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ssh-primary',
            disabled: disabled || !dirty,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dsh-ssh-compute-button',
            disabled: disabled || !dirty,
            onClick: () => { setDraft(toDraft(value)) },
          }, t('discard')),
          note === undefined ? null : h('span', {
            className: note.ok ? 'dsh-ssh-note dsh-ssh-compute-ok' : 'dsh-ssh-note dsh-ssh-compute-error',
            role: 'status',
          }, note.text),
          dirty && note === undefined ? h('span', { className: 'dsh-ssh-dirty' }, t('dirty')) : null))
    }

    /**
     * The configuration entry. `summary` is the row's one-liner; `page` is the
     * form, and only a page render carries `form`.
     */
    function ConfigEntry(props) {
      const t = translator(props.t)
      const pageForm = props.form
      const recordSource = props.source
      const pageSource = useMemo(() => (pageForm === undefined ? undefined : sourceFromProp(pageForm)), [pageForm])
      const source = pageSource ?? recordSource
      const snapshot = useSnapshot(source)

      if (props.view === 'summary') {
        const value = snapshot?.value
        if (value === undefined) return t('summaryUnknown')
        const count = Array.isArray(value.servers) ? value.servers.length : 0
        const root = typeof value.remoteRoot === 'string' && value.remoteRoot !== ''
          ? value.remoteRoot
          : '~/dsh-compute'
        return count === 0 ? t('summaryNone') : `${count} ${t('summaryServers')} · ${root}`
      }
      return h(ConfigPage, { source, t })
    }

    return {
      inject: ['slots', 'locale'],
      // Pure helpers exposed for the offline tests only; the module loader reads
      // `inject` and `apply` and ignores everything else.
      __test: { mergeImportedServers, canonicalServers, toDraft, toOps, sameDraft, formatMb, formatUptime, appendSample },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }), 'dsh-ssh-compute: locale')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshSshCompute = 'true'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-ssh-compute: styles')

        // The configuration source. The bundle page's slot supplies only `view`,
        // so the page asks `configForms` for this row's form itself; the row page
        // still passes its own `form`, which `ConfigEntry` prefers when present.
        // `configForms` attaches its record ASYNCHRONOUSLY, after this plugin's
        // apply and after the entry may already have rendered. A getter read during
        // render would stay stale in that window and leave the page saying the
        // configuration is unavailable, so the handle below is stable and notifies
        // its subscribers when the record arrives or goes away.
        const configState = { source: undefined, listeners: new Set() }
        const setSource = (next) => {
          configState.source = next
          for (const listener of [...configState.listeners]) {
            try {
              listener()
            } catch (error) {
              console.warn('dsh-ssh-compute: a configuration subscriber failed', error)
            }
          }
        }
        const configSource = {
          read: () => (configState.source === undefined ? undefined : configState.source.read()),
          subscribe: (listener) => {
            configState.listeners.add(listener)
            return () => { configState.listeners.delete(listener) }
          },
          mutate: (ops, revision) => (configState.source === undefined
            ? Promise.resolve(false)
            : configState.source.mutate(ops, revision)),
        }
        ctx.inject(['configForms'], (inner) => {
          const configForms = inner.configForms
          if (configForms === undefined || configForms === null || typeof configForms.get !== 'function') return
          // A row's namespace is its id; a composed entry may also appear with the
          // include prefix, so whichever the Host really serves is the one read.
          const namespaces = [ROW_ID, `include:${ROW_ID}`]
          const attach = (served) => {
            const namespace = namespaces.find((candidate) => served.has(candidate)) ?? ROW_ID
            setSource(sourceFromRecord(configForms.get(namespace)))
            return () => setSource(undefined)
          }
          if (typeof configForms.whileServed === 'function') {
            const dispose = configForms.whileServed(namespaces, attach)
            inner.effect(() => dispose, 'dsh-ssh-compute: configuration form')
            return
          }
          attach(new Set([ROW_ID]))
        })

        // The settings form. Keyed by `<package name>#<row id>`, which is how the
        // Plugins page addresses one row's configuration and offers its configure
        // control; the bundle page reads the same form under the package name.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: `${PACKAGE}#${ROW_ID}`,
          locale: LOCALE_NAMESPACE,
        }, (props) => h(ConfigEntry, { ...props, source: configSource })))

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: LOCALE_NAMESPACE,
        }, (props) => h(ConfigEntry, { ...props, source: configSource })))

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-ssh-compute.servers',
          order: 60,
          locale: LOCALE_NAMESPACE,
        }, (props) => h(ComputeSection, { ...props, source: configSource })))

        // The status panel. `sidebar.panellist` draws the rail button — its entry
        // IS the icon — and `main` holds the page that same id opens; the pair is
        // registered from the inner callback so it appears or vanishes as one.
        // `ctx.locale.bind` returns a translate function that reads the active
        // locale when called, which is what a label thunk needs to stay localized
        // without re-registering.
        const panelLabel = typeof ctx.locale?.bind === 'function'
          ? ctx.locale.bind(LOCALE_NAMESPACE)
          : translator(undefined)
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopPanel = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ t: panelLabel }),
          }, MonitorPanel)
          const stopIcon = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            label: () => panelLabel('panelTitle'),
          }, ServerIcon)
          return () => {
            if (typeof stopIcon === 'function') stopIcon()
            if (typeof stopPanel === 'function') stopPanel()
          }
        }))
      },
    }
  },
})
