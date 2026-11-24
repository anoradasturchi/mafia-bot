"use strict";

const cfg = require("./config");
const stats = require("./models");

const ROLE = { MAFIA: "mafia", DOCTOR: "doctor", SHERIFF: "sheriff", CIVILIAN: "civilian" };

const INFO = {
  mafia: {
    emoji: "🔫",
    name: "Mafiya",
    text: "Kechasi bir o'yinchini o'ldirasiz. Maqsad: shaharni yo'q qilish.\nKechasi jamoadoshlaringizga shu chatda yozsangiz, bot ularga yetkazadi.",
  },
  doctor: {
    emoji: "💊",
    name: "Doktor",
    text: "Kechasi bir o'yinchini davolaysiz (o'zingizni ham mumkin). Bir kishini ketma-ket ikki kecha davolab bo'lmaydi.",
  },
  sheriff: {
    emoji: "👮",
    name: "Sherif",
    text: "Kechasi bir o'yinchini tekshirasiz va u mafiya yoki yo'qligini bilib olasiz.",
  },
  civilian: {
    emoji: "👨‍💼",
    name: "Fuqaro",
    text: "Maxsus qobiliyatingiz yo'q. Kunduzi muhokama qiling, ovoz bering va mafiyani toping.",
  },
};

// ---------- yordamchilar ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (s, n = 28) => {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const safe = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return null;
  }
};
const displayName = (u) =>
  [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);

// n ta o'yinchi uchun rollar: 1/3 mafiya (kamida 1), 1 doktor, 1 sherif, qolgani fuqaro
function buildRoles(n) {
  const mafia = Math.max(1, Math.floor(n / 3));
  const roles = Array(mafia).fill(ROLE.MAFIA);
  roles.push(ROLE.DOCTOR, ROLE.SHERIFF);
  while (roles.length < n) roles.push(ROLE.CIVILIAN);
  return shuffle(roles);
}

class Game {
  constructor({ bot, botUsername, chatId, chatTitle, creator, onEnd }) {
    this.bot = bot;
    this.botUsername = botUsername;
    this.chatId = chatId;
    this.chatTitle = chatTitle;
    this.creatorId = creator.id;
    this.onEnd = onEnd || (() => {});

    this.players = []; // { idx, id, name, role, alive }
    this.phase = "registration"; // registration | starting | night | day | vote | resolving | ended
    this.round = 0;
    this.timer = null;
    this.regMsgId = null;
    this.dayMsgId = null;
    this.voteMsgId = null;
    this.lastHeal = null;
    this.startedAt = null;
    this.winner = null;
    this.night = null;
    this.votes = new Map();
    this.skipVotes = new Set();
  }

  // ---------- umumiy ----------
  send(text, extra = {}) {
    return safe(() =>
      this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML", disable_web_page_preview: true, ...extra })
    );
  }
  dm(userId, text, extra = {}) {
    return safe(() => this.bot.sendMessage(userId, text, { parse_mode: "HTML", ...extra }));
  }
  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }
  alive() {
    return this.players.filter((p) => p.alive);
  }
  aliveMafia() {
    return this.alive().filter((p) => p.role === ROLE.MAFIA);
  }
  setTimer(sec, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.error("Timer xatosi:", e));
    }, sec * 1000);
  }
  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  run(promise) {
    Promise.resolve(promise).catch((e) => console.error("O'yin xatosi:", e));
  }

  // ---------- ro'yxatga olish ----------
  regKeyboard() {
    return {
      inline_keyboard: [
        [{ text: "✅ Qo'shilish", url: `https://t.me/${this.botUsername}?start=join_${this.chatId}` }],
      ],
    };
  }

  regText() {
    const list = this.players.length
      ? this.players.map((p, i) => `${i + 1}. ${esc(p.name)}`).join("\n")
      : "—";
    return (
      `🎭 <b>MAFIA — ro'yxatga olish</b>\n\n` +
      `👥 O'yinchilar (${this.players.length}/${cfg.MAX_PLAYERS}):\n${list}\n\n` +
      `Kamida ${cfg.MIN_PLAYERS} ta o'yinchi kerak.\n` +
      `Tugmani bosing, so'ng botda <b>Start</b> bosing.`
    );
  }

  async refreshReg() {
    if (!this.regMsgId) return;
    await safe(() =>
      this.bot.editMessageText(this.regText(), {
        chat_id: this.chatId,
        message_id: this.regMsgId,
        parse_mode: "HTML",
        reply_markup: this.regKeyboard(),
      })
    );
  }

  async open() {
    const m = await this.send(this.regText(), { reply_markup: this.regKeyboard() });
    this.regMsgId = m ? m.message_id : null;
    const total = cfg.REG_SECONDS;
    if (total > 30) {
      this.setTimer(total - 30, async () => {
        await this.send("⏳ Ro'yxat yopilishiga <b>30 soniya</b> qoldi!", { reply_markup: this.regKeyboard() });
        if (this.phase !== "registration") return;
        this.setTimer(30, () => this.closeRegistration());
      });
    } else {
      this.setTimer(total, () => this.closeRegistration());
    }
  }

  addPlayer(user) {
    if (this.phase !== "registration") return "closed";
    if (this.getPlayer(user.id)) return "already";
    if (this.players.length >= cfg.MAX_PLAYERS) return "full";
    this.players.push({ idx: -1, id: user.id, name: displayName(user), role: null, alive: true });
    this.run(this.refreshReg());
    return "ok";
  }

  removePlayer(id) {
    if (this.phase !== "registration") return false;
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.players.splice(i, 1);
    this.run(this.refreshReg());
    return true;
  }

  async closeRegistration() {
    if (this.phase !== "registration") return;
    this.clearTimer();
    if (this.players.length < cfg.MIN_PLAYERS) {
      this.phase = "ended";
      await this.send(
        `❌ O'yin bekor qilindi: kamida ${cfg.MIN_PLAYERS} ta o'yinchi kerak edi, ${this.players.length} ta yig'ildi.`
      );
      this.onEnd(this);
      return;
    }
    await this.begin();
  }

  // ---------- boshlash ----------
  async begin() {
    this.phase = "starting";
    this.clearTimer();
    this.players = shuffle(this.players);
    const roles = buildRoles(this.players.length);
    this.players.forEach((p, i) => {
      p.idx = i;
      p.role = roles[i];
      p.alive = true;
    });
    this.startedAt = new Date();

    if (this.regMsgId) {
      await safe(() =>
        this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: this.chatId, message_id: this.regMsgId })
      );
    }

    const count = (r) => roles.filter((x) => x === r).length;
    await this.send(
      `🎬 <b>O'yin boshlandi!</b>\n\n` +
        `👥 O'yinchilar (${this.players.length}):\n${this.players.map((p, i) => `${i + 1}. ${esc(p.name)}`).join("\n")}\n\n` +
        `🎭 Rollar: ${INFO.mafia.emoji} Mafiya — ${count(ROLE.MAFIA)}, ${INFO.doctor.emoji} Doktor — 1, ` +
        `${INFO.sheriff.emoji} Sherif — 1, ${INFO.civilian.emoji} Fuqaro — ${count(ROLE.CIVILIAN)}\n\n` +
        `📩 Rollaringiz botdan shaxsiy xabarda yuborildi.`
    );

    for (const p of this.players) {
      const info = INFO[p.role];
      let text = `${info.emoji} Sizning rolingiz: <b>${info.name}</b>\n\n${info.text}`;
      if (p.role === ROLE.MAFIA) {
        const mates = this.players.filter((x) => x.role === ROLE.MAFIA && x.id !== p.id);
        if (mates.length) text += `\n\n🤝 Jamoadoshlaringiz: ${mates.map((m) => esc(m.name)).join(", ")}`;
      }
      await this.dm(p.id, text);
    }

    if (this.phase !== "starting") return;
    await this.startNight();
  }

  // ---------- KECHA ----------
  targetKeyboard(prefix, targets) {
    return {
      inline_keyboard: targets.map((t) => [
        { text: short(t.name), callback_data: `${prefix}|${this.chatId}|${this.round}|${t.idx}` },
      ]),
    };
  }

  async startNight() {
    this.round += 1;
    this.phase = "night";
    this.night = {
      mafiaVotes: new Map(), // mafiya id -> nishon id
      doctorTarget: null,
      doctorDone: false,
      sheriffDone: false,
      prompts: new Map(), // userId -> message_id
      acted: new Set(),
    };

    await this.send(
      `🌙 <b>${this.round}-kecha</b>\n\nShahar uyquga ketdi... Mafiya, Doktor va Sherif botning shaxsiy chatida harakat qilmoqda.\n` +
        `⏱ ${cfg.NIGHT_SECONDS} soniya\n\n🤫 Kechasi guruhda yozish mumkin emas.`,
      { reply_markup: { inline_keyboard: [[{ text: "🤖 Botga o'tish", url: `https://t.me/${this.botUsername}` }]] } }
    );

    const alive = this.alive();
    for (const p of alive) {
      if (this.phase !== "night") return;
      let title;
      let targets;
      if (p.role === ROLE.MAFIA) {
        title = "🔫 Kimni o'ldirasiz?";
        targets = alive.filter((x) => x.role !== ROLE.MAFIA);
      } else if (p.role === ROLE.DOCTOR) {
        title = "💊 Kimni davolaysiz?";
        targets = alive.filter((x) => x.id !== this.lastHeal);
      } else if (p.role === ROLE.SHERIFF) {
        title = "👮 Kimni tekshirasiz?";
        targets = alive.filter((x) => x.id !== p.id);
      } else continue;

      const m = await this.dm(p.id, `🌙 <b>${this.round}-kecha</b>\n${title}`, {
        reply_markup: this.targetKeyboard("n", targets),
      });
      if (m) this.night.prompts.set(p.id, m.message_id);
    }

    if (this.phase !== "night") return;
    this.setTimer(cfg.NIGHT_SECONDS, () => this.endNight());
    this.checkNightComplete();
  }

  async handleNightAction(userId, round, targetIdx) {
    if (this.phase !== "night" || round !== this.round) return "⌛ Bu tugma eskirgan.";
    const p = this.getPlayer(userId);
    if (!p || !p.alive) return "Siz o'yinda emassiz.";
    const t = this.players[targetIdx];
    if (!t || !t.alive) return "Bu o'yinchi tirik emas.";
    const n = this.night;
    if (n.acted.has(p.id)) return "Siz allaqachon tanlagansiz.";

    if (p.role === ROLE.MAFIA) {
      if (t.role === ROLE.MAFIA) return "Jamoadoshingizni tanlab bo'lmaydi.";
      n.mafiaVotes.set(p.id, t.id);
      for (const m of this.aliveMafia()) {
        if (m.id !== p.id) this.run(this.dm(m.id, `🔫 <b>${esc(p.name)}</b> tanladi: <b>${esc(t.name)}</b>`));
      }
    } else if (p.role === ROLE.DOCTOR) {
      if (t.id === this.lastHeal) return "Bir kishini ketma-ket ikki kecha davolab bo'lmaydi.";
      n.doctorTarget = t;
      n.doctorDone = true;
    } else if (p.role === ROLE.SHERIFF) {
      if (t.id === p.id) return "O'zingizni tekshirib bo'lmaydi.";
      n.sheriffDone = true;
      const text =
        t.role === ROLE.MAFIA
          ? `🔎 <b>${esc(t.name)}</b> — 🔫 <b>MAFIYA!</b>`
          : `🔎 <b>${esc(t.name)}</b> — mafiya emas (tinch aholi).`;
      await this.dm(p.id, text);
    } else {
      return "Sizda tungi harakat yo'q.";
    }

    n.acted.add(p.id);
    const promptId = n.prompts.get(p.id);
    if (promptId) {
      await safe(() =>
        this.bot.editMessageText(`✅ Tanlov: <b>${esc(t.name)}</b>`, {
          chat_id: p.id,
          message_id: promptId,
          parse_mode: "HTML",
        })
      );
    }
    this.checkNightComplete();
    return "✅ Qabul qilindi";
  }

  checkNightComplete() {
    if (this.phase !== "night") return;
    const n = this.night;
    const mafiaDone = this.aliveMafia().every((m) => n.acted.has(m.id));
    const doc = this.alive().find((p) => p.role === ROLE.DOCTOR);
    const sher = this.alive().find((p) => p.role === ROLE.SHERIFF);
    if (mafiaDone && (!doc || n.doctorDone) && (!sher || n.sheriffDone)) {
      this.run(this.endNight());
    }
  }

  async endNight() {
    if (this.phase !== "night") return;
    this.phase = "resolving";
    this.clearTimer();
    const n = this.night;

    // Javob bermaganlarning tugmalarini o'chirish
    for (const [uid, mid] of n.prompts) {
      if (!n.acted.has(uid)) {
        this.run(
          safe(() =>
            this.bot.editMessageText("⌛ Vaqt tugadi.", { chat_id: uid, message_id: mid, parse_mode: "HTML" })
          )
        );
      }
    }

    // Mafiya nishoni: eng ko'p ovoz olgan (teng bo'lsa tasodifiy)
    const tally = new Map();
    for (const tid of n.mafiaVotes.values()) tally.set(tid, (tally.get(tid) || 0) + 1);
    let target = null;
    if (tally.size) {
      const max = Math.max(...tally.values());
      const top = [...tally].filter(([, c]) => c === max).map(([id]) => id);
      const pickId = top[Math.floor(Math.random() * top.length)];
      target = this.players.find((p) => p.id === pickId) || null;
    }

    const healed = n.doctorTarget;
    this.lastHeal = healed ? healed.id : null;

    let text;
    if (target && healed && healed.id === target.id) {
      text = `☀️ <b>Tong otdi.</b>\n\nKechasi mafiya hujum qildi, lekin 💊 Doktor o'z vaqtida yetib keldi — hech kim o'lmadi!`;
    } else if (target) {
      target.alive = false;
      const info = INFO[target.role];
      text =
        `☀️ <b>Tong otdi.</b>\n\nKechasi mafiya <b>${esc(target.name)}</b> ni o'ldirdi. 💀\n` +
        `U ${info.emoji} <b>${info.name}</b> edi.`;
    } else {
      text = `☀️ <b>Tong otdi.</b>\n\nBu kecha mafiya hech kimni tanlamadi — hech kim o'lmadi.`;
    }
    await this.send(text);

    const w = this.checkWin();
    if (w) return this.finish(w);
    await this.startDay();
  }

  // ---------- KUN ----------
  skipKeyboard() {
    const need = Math.floor(this.alive().length / 2) + 1;
    return {
      inline_keyboard: [
        [{ text: `🗳 Ovozga o'tish (${this.skipVotes.size}/${need})`, callback_data: `s|${this.chatId}|${this.round}` }],
      ],
    };
  }

  async startDay() {
    this.phase = "day";
    this.skipVotes = new Set();
    const alive = this.alive();
    const list = alive.map((p, i) => `${i + 1}. ${esc(p.name)}`).join("\n");
    const m = await this.send(
      `🗣 <b>${this.round}-kun — muhokama</b>\n\n👥 Tirik o'yinchilar (${alive.length}):\n${list}\n\n` +
        `💬 Muhokama qiling — mafiyani toping!\n⏱ ${cfg.DAY_SECONDS} soniyadan keyin ovoz berish boshlanadi.`,
      { reply_markup: this.skipKeyboard() }
    );
    this.dayMsgId = m ? m.message_id : null;
    if (this.phase !== "day") return;
    this.setTimer(cfg.DAY_SECONDS, () => this.startVote());
  }

  async handleSkip(userId, round) {
    if (this.phase !== "day" || round !== this.round) return "⌛ Bu tugma eskirgan.";
    const p = this.getPlayer(userId);
    if (!p || !p.alive) return "Faqat tirik o'yinchilar bosa oladi.";
    if (this.skipVotes.has(userId)) return "Siz allaqachon bosgansiz.";
    this.skipVotes.add(userId);
    const need = Math.floor(this.alive().length / 2) + 1;
    if (this.skipVotes.size >= need) {
      this.run(this.startVote());
    } else if (this.dayMsgId) {
      await safe(() =>
        this.bot.editMessageReplyMarkup(this.skipKeyboard(), { chat_id: this.chatId, message_id: this.dayMsgId })
      );
    }
    return "✅ Qabul qilindi";
  }

  // ---------- OVOZ BERISH ----------
  voteCounts() {
    const m = new Map();
    for (const idx of this.votes.values()) m.set(idx, (m.get(idx) || 0) + 1);
    return m;
  }

  voteKeyboard() {
    const counts = this.voteCounts();
    const rows = this.alive().map((t) => [
      {
        text: `${short(t.name)}${counts.get(t.idx) ? ` — ${counts.get(t.idx)}` : ""}`,
        callback_data: `v|${this.chatId}|${this.round}|${t.idx}`,
      },
    ]);
    rows.push([
      {
        text: `🤷 Hech kim${counts.get(-1) ? ` — ${counts.get(-1)}` : ""}`,
        callback_data: `v|${this.chatId}|${this.round}|-1`,
      },
    ]);
    return { inline_keyboard: rows };
  }

  voteText() {
    return (
      `🗳 <b>Ovoz berish</b>\n\nKimni shahardan chiqaramiz?\n` +
      `Ovoz berdi: ${this.votes.size}/${this.alive().length}\n⏱ ${cfg.VOTE_SECONDS} soniya`
    );
  }

  async startVote() {
    if (this.phase !== "day") return;
    this.phase = "vote";
    this.clearTimer();
    this.votes = new Map();
    if (this.dayMsgId) {
      await safe(() =>
        this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: this.chatId, message_id: this.dayMsgId })
      );
    }
    const m = await this.send(this.voteText(), { reply_markup: this.voteKeyboard() });
    this.voteMsgId = m ? m.message_id : null;
    if (this.phase !== "vote") return;
    this.setTimer(cfg.VOTE_SECONDS, () => this.endVote());
  }

  async handleVote(userId, round, targetIdx) {
    if (this.phase !== "vote" || round !== this.round) return "⌛ Bu tugma eskirgan.";
    const p = this.getPlayer(userId);
    if (!p || !p.alive) return "Faqat tirik o'yinchilar ovoz bera oladi.";
    if (targetIdx !== -1) {
      const t = this.players[targetIdx];
      if (!t || !t.alive) return "Bu o'yinchi tirik emas.";
      if (t.id === p.id) return "O'zingizga ovoz bera olmaysiz.";
    }
    this.votes.set(p.id, targetIdx);

    if (this.votes.size >= this.alive().length) {
      this.run(this.endVote());
    } else if (this.voteMsgId) {
      await safe(() =>
        this.bot.editMessageText(this.voteText(), {
          chat_id: this.chatId,
          message_id: this.voteMsgId,
          parse_mode: "HTML",
          reply_markup: this.voteKeyboard(),
        })
      );
    }
    return "✅ Ovozingiz qabul qilindi";
  }

  async endVote() {
    if (this.phase !== "vote") return;
    this.phase = "resolving";
    this.clearTimer();

    const counts = this.voteCounts();
    const skip = counts.get(-1) || 0;
    let top = [];
    let max = 0;
    for (const p of this.alive()) {
      const c = counts.get(p.idx) || 0;
      if (c > max) {
        max = c;
        top = [p];
      } else if (c === max && c > 0) {
        top.push(p);
      }
    }

    const summary = this.alive()
      .filter((p) => counts.get(p.idx))
      .map((p) => `• ${esc(p.name)} — ${counts.get(p.idx)} ovoz`)
      .join("\n");
    if (this.voteMsgId) {
      await safe(() =>
        this.bot.editMessageText(`🗳 <b>Ovoz berish yakunlandi</b>${summary ? `\n\n${summary}` : ""}`, {
          chat_id: this.chatId,
          message_id: this.voteMsgId,
          parse_mode: "HTML",
        })
      );
    }

    if (top.length === 1 && max > skip) {
      const out = top[0];
      out.alive = false;
      const info = INFO[out.role];
      await this.send(
        `⚖️ Shahar qarori: <b>${esc(out.name)}</b> chiqarib yuborildi. 💀\nU ${info.emoji} <b>${info.name}</b> edi.`
      );
    } else if (max === 0) {
      await this.send(`⚖️ Hech kim ovoz bermadi — bugun hech kim chiqarilmadi.`);
    } else {
      await this.send(`⚖️ Ovozlar bo'lindi yoki "hech kim" ko'proq — bugun hech kim chiqarilmadi.`);
    }

    const w = this.checkWin();
    if (w) return this.finish(w);
    await this.startNight();
  }

  // ---------- TUGASH ----------
  checkWin() {
    const mafia = this.aliveMafia().length;
    const others = this.alive().length - mafia;
    if (mafia === 0) return "city";
    if (mafia >= others) return "mafia";
    return null;
  }

  rolesList() {
    return this.players
      .map((p) => `${p.alive ? "✅" : "💀"} ${INFO[p.role].emoji} ${esc(p.name)} — ${INFO[p.role].name}`)
      .join("\n");
  }

  playersText() {
    if (this.phase === "registration") return this.regText();
    const alive = this.alive();
    const dead = this.players.filter((p) => !p.alive);
    let t = `👥 <b>Tirik o'yinchilar (${alive.length}):</b>\n${alive.map((p, i) => `${i + 1}. ${esc(p.name)}`).join("\n")}`;
    if (dead.length) {
      t += `\n\n<b>O'lganlar:</b>\n${dead.map((p) => `💀 ${esc(p.name)} — ${INFO[p.role].emoji} ${INFO[p.role].name}`).join("\n")}`;
    }
    return t;
  }

  async finish(winner) {
    if (this.phase === "ended") return;
    this.phase = "ended";
    this.winner = winner;
    this.clearTimer();
    const title =
      winner === "mafia" ? "🔫 <b>MAFIYA G'ALABA QILDI!</b>" : "🏙 <b>SHAHAR G'ALABA QILDI!</b>";
    await this.send(`${title}\n\n${this.rolesList()}\n\n🕐 O'yin ${this.round} raund davom etdi.`);
    stats.recordGame(this, winner).catch((e) => console.warn("Statistika saqlanmadi:", e.message));
    this.onEnd(this);
  }

  async stop(by) {
    if (this.phase === "ended") return;
    const started = this.players.length > 0 && this.players[0].role;
    this.phase = "ended";
    this.clearTimer();
    await this.send(`🛑 O'yin <b>${esc(by)}</b> tomonidan to'xtatildi.${started ? `\n\n${this.rolesList()}` : ""}`);
    this.onEnd(this);
  }

  // ---------- chat nazorati ----------
  // Guruhda yozgan xabar o'chirilishi kerakmi?
  shouldDelete(userId) {
    const p = this.getPlayer(userId);
    if (!p) return false;
    if (this.phase === "registration" || this.phase === "ended") return false;
    if (!p.alive) return true; // o'lganlar yozolmaydi
    return this.phase === "night"; // kechasi hamma jim
  }

  // Kechasi mafiya a'zolari botdagi shaxsiy chatda gaplashadi
  async relayMafia(userId, text) {
    const p = this.getPlayer(userId);
    if (!p || !p.alive || p.role !== ROLE.MAFIA) return false;
    if (this.phase !== "night") return false;
    for (const m of this.aliveMafia()) {
      if (m.id !== p.id) await this.dm(m.id, `🔫 <b>${esc(p.name)}</b>: ${esc(text)}`);
    }
    return true;
  }
}

module.exports = { Game, ROLE, INFO, esc, buildRoles };
