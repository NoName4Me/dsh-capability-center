import { execFile } from 'node:child_process'
import {
  arch,
  cpus,
  freemem,
  hostname,
  networkInterfaces,
  platform,
  release,
  totalmem,
  type,
  version,
} from 'node:os'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export const inject = ['tools']

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function powershell(script) {
  const executable = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
  const utf8 = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
    + '$OutputEncoding = [Console]::OutputEncoding; '
  const { stdout } = await runFile(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    utf8 + script,
  ], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  })
  const text = stdout.trim()
  return text === '' ? null : JSON.parse(text)
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

async function windowsDetails(errors) {
  if (platform() !== 'win32') return { os: {}, disks: [] }
  let osDetails = {}
  let disks = []
  try {
    const value = await powershell(
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_OperatingSystem | "
      + "Select-Object Caption,Version,BuildNumber,OSArchitecture | ConvertTo-Json -Compress",
    )
    if (value && typeof value === 'object') {
      osDetails = {
        caption: value.Caption ?? null,
        version: value.Version ?? null,
        buildNumber: value.BuildNumber ?? null,
        osArchitecture: value.OSArchitecture ?? null,
      }
    }
  } catch (error) {
    errors.push({ source: 'windows-os', message: errorMessage(error) })
  }
  try {
    const value = await powershell(
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_LogicalDisk | "
      + "Where-Object { $_.DriveType -eq 3 } | "
      + "Select-Object DeviceID,VolumeName,Size,FreeSpace,FileSystem | ConvertTo-Json -Compress",
    )
    const rows = Array.isArray(value) ? value : value ? [value] : []
    disks = rows.map(row => ({
      device: row.DeviceID ?? null,
      label: row.VolumeName ?? null,
      fileSystem: row.FileSystem ?? null,
      totalBytes: numberOrNull(row.Size),
      freeBytes: numberOrNull(row.FreeSpace),
      usedBytes: numberOrNull(row.Size) === null || numberOrNull(row.FreeSpace) === null
        ? null
        : numberOrNull(row.Size) - numberOrNull(row.FreeSpace),
    }))
  } catch (error) {
    errors.push({ source: 'windows-disks', message: errorMessage(error) })
  }
  return { os: osDetails, disks }
}

function timeFacts() {
  const now = new Date()
  return {
    collectedAt: now.toISOString(),
    localTime: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  }
}

function networkFacts() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? []).map(address => ({
    name,
    address: address.address,
    family: address.family,
    mac: address.mac,
    netmask: address.netmask,
    cidr: address.cidr,
    internal: address.internal,
    scopeid: address.scopeid ?? null,
  })))
}

export async function collectLocalSystemInfo() {
  const errors = []
  const windows = await windowsDetails(errors)
  const total = totalmem()
  const free = freemem()
  const cpuRows = cpus()
  return {
    ...timeFacts(),
    os: {
      platform: platform(),
      type: type(),
      release: release(),
      version: version(),
      arch: arch(),
      hostname: hostname(),
      ...windows.os,
    },
    cpu: {
      model: cpuRows[0]?.model ?? null,
      cores: cpuRows.length,
      speedMHz: cpuRows[0]?.speed ?? null,
    },
    memory: { totalBytes: total, freeBytes: free, usedBytes: total - free },
    networkInterfaces: networkFacts(),
    disks: windows.disks,
    partial: errors.length > 0,
    errors,
    privacy: {
      uploaded: false,
      note: 'This result is not uploaded to the capability distribution server.',
    },
  }
}

const tool = {
  name: 'get_local_system_info',
  description: 'Return local time and timezone, every network interface IP/MAC, disk capacity and free space, memory, operating-system details, and optional CPU facts. Partial query failures are retained in errors. The tool performs no upload.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  },
  async execute() {
    return await collectLocalSystemInfo()
  },
  presentCall() {
    return { card: 'generic', title: 'Read local system information', kind: 'read' }
  },
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(tool), 'dsh-local-sysinfo: get_local_system_info')
}
