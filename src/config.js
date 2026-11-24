"use strict";
require("dotenv").config();

const num = (key, def) => {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  MONGO_URI: process.env.MONGO_URI || "mongodb://localhost:27017/mafia_bot",
  MIN_PLAYERS: num("MIN_PLAYERS", 5),
  MAX_PLAYERS: num("MAX_PLAYERS", 20),
  REG_SECONDS: num("REG_SECONDS", 90),
  NIGHT_SECONDS: num("NIGHT_SECONDS", 45),
  DAY_SECONDS: num("DAY_SECONDS", 90),
  VOTE_SECONDS: num("VOTE_SECONDS", 45),
};
