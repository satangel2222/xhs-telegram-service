// --- Final Version v2.0 ---
console.log("Starting server v2.0, handling POST on '/api/send'...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// --- Middlewares ---
app.use((req, res, next) => {
  console.log(`Request received: ${req.method} ${req.originalUrl}`);
  next();
});

const corsOptions = {
  origin: 'https://www.xiaohongshu.com',
  methods: 'POST, GET, OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Routes ---
// Explicitly handle OPTIONS for the new path
app.options('/api/send', cors(corsOptions));

// Core POST route now listens on '/api/send'
app.post('/api/send', async (req, res) => {
  console.log("Request processing started for '/api/send'. Title:", req.body.title);
  
  const { noteUrl, title, author, files } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, message: 'No files to process.' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!botToken || !channelId) {
    return res.status(500).json({ ok: false, message: 'Server environment variables not configured.' });
  }

  try {
    let caption = `*${title.trim()}*\n\n*作者:* ${author.trim()}\n*来源:* [点击查看](${noteUrl})`;
    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMediaGroup`;
    const media = files.map((file, index) => ({
      type: file.type === 'video' ? 'video' : 'photo',
      media: file.url,
      caption: index === 0 ? caption : '',
      parse_mode: 'Markdown'
    }));

    const response = await axios.post(telegramApiUrl, {
      chat_id: channelId,
      media: media
    });

    if (response.data.ok) {
      console.log('Successfully forwarded to Telegram:', title);
      res.status(200).json({ ok: true, message: 'Successfully forwarded to Telegram.' });
    } else {
      throw new Error(response.data.description);
    }
  } catch (error) {
    console.error("Error in '/api/send' handler:", error.response ? error.response.data : error.message);
    res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${error.message}` });
  }
});

// --- Server Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server v2.0 is listening on port ${PORT}`);
});
