import z from '@deepseek-ai/schemastery'
import {
  AutoContinueController,
  MAX_CONTINUATIONS,
  MAX_PAUSED_SESSIONS,
} from './index.js'

export const inject = ['sessions', 'agents']

export const Config = z.object({
  enabled: z.boolean().default(true),
  maxContinuations: z.natural().min(1).max(MAX_CONTINUATIONS).default(1),
  pausedSessions: z.array(z.string().min(1).max(256)).max(MAX_PAUSED_SESSIONS).default([]),
}).volatile()

export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AutoContinueController(ctx, { readConfig: () => config })
    const stopUpdates = ctx.on('loader/volatile-update', () => controller.configurationChanged())
    ctx.inject(['webServer', 'connection'], routeCtx => {
      routeCtx.effect(() => routeCtx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-intranet-auto-continue/activity',
        handler(req, res) {
          const rejection = routeCtx.connection.requestRejection(req)
          if (rejection !== undefined) {
            res.writeHead(rejection).end()
          } else if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' }).end()
          } else {
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            }).end(JSON.stringify({
              records: controller.activity(),
              maxContinuations: MAX_CONTINUATIONS,
              maxPausedSessions: MAX_PAUSED_SESSIONS,
            }))
          }
        },
      }))
    })
    return () => {
      stopUpdates()
      controller.dispose()
    }
  })
}
