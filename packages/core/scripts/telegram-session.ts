/**
 * One-time interactive script to generate a Telegram MTProto session string.
 *
 * Prerequisites:
 *   1. Go to https://my.telegram.org → API development tools
 *   2. Create an application to get your API_ID and API_HASH
 *
 * Usage:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abcdef \
 *     pnpm tsx packages/core/scripts/telegram-session.ts
 *
 * The script will prompt for your phone number and the login code Telegram
 * sends you. Once authenticated it prints the session string — store it as
 * the TELEGRAM_SESSION_STRING GitHub secret.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as readline from "readline";

const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH ?? "";

if (!API_ID || !API_HASH) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

(async () => {
  const session = new StringSession("");
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3
  });

  await client.start({
    phoneNumber: () => ask("Phone number (international format): "),
    phoneCode: () => ask("Login code: "),
    password: () => ask("2FA password (if enabled): "),
    onError: (err) => console.error("Auth error:", err)
  });

  console.log("\n✅ Authenticated successfully!\n");
  console.log("Session string (store as TELEGRAM_SESSION_STRING secret):\n");
  console.log(client.session.save());

  await client.disconnect();
  rl.close();
})();
