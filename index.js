// --- Enhanced Logging v1.8 ---
console.log("Starting server v1.8 with explicit OPTIONS handler...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// --- 中间件 ---

// 一个简单的日志记录器，用于查看是否有任何请求到达应用
app.use((req, res, next) => {
  console.log(`Request received: ${req.method} ${req.originalUrl}`);
  next();
});

// 设置CORS选项
const corsOptions = {
  origin: 'https://www.xiaohongshu.com',
  methods: 'POST, GET, OPTIONS', // 明确允许的方法
  allowedHeaders: 'Content-Type, Authorization', // 明确允许的请求头
  optionsSuccessStatus: 200 
};

// 全局使用CORS中间件
app.use(cors(corsOptions));

// 在 /send 路由上，专门、明确地处理OPTIONS预检请求
// 这是确保预检成功的关键
app.options('/send', cors(corsOptions));

// JSON Body解析器
app.use(express.json());


// --- 路由 ---

// 根路径用于健康检查
app.get('/', (req, res) => {
  res.status(200).send('Backend service is running. The /send endpoint is active.');
});

// 核心的POST路由
app.post('/send', async (req, res) => {
  console.log("Request processing started for /send. Title:", req.body.title);
  
  const { noteUrl, title, author, files } = req.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    console.error("Validation Error: No files in request.");
    return res.status(400).json({ ok: false, message: 'No files to process.' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) {
    console.error('Server Error: Environment variables not configured!');
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
      console.error('Telegram API returned an error:', response.data);
      throw new Error(response.data.description);
    }

  } catch (error) {
    console.error('Error in /send handler:', error.response ? error.response.data : error.message);
    res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${error.message}` });
  }
});


// --- 服务器启动 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server v1.8 is listening on port ${PORT}`);
});
