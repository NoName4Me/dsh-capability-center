import { CapabilityError } from './manifest.js'

export function planCapabilities(catalog, rootId) {
  const byId = new Map(catalog.items.map(item => [item.id, item]))
  const root = byId.get(rootId)
  if (root === undefined) throw new CapabilityError('unknown-item', `目录中不存在条目：${rootId}`)
  const visiting = []
  const visited = new Set()
  const order = []

  function visit(item) {
    if (visited.has(item.id)) return
    const cycleAt = visiting.indexOf(item.id)
    if (cycleAt >= 0) {
      throw new CapabilityError(
        'dependency-cycle',
        `能力依赖存在循环：${[...visiting.slice(cycleAt), item.id].join(' → ')}`,
      )
    }
    visiting.push(item.id)
    for (const dependency of item.dependencies ?? []) {
      const current = byId.get(dependency.id)
      const child = current?.version===dependency.version?current:(catalog.versions?.find(v=>v.id===dependency.id&&v.version===dependency.version)??current)
      if (child === undefined) {
        throw new CapabilityError(
          'missing-dependency',
          `${item.name} 依赖的 ${dependency.id}@${dependency.version} 不在目录中。`,
        )
      }
      if (child.version !== dependency.version) {
        throw new CapabilityError(
          'dependency-version-mismatch',
          `${item.name} 固定依赖 ${dependency.id}@${dependency.version}，目录提供 ${child.version}。`,
        )
      }
      if (item.type === 'composite'
        && (child.type === 'composite' || (child.dependencies ?? []).length > 0)) {
        throw new CapabilityError(
          'unsupported-nested-composite',
          `${item.name} 使用了嵌套组合或带传递依赖的子能力；首个正式版只支持平面组合。`,
        )
      }
      visit(child)
    }
    visiting.pop()
    visited.add(item.id)
    order.push(item)
  }

  visit(root)
  const owners = Object.fromEntries(order.map(item => [item.id, []]))
  for (const item of order) {
    for (const dependency of item.dependencies ?? []) owners[dependency.id].push(item.id)
  }
  return {
    root,
    order,
    owners,
    explicitDependencies: new Map(order.map(item => [
      item.id,
      (item.dependencies ?? []).map(dependency => dependency.id),
    ])),
  }
}

export function validateGraph(catalog) {
  for (const item of catalog.items) {
    planCapabilities(catalog, item.id)
  }
  return true
}
