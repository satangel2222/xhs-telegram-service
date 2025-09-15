const express = require('express');
const cors = require('cors');
const axios = require('axios'); // 引入axios用于向Telegram发请求

const app = express();

// --- 中间件设置 ---

// 1. 设置CORS策略，允许来自小红书的跨域请求
const corsOptions = {
  origin: 'https://www.xiaohongshu.com',
  methods: 'POST, GET, OPTIONS',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// 2. 使用Express内置的body-parser来解析JSON格式的请求体
// 这是让 req.body 能正确获取数据的关键
app.use(express.json());


// --- 路由定义 ---

// 根路径路由 (GET /)
// 用于 UptimeRobot 监控或浏览器直接访问测试，确认服务是否存活
app.get('/', (req, res) => {
  res.status(200).send('Backend service is running. Ready to receive POST requests at /send.');
});

// 核心路由 (POST /send)
// *** 这就是修复404错误的关键部分 ***
app.post('/send', async (req, res) => {
  // 从请求体中获取数据
  const { noteUrl, title, author, files } = req.body;

  // 简单验证一下收到的数据
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, message: 'No files to process.' });
  }

  // --- 调用 Telegram Bot API ---
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!botToken || !channelId) {
    console.error('环境变量 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHANNEL_ID 未设置!');
    return res.status(500).json({ ok: false, message: 'Server environment variables not configured.' });
  }

  try {
    // 构造发送到Telegram的消息内容
    let caption = `*${title.trim()}*\n\n` +
                  `*作者:* ${author.trim()}\n` +
                  `*来源:* [点击查看](${noteUrl})`;

    // Telegram API URL
    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMediaGroup`;

    // 准备媒体文件数组
    const media = files.map((file, index) => ({
      type: file.type === 'video' ? 'video' : 'photo',
      media: file.url,
      // 只在第一个媒体上添加标题
      caption: index === 0 ? caption : '',
      parse_mode: 'Markdown'
    }));

    // 使用 axios 发送请求到 Telegram
    const response = await axios.post(telegramApiUrl, {
      chat_id: channelId,
      media: media
    });

    // 如果Telegram API成功返回，则向前端也返回成功
    if (response.data.ok) {
      console.log('成功转发到Telegram:', title);
      res.status(200).json({ ok: true, message: 'Successfully forwarded to Telegram.' });
    } else {
      throw new Error(response.data.description);
    }

  } catch (error) {
    console.error('转发到Telegram时出错:', error.response ? error.response.data : error.message);
    res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${error.message}` });
  }
});


// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
