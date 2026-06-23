import { getOrCreateUser } from "./reputation.js";
import { getSetting } from "./db.js";

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

      // If a welcome video has been set (via /set_welcome_video), send it
      // with the welcome text as its caption — video on top, text below,
      // one message. This uses its own isolated setting key and never
      // touches the raid card media or anything else. If no video is set,
      // or sending it fails for any reason, fall back to the plain text
      // welcome exactly as before — so this can never break the greeting.
      const welcomeVideo = getSetting("welcome_video_file_id");

      if (welcomeVideo) {
        try {
          await ctx.replyWithVideo(welcomeVideo, { caption: message });
          continue;
        } catch (err) {
          console.warn(
            "[welcome] welcome video failed, falling back to text:",
            err.message
          );
        }
      }

      try {
        await ctx.reply(message);
      } catch (err) {
        console.error("[welcome] failed to send welcome message:", err.message);
      }
    }
  });
}
