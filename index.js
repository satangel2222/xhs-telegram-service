// --- 增强日志，确认新代码部署成功 ---
console.log("Starting server with /send route and enhanced logging...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// 1. 设置CORS策略
const corsOptions = {
  origin: 'https://www.xiaohongshu.com',
  methods: 'POST, GET, OPTIONS',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// 2. 解析JSON请求体
app.use(express.json());

// --- 路由定义 ---

// 根路径路由 (GET /)
app.get('/', (req, res) => {
  res.status(200).send('Backend service is running. The /send endpoint is active.');
});

// 核心路由 (POST /send)
app.post('/send', async (req, res) => {
  console.log("Received a request on /send with body:", req.body.title); // 添加日志，确认收到请求
  
  const { noteUrl, title, author, files } = req.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    console.error("Validation Error: No files in request.");
    return res.status(400).json({ ok: false, message: 'No files to process.' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) {
    console.error('Server Error: Environment variables TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID not set!');
    return res.status(500).json({ ok: false, message: 'Server environment variables not configured.' });
  }

  try {
    let caption = `*${title.trim()}*\n\n` +
                  `*作者:* ${author.trim()}\n` +
                  `*来源:* [点击查看](${noteUrl})`;

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
      // 将Telegram返回的错误也记录下来
      console.error('Telegram API returned an error:', response.data);
      throw new Error(response.data.description);
    }

  } catch (error) {
    // 打印详细的axios错误信息
    console.error('Error while forwarding to Telegram:', error.response ? error.response.data : error.message);
    res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${error.message}` });
  }
});

// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
