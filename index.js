// --- xhs-telegram-service v2.2 ---
// Features: /api/send 支持两种模式：
// 1) 直链模式（把 URL 交给 Telegram 拉取）
// 2) 代理转传模式（服务端拉流后以 attach:// 上传，解决短效/跨区）
// 带 /、/healthz；自动分批 ≤10；HTML caption；基本错误可读日志

console.log("Starting server v2.2, handling POST on '/api/send'...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const UA = 'Mozilla/5.0 (compatible; media2tg/2.2; +render)';

// -------- Middlewares --------
app.use((req, _res, next) => { console.log(`Request: ${req.method} ${req.originalUrl}`); next(); });

app.use(cors({
  origin: (_o, cb) => cb(null, true), // GM_xmlhttpRequest 不受限；若要收敛可改白名单
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 200,
}));
app.use(express.json({ limit: '3mb' }));
app.options('/api/send');

// -------- Helpers --------
const escapeHtml = (s='')=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const filenameFromUrl = (u)=>{ try{ return decodeURIComponent(new URL(u).pathname.split('/').pop()||'file'); }catch{ return 'file'; } };

async function tgSendMediaGroupURL({ botToken, chatId, media, captionHtml }) {
  const tg = `https://api.telegram.org/bot${botToken}/sendMediaGroup`;
  const payload = media.map((m,i)=>({
    type: m.type==='video' ? 'video' : 'photo',
    media: m.url,
    caption: i===0 ? captionHtml : undefined,
    parse_mode: 'HTML'
  }));
  const { data } = await axios.post(tg, { chat_id: chatId, media: payload }, { timeout: 30000 });
  if (!data.ok) throw new Error(data.description || 'sendMediaGroup(url) failed');
}

async function tgSendMediaGroupProxy({ botToken, chatId, files, captionHtml }) {
  const tg = `https://api.telegram.org/bot${botToken}/sendMediaGroup`;
  const form = new FormData();
  const media = [];

  for (let i=0;i<files.length;i++){
    const f = files[i];
    const attach = `file${i}`;
    media.push({
      type: f.type==='video' ? 'video' : 'photo',
      media: `attach://${attach}`,
      caption: i===0 ? captionHtml : undefined,
      parse_mode: 'HTML'
    });
    const resp = await axios.get(f.url, { responseType:'stream', headers:{'User-Agent':UA}, timeout: 45000 });
    form.append(attach, resp.data, { filename: filenameFromUrl(f.url) });
  }

  form.append('chat_id', chatId);
  form.append('media', JSON.stringify(media));

  const { data } = await axios.post(tg, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 90000
  });
  if (!data.ok) throw new Error(data.description || 'sendMediaGroup(proxy) failed');
}

// -------- Routes --------
app.get('/', (_req, res)=>res.send('xhs-telegram-service up'));
app.get('/healthz', (_req, res)=>res.json({ ok:true, version:'v2.2', uptime:process.uptime() }));

app.post('/api/send', async (req, res) => {
  try{
    const { pageUrl, noteUrl, source, meta, title, author, files } = req.body || {};
    if (!Array.isArray(files) || files.length===0) return res.status(400).json({ ok:false, message:'No files to process.' });

    const BOT = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHANNEL_ID;
    if (!BOT || !CHAT) return res.status(500).json({ ok:false, message:'Server environment variables not configured.' });

    const link = noteUrl || pageUrl || '';
    const captionHtml =
      `<b>${escapeHtml((title||'').trim())}</b>\n\n`+
      `<b>作者:</b> ${escapeHtml((author||'').trim())}\n`+
      (link ? `<b>来源:</b> <a href="${escapeHtml(link)}">点击查看</a>` : '');

    // 分批（sendMediaGroup 限制 ≤10）
    const chunks=[]; for(let i=0;i<files.length;i+=10) chunks.push(files.slice(i,i+10));

    // 需要代理转传的来源（短效/跨区）或前端传来 ttl 很短
    const needProxy = ['instagram','tiktok','douyin'].includes((source||'').toLowerCase()) || (meta?.ttl && meta.ttl < 60);

    for (let c=0;c<chunks.length;c++){
      const chunk = chunks[c];
      if (needProxy) {
        await tgSendMediaGroupProxy({ botToken:BOT, chatId:CHAT, files:chunk, captionHtml: c===0 ? captionHtml : undefined });
      } else {
        await tgSendMediaGroupURL({ botToken:BOT, chatId:CHAT, media:chunk, captionHtml: c===0 ? captionHtml : undefined });
      }
    }

    console.log('Forwarded OK:', (title||'').slice(0,100), 'proxy=',needProxy);
    res.status(200).json({ ok:true, message:'Successfully forwarded to Telegram.' });
  }catch(e){
    const detail = e?.response?.data || e?.message || String(e);
    console.error('Error /api/send:', detail);
    res.status(500).json({ ok:false, message:`Failed to send to Telegram: ${e.message}` });
  }
});

// -------- Start --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Server v2.2 listening on ${PORT}`));
