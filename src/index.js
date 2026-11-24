"use strict";

const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const cfg = require("./config");
const { Game, esc } = require("./game");
const stats = require("./models");

if (!cfg.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN .env faylida yo'q!");
  process.exit(1);
}

mongoose
  .connect(cfg.MONGO_URI)
  .then(() => console.log("✅ MongoDB ga ulandi!"))
  .catch((e) => console.warn("⚠️ MongoDB ulanmadi (statistika ishlamaydi):", e.message));

const bot = new TelegramBot(cfg.BOT_TOKEN, { polling: true });
const games = new Map(); // chatId(string) -> Game

let meCache = null;
async function getMe() {
  if (!meCache) meCache = await bot.getMe();
  return meCache;
}
getMe().then((m) => console.log(`✅ Bot ishga tushdi: @${m.username}`));

// ---------- yordamchilar ----------
const reply = (msg, text, extra = {}) =>
  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML", disable_web_page_preview: true, ...extra }).catch(() => {});

const cmd = (name, handler) =>
  bot.onText(new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s+(.*))?$`, "i"), (msg, match) => {
    Promise.resolve(handler(msg, match)).catch((e) => console.error(`/${name} xatosi:`, e));
  });

const isGroup = (msg) => msg.chat.type === "group" || msg.chat.type === "supergroup";

async function isChatAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(m.status);
  } catch {
    return false;
  }
}

function findGameOfUser(userId) {
  for (const g of games.values()) if (g.getPlayer(userId)) return g;
  return null;
}

async function warnIfBotNotAdmin(chatId) {
  try {
    const me = await getMe();
    const m = await bot.getChatMember(chatId, me.id);
    if (m.status !== "administrator" || m.can_delete_messages === false) {
      await bot.sendMessage(
        chatId,
        "⚠️ Meni guruhda <b>admin</b> qiling va <b>«Xabarlarni o'chirish»</b> huquqini bering. " +
          "Aks holda o'lganlar va kechasi yozayotganlarning xabarlarini o'chira olmayman.",
        { parse_mode: "HTML" }
      );
    }
  } catch {}
}

const HELP = (
  "🎭 <b>MAFIA BOTI</b>\n\n" +
  "<b>Guruhda:</b>\n" +
  "/game — yangi o'yin ochish\n" +
  "/begin — ro'yxatni erta yopib boshlash (ochgan kishi yoki admin)\n" +
  "/leave — ro'yxatdan chiqish\n" +
  "/players — o'yinchilar ro'yxati\n" +
  "/stop — o'yinni to'xtatish (ochgan kishi yoki admin)\n\n" +
  "<b>Statistika:</b>\n" +
  "/mystats — mening natijam\n" +
  "/top — eng yaxshi 10 o'yinchi\n\n" +
  "/rules — o'yin qoidalari"
);

const RULES = (
  "📖 <b>QOIDALAR</b>\n\n" +
  `Kamida ${cfg.MIN_PLAYERS} ta o'yinchi kerak.\n\n` +
  "<b>Rollar:</b>\n" +
  "🔫 <b>Mafiya</b> — kechasi bir kishini o'ldiradi (har 3 o'yinchiga 1 ta)\n" +
  "💊 <b>Doktor</b> — kechasi bir kishini davolaydi\n" +
  "👮 <b>Sherif</b> — kechasi bir kishini tekshiradi\n" +
  "👨‍💼 <b>Fuqaro</b> — kunduzi ovoz beradi\n\n" +
  "<b>Tartib:</b>\n" +
  "🌙 Kecha — rollar botning shaxsiy chatida tugma bosadi. Guruhda yozish mumkin emas.\n" +
  "☀️ Kun — natijalar e'lon qilinadi, muhokama bo'ladi.\n" +
  "🗳 Ovoz berish — eng ko'p ovoz olgan o'yinchi chiqariladi (teng bo'lsa hech kim).\n\n" +
  "<b>G'alaba:</b>\n" +
  "🏙 Shahar — barcha mafiya yo'q qilinsa.\n" +
  "🔫 Mafiya — mafiya soni qolganlarga teng yoki ko'p bo'lsa.\n\n" +
  "💀 O'lgan o'yinchilar guruhda yoza olmaydi."
);

// ---------- /start ----------
cmd("start", async (msg, match) => {
  if (msg.chat.type !== "private") return reply(msg, HELP);

  const payload = (match[1] || "").trim();
  if (payload.startsWith("join_")) {
    const chatId = payload.slice(5);
    const game = games.get(chatId);
    if (!game || game.phase !== "registration") {
      return reply(msg, "❌ Bu guruhda ro'yxat ochiq o'yin topilmadi.");
    }
    const other = findGameOfUser(msg.from.id);
    if (other && other !== game) return reply(msg, "⚠️ Siz boshqa guruhdagi o'yinda ishtirok etyapsiz.");

    const r = game.addPlayer(msg.from);
    if (r === "ok") {
      return reply(msg, `✅ Siz <b>${esc(game.chatTitle || "guruh")}</b> dagi o'yinga qo'shildingiz!\nGuruhga qaytib, o'yin boshlanishini kuting.`);
    }
    if (r === "already") return reply(msg, "✅ Siz allaqachon ro'yxatdasiz. Guruhga qaytib kuting.");
    if (r === "full") return reply(msg, "❌ Ro'yxat to'lgan.");
    return reply(msg, "❌ Ro'yxat yopilgan.");
  }

  return reply(
    msg,
    "🎭 <b>Mafia botiga xush kelibsiz!</b>\n\nMen guruhlarda Mafia o'yinini o'tkazaman.\n" +
      "Meni guruhga qo'shing, admin qiling va <code>/game</code> yozing.\n\n" +
      "Rollaringiz va tungi tanlovlar shu yerda — shaxsiy chatda keladi.\n\n/rules — qoidalar"
  );
});

cmd("help", (msg) => reply(msg, HELP));
cmd("rules", (msg) => reply(msg, RULES));

// ---------- guruh buyruqlari ----------
cmd("game", async (msg) => {
  if (!isGroup(msg)) return reply(msg, "🎮 Bu buyruq faqat guruhda ishlaydi. Meni guruhga qo'shing.");
  const chatId = String(msg.chat.id);
  if (games.has(chatId)) {
    return reply(msg, "⚠️ Bu guruhda o'yin allaqachon boshlangan. /players — o'yinchilar, /stop — to'xtatish.");
  }
  const me = await getMe();
  const game = new Game({
    bot,
    botUsername: me.username,
    chatId: msg.chat.id,
    chatTitle: msg.chat.title,
    creator: msg.from,
    onEnd: (g) => games.delete(String(g.chatId)),
  });
  games.set(chatId, game);
  await warnIfBotNotAdmin(msg.chat.id);
  await game.open();
});

cmd("begin", async (msg) => {
  if (!isGroup(msg)) return;
  const game = games.get(String(msg.chat.id));
  if (!game || game.phase !== "registration") return reply(msg, "Ro'yxat ochiq o'yin yo'q. /game bilan oching.");
  if (msg.from.id !== game.creatorId && !(await isChatAdmin(msg.chat.id, msg.from.id))) {
    return reply(msg, "❌ Buni faqat o'yinni ochgan kishi yoki admin qila oladi.");
  }
  if (game.players.length < cfg.MIN_PLAYERS) {
    return reply(msg, `⚠️ Yana kamida ${cfg.MIN_PLAYERS - game.players.length} ta o'yinchi kerak.`);
  }
  await game.closeRegistration();
});

cmd("leave", async (msg) => {
  if (!isGroup(msg)) return;
  const game = games.get(String(msg.chat.id));
  if (!game) return;
  if (game.phase !== "registration") return reply(msg, "⚠️ O'yin boshlangan, chiqib bo'lmaydi.");
  if (game.removePlayer(msg.from.id)) return reply(msg, `👋 <b>${esc(msg.from.first_name)}</b> ro'yxatdan chiqdi.`);
});

cmd("players", async (msg) => {
  if (!isGroup(msg)) return;
  const game = games.get(String(msg.chat.id));
  if (!game) return reply(msg, "Hozir o'yin yo'q. /game bilan oching.");
  return reply(msg, game.playersText());
});

cmd("stop", async (msg) => {
  if (!isGroup(msg)) return;
  const game = games.get(String(msg.chat.id));
  if (!game) return reply(msg, "Hozir o'yin yo'q.");
  if (msg.from.id !== game.creatorId && !(await isChatAdmin(msg.chat.id, msg.from.id))) {
    return reply(msg, "❌ Buni faqat o'yinni ochgan kishi yoki admin qila oladi.");
  }
  await game.stop(msg.from.first_name || "admin");
});

// ---------- statistika ----------
cmd("mystats", async (msg) => {
  try {
    const s = await stats.getStats(msg.from.id);
    if (!s || !s.games) return reply(msg, "📊 Siz hali o'yin o'ynamagansiz.");
    const pct = Math.round((s.wins / s.games) * 100);
    return reply(msg, `📊 <b>${esc(msg.from.first_name)}</b>\n\n🎮 O'yinlar: ${s.games}\n🏆 G'alabalar: ${s.wins}\n📈 G'alaba foizi: ${pct}%`);
  } catch {
    return reply(msg, "⚠️ Statistika vaqtincha mavjud emas.");
  }
});

cmd("top", async (msg) => {
  try {
    const top = await stats.getTop(10);
    if (!top.length) return reply(msg, "🏆 Hali natijalar yo'q.");
    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((p, i) => `${medals[i] || `${i + 1}.`} ${esc(p.name)} — 🏆 ${p.wins} / 🎮 ${p.games}`);
    return reply(msg, `🏆 <b>Eng yaxshi o'yinchilar</b>\n\n${lines.join("\n")}`);
  } catch {
    return reply(msg, "⚠️ Statistika vaqtincha mavjud emas.");
  }
});

// ---------- tugmalar ----------
bot.on("callback_query", async (q) => {
  const answer = (text, alert = false) =>
    bot.answerCallbackQuery(q.id, { text, show_alert: alert }).catch(() => {});
  try {
    const [type, chatId, round, idx] = (q.data || "").split("|");
    const game = games.get(chatId);
    if (!game) return answer("⌛ O'yin tugagan.", true);

    let text;
    if (type === "n") text = await game.handleNightAction(q.from.id, Number(round), Number(idx));
    else if (type === "v") text = await game.handleVote(q.from.id, Number(round), Number(idx));
    else if (type === "s") text = await game.handleSkip(q.from.id, Number(round));
    return answer(text);
  } catch (e) {
    console.error("callback xatosi:", e);
    return answer("Xatolik yuz berdi.");
  }
});

// ---------- xabarlar nazorati ----------
bot.on("message", async (msg) => {
  if (!msg.from || msg.from.is_bot) return;

  // Shaxsiy chat: kechasi mafiya jamoadoshlariga yetkazish
  if (msg.chat.type === "private") {
    if (msg.text && !msg.text.startsWith("/")) {
      const game = findGameOfUser(msg.from.id);
      if (game) await game.relayMafia(msg.from.id, msg.text);
    }
    return;
  }

  // Guruh: o'lganlar va kechasi yozayotganlarning xabarini o'chirish
  const game = games.get(String(msg.chat.id));
  if (game && game.shouldDelete(msg.from.id)) {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  }
});

bot.on("polling_error", (e) => console.error("Polling xato:", e.message));
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));
