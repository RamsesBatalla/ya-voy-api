import admin from "firebase-admin"

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")
  admin.initializeApp({
    credential: admin.credential.cert(sa),
  })
}

export const messaging = admin.messaging()

export async function sendPush(token: string, title: string, body: string, data?: Record<string, string>) {
  try {
    await messaging.send({ token, notification: { title, body }, data, android: { priority: "high" } })
  } catch (e: any) {
    console.error("FCM error:", e.message)
  }
}

export async function sendPushToUser(sql: any, userId: string, title: string, body: string, data?: Record<string, string>) {
  const rows = await sql`SELECT token FROM device_tokens WHERE user_id = ${userId}`
  for (const row of rows) await sendPush(row.token, title, body, data)
}