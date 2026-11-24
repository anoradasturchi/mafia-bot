"use strict";
const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  name: String,
  games: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  updatedAt: Date,
});

const gameSchema = new mongoose.Schema({
  chatId: String,
  chatTitle: String,
  winner: String,
  rounds: Number,
  players: [{ userId: String, name: String, role: String, alive: Boolean }],
  startedAt: Date,
  endedAt: { type: Date, default: Date.now },
});

const Player = mongoose.model("Player", playerSchema);
const GameLog = mongoose.model("GameLog", gameSchema);

// winner: "mafia" | "city"
async function recordGame(game, winner) {
  const ops = game.players.map((p) => {
    const won = (winner === "mafia") === (p.role === "mafia");
    return {
      updateOne: {
        filter: { userId: String(p.id) },
        update: {
          $set: { name: p.name, updatedAt: new Date() },
          $inc: { games: 1, wins: won ? 1 : 0 },
        },
        upsert: true,
      },
    };
  });
  await Player.bulkWrite(ops);
  await GameLog.create({
    chatId: String(game.chatId),
    chatTitle: game.chatTitle,
    winner,
    rounds: game.round,
    players: game.players.map((p) => ({ userId: String(p.id), name: p.name, role: p.role, alive: p.alive })),
    startedAt: game.startedAt,
  });
}

const getStats = (userId) => Player.findOne({ userId: String(userId) }).lean();
const getTop = (limit = 10) =>
  Player.find({ games: { $gt: 0 } }).sort({ wins: -1, games: 1 }).limit(limit).lean();

module.exports = { recordGame, getStats, getTop };
