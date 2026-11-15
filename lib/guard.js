// Two refusals, both about the same thing: an unattended agent should not be
// able to erase a host or overwrite its system directories by typing a short
// command. Everything is escapable with `allowDangerous: true`, so the guard
// is a speed bump on accidents, not a permission system.

/** Operands that name a whole filesystem root or the login home. */
const ROOT_OPERANDS = new Set(['/', '//', '/*', '//*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*'])

/** Device trees where a write is indistinguishable from destroying the machine. */
const DEVICE_PREFIXES = ['/dev/disk', '/dev/sd', '/dev/nvme', '/dev/hd', '/dev/vd', '/dev/mmcblk', '/dev/mapper']

/** Remote directories `upload` will not write into. */
const PROTECTED_TARGETS = [
  '/etc', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64',
  '/dev', '/proc', '/sys', '/var/lib',
]

/** Split a command line into simple commands at the operators a shell honours. */
function segments(command) {
  return String(command).split(/&&|\|\||[;\n|]/).map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Tokenize one simple command, keeping quoted runs together.
 *
 * This is not a shell parser: it only needs to see `rm`, its flags and its
 * operands correctly for the shapes below.
 * @param segment - one simple command.
 * @returns its words.
 */
function words(segment) {
  const result = []
  let current = ''
  let quote = ''
  for (const character of segment) {
    if (quote !== '') {
      if (character === quote) quote = ''
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current !== '') {
        result.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') result.push(current)
  return result
}

/**
 * Resolve `.` and `..` so a detour cannot hide the real destination.
 *
 * `upload remote="/tmp/../etc/passwd"` reaches /etc just as directly as the
 * literal path, so the check has to see the same directory the shell will.
 * @param path - the destination as the caller wrote it.
 * @returns an absolute-looking, dot-free path.
 */
function normalizeTarget(path) {
  const parts = []
  for (const segment of String(path ?? '').replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** Whether a path lands inside a protected system directory. */
function isProtectedTarget(path) {
  const text = String(path ?? '').trim()
  if (text === '') return false
  const normalized = normalizeTarget(text)
  return PROTECTED_TARGETS.some(
    (target) => normalized === target || normalized.startsWith(`${target}/`),
  )
}

/** Whether a device-looking operand names a whole disk. */
function isDeviceOperand(operand) {
  return DEVICE_PREFIXES.some((prefix) => operand.startsWith(prefix))
}

/**
 * Refuse a command that would obviously destroy the remote machine.
 * @param config - the resolved configuration.
 * @param command - the caller's command text.
 * @param allowDangerous - the caller's explicit override.
 * @returns nothing; throws when refused.
 */
export function assertCommandAllowed(config, command, allowDangerous) {
  if (config.guard !== true || allowDangerous === true) return
  const text = String(command)

  const forkBomb = /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}/
  if (forkBomb.test(text)) {
    refuse('a fork bomb')
  }

  for (const segment of segments(text)) {
    const tokens = words(segment)
    if (tokens.length === 0) continue
    const program = tokens[0].replace(/^.*\//, '')

    if (program === 'rm') {
      const flags = tokens.slice(1).filter((token) => token.startsWith('-'))
      const recursive = flags.some((flag) => /[rR]/.test(flag)) || flags.includes('--recursive')
      const operands = tokens.slice(1).filter((token) => !token.startsWith('-'))
      if (!recursive) continue
      const root = operands.find((operand) => ROOT_OPERANDS.has(operand))
      if (root !== undefined) refuse(`recursive removal of ${root}`)
      if (flags.includes('--no-preserve-root')) refuse('rm --no-preserve-root')
      continue
    }

    if (program === 'mkfs' || program.startsWith('mkfs.') || program === 'wipefs' || program === 'mkswap') {
      refuse(`filesystem creation or erasure (${program})`)
    }

    if (program === 'shred') {
      if (tokens.slice(1).some((token) => isDeviceOperand(token))) refuse('shredding a block device')
      continue
    }

    if (program === 'dd') {
      const target = tokens.slice(1).find((token) => token.startsWith('of='))
      if (target !== undefined && isDeviceOperand(target.slice(3))) {
        refuse(`writing over a block device (dd ${target})`)
      }
      continue
    }

    if (program === 'shutdown' || program === 'poweroff' || program === 'reboot' || program === 'halt') {
      refuse(`${program} would take the server down`)
    }
  }
}

/**
 * Refuse an upload into a system directory.
 * @param config - the resolved configuration.
 * @param remoteTarget - the destination directory or file on the server.
 * @param allowDangerous - the caller's explicit override.
 * @returns nothing; throws when refused.
 */
export function assertUploadAllowed(config, remoteTarget, allowDangerous) {
  if (config.guard !== true || allowDangerous === true) return
  if (isProtectedTarget(remoteTarget)) {
    refuse(`writing into a system directory (${remoteTarget})`)
  }
}

/** One message shape, so the escape hatch is always named the same way. */
function refuse(what) {
  throw new Error(
    `dsh-ssh-compute: refused — ${what}. The command guard blocked this; ` +
    'pass `allowDangerous: true` if this is really intended.',
  )
}
