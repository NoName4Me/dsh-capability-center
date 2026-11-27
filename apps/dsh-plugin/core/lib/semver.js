export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(value ?? ''))
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifier(left, right) {
  const a = /^\d+$/u.test(left)
  const b = /^\d+$/u.test(right)
  if (a && b) return Math.sign(Number(left) - Number(right))
  if (a) return -1
  if (b) return 1
  return left.localeCompare(right)
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue)
  const right = parseVersion(rightValue)
  if (left === null || right === null) throw new Error('无效语义版本')
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key])
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    if (left.prerelease[index] === undefined) return -1
    if (right.prerelease[index] === undefined) return 1
    const result = compareIdentifier(left.prerelease[index], right.prerelease[index])
    if (result !== 0) return Math.sign(result)
  }
  return 0
}

function compareToken(version, token) {
  const match = /^(>=|<=|>|<|=)?(.*)$/u.exec(token.trim())
  if (match === null || parseVersion(match[2]) === null) return false
  const compared = compareVersions(version, match[2])
  return {
    '': compared === 0,
    '=': compared === 0,
    '>': compared > 0,
    '>=': compared >= 0,
    '<': compared < 0,
    '<=': compared <= 0,
  }[match[1] ?? '']
}

export function satisfies(version, range) {
  if (parseVersion(version) === null || typeof range !== 'string') return false
  return range.split('||').some(branch => {
    const value = branch.trim()
    if (value === '*' || value === '') return true
    if (value.startsWith('^')) {
      const base = parseVersion(value.slice(1))
      if (base === null || compareVersions(version, value.slice(1)) < 0) return false
      const ceiling = base.major > 0
        ? `${base.major + 1}.0.0`
        : base.minor > 0 ? `0.${base.minor + 1}.0` : `0.0.${base.patch + 1}`
      return compareVersions(version, ceiling) < 0
    }
    if (value.startsWith('~')) {
      const base = parseVersion(value.slice(1))
      if (base === null || compareVersions(version, value.slice(1)) < 0) return false
      return compareVersions(version, `${base.major}.${base.minor + 1}.0`) < 0
    }
    return value.split(/\s+/u).every(token => compareToken(version, token))
  })
}
