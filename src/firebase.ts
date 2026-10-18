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
    const stringData: Record<string, string> = {
      ...(data || {}),
      title: String(title),
      body: String(body),
    };
    await messaging.send({
      token,
      notification: { title, body },
      data: stringData,
      android: {
        priority: "high",
        notification: {
          title,
          body,
          channelId: "ya_voy_pedidos_channel",
          sound: "default",
          defaultSound: true,
          defaultVibrateTimings: true,
          priority: "high",
          visibility: "public",
          icon: "ic_launcher",
          color: "#9C0D38",
        },
      },
    });
  } catch (e: any) {
    console.error("FCM error:", e.message);
  }
}

export async function sendPushToUser(sql: any, userId: string, title: string, body: string, data?: Record<string, string>) {
  const rows = await sql`SELECT token FROM device_tokens WHERE user_id = ${userId}`;
  for (const row of rows) await sendPush(row.token, title, body, data);
}