import { getOrCreateUser } from "./reputation.js";

export function registerWelcome({ bot }) {
  bot.on("new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;

      getOrCreateUser(member.id, member.username);

      const name = member.first_name || member.username || "unknown";

      const message =
        `Welcome ${name} to SHILLit.fun Official Community\n\n` +
        `You're early to a growing ecosystem built on community, culture, and momentum.\n\n` +
        `🔹 Stay active\n` +
        `🔹 Respect everyone\n` +
        `🔹 No spam or FUD\n\n` +
        `Stay connected with us, let's grow!`;

      try {
        await ctx.reply(message);
      } catch (err) {
        console.error("[welcome] failed to send welcome message:", err.message);
      }
    }
  });
}
