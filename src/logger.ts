import * as Sentry from "@sentry/node"

export function logError(e: any, context?: string) {
  console.error(context ? `[${context}]` : "[error]", e?.message ?? e)
  if (process.env.SENTRY_DSN) Sentry.captureException(e)
}
