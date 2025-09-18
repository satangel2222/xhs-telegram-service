// --- Media2TG Backend v2.2 (robust single/group + fallbacks) ---
console.log("Booting Media2TG backend v2.2 ...");

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

// -------- Middlewares ----------
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.originalUrl}`); next(); });

// 宽松 CORS（Tampermonkey 实际不受同源限制，但便于你直接用浏览器调试）
app.use(cors({
  origin: true,
  methods: 'POST,GET,OPTIONS',
  allowedHeaders: 'Content-Type, Authorization',
  optionsSuccessStatus: 200
}));

// -------- Helpers ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHANNEL_ID;
const TG_API    = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

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

function chunk(arr, size) {
  const out = [];
  for (let i=0; i<arr.length; i+=size) out.push(arr.slice(i, i+size));
  return out;
}

function mediaToKind(file) {
  // file: {url,type}  type: 'video' | 'photo'
  return (file && file.type === 'video') ? 'video' : 'photo';
}

function tgErrInfo(e) {
  if (e?.response?.data) return JSON.stringify(e.response.data);
  if (e?.message) return e.message;
  return String(e);
}

// -------- Telegram Senders ----------
async function tgSendSingle(file, captionHTML) {
  const kind = mediaToKind(file);
  const endpoint = kind === 'video' ? 'sendVideo' : 'sendPhoto';
  const payload = {
    chat_id: CHAT_ID,
    caption: captionHTML,
    parse_mode: 'HTML'
  };
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
    // 可能是 Telegram 无法直连该 URL，尝试下载转发（multipart）
    console.warn(`[TG] ${endpoint} by URL failed, fallback to multipart...`, tgErrInfo(e));
    try {
      const buf = await axios.get(file.url, { responseType: 'arraybuffer', timeout: 90000 }).then(r=>r.data);
      const fd = new FormData();
      fd.append('chat_id', CHAT_ID);
      fd.append('caption', captionHTML || '');
      fd.append('parse_mode', 'HTML');

      const field = (kind === 'video') ? 'video' : 'photo';
      // 给个稳定文件名
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

async function tgSendGroup(files, captionHTML) {
  // media group：2-10 个
  const media = files.map((f, idx) => ({
    type: mediaToKind(f) === 'video' ? 'video' : 'photo',
    media: f.url,
    caption: idx === 0 ? captionHTML : undefined,
    parse_mode: idx === 0 ? 'HTML' : undefined
  }));

  try {
    const res = await axios.post(`${TG_API}/sendMediaGroup`, {
      chat_id: CHAT_ID,
      media
    }, { timeout: 90000 });
    return res.data;
  } catch (e) {
    // 有时某些 URL 不可直取，退回为逐个发送
    console.warn('[TG] sendMediaGroup by URL failed, fallback to per-file...', tgErrInfo(e));
    const out = [];
    for (let i=0;i<files.length;i++) {
      const cap = (i === 0) ? captionHTML : undefined;
      out.push(await tgSendSingle(files[i], cap));
    }
    return { ok: true, results: out };
  }
}

// -------- Route ----------
app.options('/api/send', cors());

app.post('/api/send', async (req, res) => {
  const t0 = Date.now();
  try {
    if (!BOT_TOKEN || !CHAT_ID) {
      return res.status(500).json({ ok: false, message: 'Server env TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID missing.' });
    }

    const { noteUrl, pageUrl, title, author, files, source } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, message: 'No files to process.' });
    }

    const captionHTML = buildCaptionHTML({ title, author, noteUrl, pageUrl, source });

    let okResp;
    if (files.length === 1) {
      okResp = await tgSendSingle(files[0], captionHTML);
    } else {
      // 2-10 一组，超过 10 分批
      const groups = chunk(files, 10);
      const results = [];
      for (const g of groups) {
        if (g.length === 1) {
          results.push(await tgSendSingle(g[0], captionHTML));
        } else {
          results.push(await tgSendGroup(g, captionHTML));
        }
      }
      okResp = { ok: true, groups: results };
    }

    const ms = Date.now() - t0;
    console.log(`[OK] forwarded ${files.length} file(s) in ${ms}ms, title="${(title||'').slice(0,40)}"`);
    return res.status(200).json({ ok: true, message: 'Successfully forwarded to Telegram.', data: okResp });
  } catch (e) {
    const ms = Date.now() - t0;
    const info = tgErrInfo(e);
    console.error(`[ERR] /api/send failed in ${ms}ms -> ${info}`);
    return res.status(500).json({ ok: false, message: `Failed to send to Telegram: ${info}` });
  }
});

// -------- Health & Start ----------
app.get('/', (_req, res) => res.status(200).send('Media2TG backend is up.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Media2TG backend listening on :${PORT}`));
