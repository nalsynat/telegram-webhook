const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// 👉 PUT YOUR APPS SCRIPT URL HERE
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzeO3SaLOzbS7L7cqJJf5uJ3v9X1u6KtYZOYfwW0o9Yj3zQYdmg5fYm9DnRI0EY4ZA6/exec";

app.post('/', async (req, res) => {
  const data = req.body;

  console.log("🔥 UPDATE:", JSON.stringify(data));

  try {
    if (data.message) {
      const chatId = data.message.chat.id;

      await sendText(chatId, "✅ Bot is alive");
    }

    if (data.callback_query) {
      const chatId = data.callback_query.message.chat.id;

      await sendText(chatId, "✅ Button clicked");
    }

  } catch (e) {
    console.log("❌ ERROR:", e);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(10000, () => console.log("Running"));
const axios = require("axios");
const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendText(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}