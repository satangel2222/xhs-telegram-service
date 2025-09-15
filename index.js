const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;

if (!token || !channelId) {
    console.error("错误：请在 Render 的 Environment Variables 中设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHANNEL_ID");
}

const bot = new TelegramBot(token);
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Hello! Your XHS-to-Telegram service on Render is running.');
});

app.post('/send', async (req, res) => {
    console.log("收到 /send 请求:", req.body);
    const { noteUrl, title, author, files } = req.body;

    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ ok: false, message: '无效的文件数据' });
    }

    try {
        const caption = `*${title.trim()}*\n\n作者: ${author}\n链接: [点击查看原笔记](${noteUrl})`;
        
        await bot.sendMessage(channelId, caption, { parse_mode: 'Markdown', disable_web_page_preview: true });

        if (files.length > 0) {
            const media = files.map(file => ({
                type: file.type, // 'photo' or 'video'
                media: file.url,
            }));
            
            for (let i = 0; i < media.length; i += 10) {
                const chunk = media.slice(i, i + 10);
                await bot.sendMediaGroup(channelId, chunk);
            }
        }

        res.status(200).json({ ok: true, message: '成功发送到 Telegram' });

    } catch (error) {
        const errorMessage = error.response ? error.response.body : error.message;
        console.error('发送到 Telegram 失败:', errorMessage);
        res.status(500).json({ ok: false, message: String(errorMessage) });
    }
});

const port = process.env.PORT || 3000; // Render 使用 PORT 环境变量
app.listen(port, () => {
    console.log(`服务器正在端口 ${port} 运行`);
});
