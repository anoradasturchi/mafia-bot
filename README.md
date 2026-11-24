# 🎭 Mafia Bot (Node.js)

## Ishga tushirish (Windows)
1. **Yangi bot yarating**: @BotFather → `/newbot`. (Qorovul botning tokenini ishlatmang — bitta token bilan ikkita dastur ishlay olmaydi.)
2. `.env.example` faylidan nusxa oling:
   ```cmd
   copy .env.example .env
   ```
   `.env` ichiga `BOT_TOKEN` ni yozing. MongoDB local bo'lsa `MONGO_URI` o'zgarmaydi.
3. ```cmd
   npm install
   npm start
   ```
4. Botni guruhga qo'shing va **admin** qiling (**«Xabarlarni o'chirish»** huquqi shart).
5. Guruhda `/game` yozing.

## Tekshirish (Telegramsiz)
```cmd
npm test
```

## Fayllar
- `src/index.js` — buyruqlar, tugmalar, xabarlar nazorati
- `src/game.js` — o'yin mantig'i (ro'yxat, kecha, kun, ovoz, g'alaba)
- `src/models.js` — MongoDB statistika
- `src/config.js` — sozlamalar (`.env` dan)
