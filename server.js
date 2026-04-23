const express = require('express');
const axios = require('axios');
const userState = {};

const app = express();
app.use(express.json());

// 👉 PUT YOUR APPS SCRIPT URL HERE
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzeO3SaLOzbS7L7cqJJf5uJ3v9X1u6KtYZOYfwW0o9Yj3zQYdmg5fYm9DnRI0EY4ZA6/exec";

app.post('/', async (req, res) => {
  const data = req.body;

  if (!data.message) {
    return res.sendStatus(200);
  }

  const chatId = data.message.chat.id;

  // 1. /start
  if (data.message.text === "/start") {
    await sendMessage(chatId, "👋 Welcome!\nSend voice to register.");
    return res.sendStatus(200);
  }

  // 2. VOICE
  if (data.message.voice) {
    const fileId = data.message.voice.file_id;

    // TEMP STORE (simple)
    userState[chatId] = {
      step: "WAIT_PHONE",
      voice: fileId
    };

    await sendMessage(chatId, "📱 Please send your phone number.");
    return res.sendStatus(200);
  }

  // 3. CONTACT
  if (data.message.contact) {
    const phone = data.message.contact.phone_number;

    if (userState[chatId] && userState[chatId].step === "WAIT_PHONE") {

      const voice = userState[chatId].voice;

      console.log("SAVE WORKER:", {
        chatId,
        phone,
        voice
      });

      await sendMessage(chatId, "✅ Registered successfully!");

      userState[chatId] = null;
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(10000, () => console.log("Running"));
const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;

  await axios.post(url, {
    chat_id: chatId,
    text: text
  });
}

async function sendText(chatId, text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}