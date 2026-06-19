import { getOrCreateUser } from "./reputation.js";

export function registerWelcome({ bot }) {
  bot.on("new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;

      getOrCreateUser(member.id, member.username);

      const name = member.first_name || member.username || "unknown";

      try {
        await ctx.reply(`New presence logged: ${name}\nWelcome to shillit. Make yourself known.`);
      } catch (err) {
        console.error("[welcome] failed to send welcome message:", err.message);
      }
    }
  });
}
