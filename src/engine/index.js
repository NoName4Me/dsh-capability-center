import { CoreService } from './service.js'

export const inject = ['skills', 'tools', 'pluginManager']

export async function apply(ctx, config) {
  const service = new CoreService(ctx, {
    ...config.runtime,
    archive: undefined,
    coreCheck: config.runtime.coreCheck,
    coreStatus: config.runtime.coreStatus,
  })
  await service.initialize()
  config.runtime.setEngine(service)
  ctx.effect(() => () => service.dispose(), `capability-center-core: ${service.version}`)
}
