"use strict";
// Telegramsiz test: soxta bot + tasodifiy o'yinchilar bilan o'yin mantig'ini tekshiradi.
const assert = require("assert");
const cfg = require("../src/config");
Object.assign(cfg, { MIN_PLAYERS: 5, MAX_PLAYERS: 20, REG_SECONDS: 5, NIGHT_SECONDS: 0.06, DAY_SECONDS: 0.04, VOTE_SECONDS: 0.04 });
const stats = require("../src/models");
stats.recordGame = async () => {};
const { Game } = require("../src/game");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
async function waitFor(cond, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("waitFor: vaqt tugadi");
    await sleep(3);
  }
}

function makeBot() {
  let id = 1;
  return {
    log: [],
    async sendMessage(chat, text, opts) {
      this.log.push({ chat, text, opts });
      return { message_id: id++ };
    },
    async editMessageText() { return true; },
    async editMessageReplyMarkup() { return true; },
    async deleteMessage() { return true; },
    dms(userId) { return this.log.filter((m) => m.chat === userId).map((m) => m.text); },
  };
}

async function setup(n) {
  const bot = makeBot();
  const state = { ended: false };
  const g = new Game({ bot, botUsername: "test_bot", chatId: -1001, chatTitle: "T", creator: { id: 1 }, onEnd: () => (state.ended = true) });
  await g.open();
  for (let i = 0; i < n; i++) assert.strictEqual(g.addPlayer({ id: 1000 + i, first_name: "P" + i }), "ok");
  await g.closeRegistration();
  return { g, bot, state };
}

const byRole = (g, r) => g.players.filter((p) => p.role === r);

async function scenarioDoctorSavesAndCityWins() {
  const { g, bot, state } = await setup(5);
  assert.strictEqual(g.phase, "night");
  assert.deepStrictEqual(
    ["mafia", "doctor", "sheriff"].map((r) => byRole(g, r).length),
    [1, 1, 1]
  );
  const [mafia] = byRole(g, "mafia");
  const [doc] = byRole(g, "doctor");
  const [sher] = byRole(g, "sheriff");
  const civ = byRole(g, "civilian");

  // 1-kecha: mafiya fuqaroni tanlaydi, doktor shuni davolaydi, sherif mafiyani topadi
  await g.handleNightAction(mafia.id, 1, civ[0].idx);
  await g.handleNightAction(doc.id, 1, civ[0].idx);
  await g.handleNightAction(sher.id, 1, mafia.idx);
  await waitFor(() => g.phase === "day");
  assert.strictEqual(g.alive().length, 5, "doktor qutqarishi kerak edi");
  assert(bot.dms(sher.id).some((t) => t.includes("MAFIYA")), "sherif mafiyani bilishi kerak");
  assert(g.shouldDelete(civ[0].id) === false, "kunduzi tirik o'yinchi yoza oladi");

  // kunduz -> ovoz (hech kim ovoz bermaydi) -> 2-kecha
  await waitFor(() => g.phase === "night" && g.round === 2);
  assert(g.shouldDelete(civ[0].id) === true, "kechasi hamma jim");

  // 2-kecha: doktor boshqani davolaydi (ketma-ket bir kishini emas), mafiya fuqarolardan birini o'ldiradi
  const again = await g.handleNightAction(doc.id, 2, civ[0].idx);
  assert(/ketma-ket/.test(again), "ketma-ket davolash taqiqlangan");
  await g.handleNightAction(doc.id, 2, sher.idx);
  await g.handleNightAction(mafia.id, 2, civ[0].idx);
  await g.handleNightAction(sher.id, 2, civ[1].idx);
  await waitFor(() => g.phase === "day");
  assert.strictEqual(civ[0].alive, false);
  assert(g.shouldDelete(civ[0].id) === true, "o'lgan yozolmaydi");

  // ovoz berish: hamma mafiyaga ovoz beradi
  await waitFor(() => g.phase === "vote");
  for (const p of g.alive()) {
    if (p.id !== mafia.id) await g.handleVote(p.id, g.round, mafia.idx);
  }
  await waitFor(() => g.phase === "ended");
  assert.strictEqual(g.winner, "city");
  assert(state.ended, "onEnd chaqirilishi kerak");
  assert.strictEqual(g.timer, null);
}

async function scenarioStopAndCancel() {
  const { g, state } = await setup(5);
  await g.stop("test");
  assert.strictEqual(g.phase, "ended");
  assert(state.ended);

  const bot = makeBot();
  const s2 = { ended: false };
  const g2 = new Game({ bot, botUsername: "b", chatId: -2, chatTitle: "T", creator: { id: 1 }, onEnd: () => (s2.ended = true) });
  await g2.open();
  g2.addPlayer({ id: 1, first_name: "A" });
  assert.strictEqual(g2.addPlayer({ id: 1, first_name: "A" }), "already");
  await g2.closeRegistration();
  assert.strictEqual(g2.phase, "ended");
  assert(s2.ended, "yetarli odam bo'lmasa bekor qilinadi");
}

// Tasodifiy o'yinchilar (ba'zilari AFK) bilan to'liq o'yin
async function fuzzOne() {
  const n = 5 + Math.floor(Math.random() * 9);
  const { g, state } = await setup(n);
  const afk = new Set(g.players.filter(() => Math.random() < 0.2).map((p) => p.id));
  let guard = 0;
  while (g.phase !== "ended") {
    if (++guard > 3000) throw new Error(`O'yin qotib qoldi: phase=${g.phase}, round=${g.round}`);
    await sleep(3);
    const alive = g.alive();
    if (g.phase === "night") {
      for (const p of alive) {
        if (afk.has(p.id) || p.role === "civilian") continue;
        const targets = alive.filter((x) => (p.role === "mafia" ? x.role !== "mafia" : p.role === "sheriff" ? x.id !== p.id : true));
        if (targets.length) await g.handleNightAction(p.id, g.round, pick(targets).idx);
      }
    } else if (g.phase === "day") {
      for (const p of alive) if (!afk.has(p.id) && Math.random() < 0.5) await g.handleSkip(p.id, g.round);
    } else if (g.phase === "vote") {
      for (const p of alive) {
        if (afk.has(p.id) || Math.random() < 0.2) continue;
        await g.handleVote(p.id, g.round, Math.random() < 0.15 ? -1 : pick(alive.filter((x) => x.id !== p.id)).idx);
      }
    }
    // eskirgan tugmalar xato bermasligi kerak
    await g.handleVote(1000, g.round - 1, 0);
    await g.handleNightAction(1000, g.round - 1, 0);
  }
  const mafia = g.aliveMafia().length;
  const others = g.alive().length - mafia;
  assert(g.winner === "mafia" || g.winner === "city");
  assert(g.winner === "city" ? mafia === 0 : mafia >= others && mafia > 0, "g'alaba sharti noto'g'ri");
  assert.strictEqual(g.timer, null, "taymer to'xtatilmagan");
  await waitFor(() => state.ended, 500); // onEnd yakuniy xabar yuborilgach chaqiriladi
  return g.winner;
}

(async () => {
  await scenarioDoctorSavesAndCityWins();
  console.log("✅ Senariy: doktor qutqaradi, shahar yutadi");
  await scenarioStopAndCancel();
  console.log("✅ Senariy: /stop va yetarli odam yo'q");

  const tally = { mafia: 0, city: 0 };
  const N = 150;
  for (let i = 0; i < N; i++) tally[await fuzzOne()]++;
  console.log(`✅ ${N} ta tasodifiy o'yin tugadi — shahar: ${tally.city}, mafiya: ${tally.mafia}`);
  process.exit(0);
})().catch((e) => {
  console.error("❌ TEST XATOSI:", e);
  process.exit(1);
});
