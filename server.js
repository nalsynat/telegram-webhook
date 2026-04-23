const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// 👉 PUT YOUR APPS SCRIPT URL HERE
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzeO3SaLOzbS7L7cqJJf5uJ3v9X1u6KtYZOYfwW0o9Yj3zQYdmg5fYm9DnRI0EY4ZA6/exec";

app.post('/', async (req, res) => {
  // Respond to Telegram immediately
  res.status(200).send('OK');

  try {
    await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
  } catch (err) {
    console.log(err);
  }
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(10000, () => console.log("Running"));