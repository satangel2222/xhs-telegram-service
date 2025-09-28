// --- Media2TG Backend v2.3 (main + routed channels, tag-only caption) ---
console.log("Booting Media2TG backend v2.3 ...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

// -------- Middlewares ----------
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });

// 宽松 CORS（方便浏览器直测；Tampermonkey不依赖同源）
app.use(cors({
  origin: true,
  methods: 'POST,GET,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  optionsSuccessStatus: 200
}));

// -------- Env ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;         // 你之前就有
const CHAT_ID_MAIN = process.env.TELEGRAM_CHANNEL_ID;     // 主频道：@Xxhs1234（沿用旧名）

// 新增两个（请到 Render > Environment 里新增）
const ROUTE_CHAT_XHS    = process.env.ROUTE_CHAT_XHS || '@xhsgallery';
const ROUTE_CHAT_OTHERS = process.env.ROUTE_CHAT_OTHERS || '@mybigbreastgal';

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// -------- Utils ----------
function escHtml(s='') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function buildCaptionHTML({ title, author, noteUrl, pageUrl, source }) {
  const t = escHtml((title || '').trim() || '媒体');
  const a = escHtml((author || '').trim() || (source || 'unknown'));
  const link = escHtml(noteUrl || pageUrl || '');
  let cap = `<b>${t}</b>`;
  cap += `\n\n<b>作者：</b>${a}`;
  if (link) cap += `\n<b>来源：</b><a href="${link}">点击查看</a>`;
  return cap;
}

function tagBySource(source='') {
  const s = (source || '').toLowerCase();
  if (s === 'xhs') return '#小红书';
  if (s === 'instagram') return '#Instagram';
  if (s === 'x') return '#Twitter';
  if (s === 'redgifs') return '#Redgifs';
  if (s === 'tiktok') return '#TikTok';
  if (s === 'douyin') return '#抖音';
  return '#Unknown';
}

function routeChatBySource(source='') {
  const s = (source || '').toLowerCase();
  if (s === 'xhs') return ROUTE_CHAT_XHS;
  return ROUTE_CHAT_OTHERS;
}

function chunk(arr, size) {
  const out = [];
  for (let i=0; i<arr.length; i+=size) out.push(arr.slice(i, i+size));
  return out;
}

function mediaToKind(file) {
  return (file && file.type === 'video') ? 'video' : 'photo';
}

function tgErrInfo(e) {
  if (e?.response?.data) return JSON.stringify(e.response.data);
  if (e?.message) return e.message;
  return String(e);
}

// -------- Telegram Senders (支持指定 chat_id) ----------
async function tgSendSingleTo(chatId, file, caption, useHTML) {
  const kind = mediaToKind(file);
  const endpoint = kind === 'video' ? 'sendVideo' : 'sendPhoto';
  const payload = {
    chat_id: chatId
  };
  if (caption) {
    payload.caption = caption;
    if (useHTML) payload.parse_mode = 'HTML';
  }
  if (kind === 'video') {
    payload.video = file.url;
    payload.supports_streaming = true;
  } else {
    payload.photo = file.url;
  }

  try {
    const res = await axios.post(`${TG_API}/${endpoint}`, payload, { timeout: 60000 });
    return res.data;
  } catch (e) {
    // 回退：URL直链不可取时，改为multipart转发
    console.warn(`[TG] ${endpoint} by URL failed, fallback to multipart...`, tgErrInfo(e));
    try {
      const buf = await axios.get(file.url, { responseType: 'arraybuffer', timeout: 90000 }).then(r=>r.data);
      const fd = new FormData();
      fd.append('chat_id', chatId);
      if (caption) {
        fd.append('caption', caption);
        if (useHTML) fd.append('parse_mode', 'HTML');
      }
      const field = (kind === 'video') ? 'video' : 'photo';
      const filename = (kind === 'video') ? 'video.mp4' : 'image.jpg';
      fd.append(field, buf, { filename });

      const res2 = await axios.post(`${TG_API}/${endpoint}`, fd, {
        headers: fd.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000
      });
      return res2.data;
    } catch (e2) {
      throw new Error(`sendSingle fallback failed: ${tgErrInfo(e2)}`);
    }
  }
}

async function tgSendGroupTo(chatId, files, caption, useHTML) {
  // 仅第一个元素带 caption/parse_mode
  const media = files.map((f, idx) => ({
    type: mediaToKind(f) === 'video' ? 'video' : 'photo',
    media: f.url,
    caption: (idx === 0 && caption) ? caption : undefined,
    parse_mode: (idx === 0 && caption && useHTML) ? 'HTML' : undefined
  }));

  try {
    const res = await axios.post(`${TG_API}/sendMediaGroup`, {
      chat_id: chatId,
      media
    }, { timeout: 90000 });
    return res.data;
  } catch (e) {
    console.warn('[TG] sendMediaGroup by URL failed, fallback to per-file...', tgErrInfo(e));
    const out = [];
    for (let i=0;i<files.length;i++) {
      const cap = (i === 0) ? caption : undefined;
      out.push(await tgSendSingleTo(chatId, files[i], cap, useHTML));
    }
    return { ok: true, results: out };
  }
}

// -------- Routes ----------
app.options('/api/send', cors());

app.post('/api/send', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!BOT_TOKEN || !CHAT_ID_MAIN) {
      return res.status(500).json({ ok: false, message: 'Server env TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID missing.' });
    }

    const { noteUrl, pageUrl, title, author, files, source } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, message: 'No files to process.' });
    }

    // 1) 主频道（保留原 caption 逻辑，HTML）
    const captionMain = buildCaptionHTML({ title, author, noteUrl, pageUrl, source });

    let mainResp;
    const groups = chunk(files, 10);
    const mainResults = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.length === 1) {
        mainResults.push(await tgSendSingleTo(CHAT_ID_MAIN, g[0], gi === 0 ? captionMain : undefined, true));
      } else {
        mainResults.push(await tgSendGroupTo(CHAT_ID_MAIN, g, gi === 0 ? captionMain : undefined, true));
      }
    }
    mainResp = { ok: true, groups: mainResults };

    // 2) 分类频道（仅平台标签 caption；不使用 HTML）
    const routedChat = routeChatBySource(source);
    const tagCaption = tagBySource(source);

    const routedResults = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      // 只有第一批第一项带标签，其余批次不带
      if (g.length === 1) {
        routedResults.push(await tgSendSingleTo(routedChat, g[0], gi === 0 ? tagCaption : undefined, false));
      } else {
        routedResults.push(await tgSendGroupTo(routedChat, g, gi === 0 ? tagCaption : undefined, false));
      }
    }

    const ms = Date.now() - t0;
    console.log(`[OK] forwarded ${files.length} file(s) in ${ms}ms, title="${(title||'').slice(0,40)}"`);
    return res.status(200).json({
      ok: true,
      message: 'Successfully forwarded to main & routed channels.',
      data: { main: mainResp, routed: routedResults }
    });
  } catch (e) {
    const ms = Date.now() - t0;
    const info = tgErrInfo(e);
    console.error(`[ERR] /api/send failed in ${ms}ms -> ${info}`);
    return res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${info}` });
  }
});

// 健康检查
app.get('/', (_req, res) => res.status(200).send('Media2TG backend is up.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Media2TG backend listening on :${PORT}`));
