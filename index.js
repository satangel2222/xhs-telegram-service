// --- Media2TG Backend v2.5 (主频道 + 路由频道 + MTProto 超大文件上传) --- 
console.log("Booting Media2TG backend v2.5 (hardened) ...");

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const FormData = require("form-data");
const stream = require("stream");
const util = require("util");
const pipeline = util.promisify(stream.pipeline);

const app = express();

// -------- Middlewares ----------
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// 宽松 CORS
app.use(
  cors({
    origin: true,
    methods: "POST,GET,OPTIONS",
    allowedHeaders: "Content-Type, Authorization",
    optionsSuccessStatus: 200,
  })
);

// -------- Env ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID_MAIN = process.env.TELEGRAM_CHANNEL_ID;

const ROUTE_CHAT_XHS = process.env.ROUTE_CHAT_XHS || "@xhsgallery";
const ROUTE_CHAT_OTHERS = process.env.ROUTE_CHAT_OTHERS || "@mybigbreastgal";

// 新增：MTProto 上传服务地址
const MTPROTO_UPLOADER = process.env.MTPROTO_UPLOADER || "";

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// -------- Utils ----------
function escHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCaptionHTML({ title, author, noteUrl, pageUrl, source }) {
  const t = escHtml((title || "").trim() || "媒体");
  const a = escHtml((author || "").trim() || (source || "unknown"));
  const link = escHtml(noteUrl || pageUrl || "");
  let cap = `<b>${t}</b>`;
  cap += `\n\n<b>作者：</b>${a}`;
  if (link) cap += `\n<b>来源：</b><a href="${link}">点击查看</a>`;
  return cap;
}

function tagBySource(source = "") {
  const s = (source || "").toLowerCase();
  if (s === "xhs") return "#小红书";
  if (s === "instagram") return "#Instagram";
  if (s === "x") return "#Twitter";
  if (s === "redgifs") return "#Redgifs";
  if (s === "tiktok") return "#TikTok";
  if (s === "douyin") return "#抖音";
  return "#Unknown";
}

function routeChatBySource(source = "") {
  const s = (source || "").toLowerCase();
  if (s === "xhs") return ROUTE_CHAT_XHS;
  return ROUTE_CHAT_OTHERS;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mediaToKind(file) {
  return file && file.type === "video" ? "video" : "photo";
}

function tgErrInfo(e) {
  if (e?.response?.data) return JSON.stringify(e.response.data);
  if (e?.message) return e.message;
  if (e?.code) return String(e.code);
  return String(e);
}

// -------- New helpers: URL validation + axios retry ----------
function isHttpUrl(u) {
  try {
    if (!u) return false;
    const s = String(u).trim();
    if (!s) return false;
    if (s.startsWith("blob:") || s.startsWith("data:")) return false;
    return /^https?:\/\//i.test(s);
  } catch {
    return false;
  }
}

async function axiosGetWithRetry(url, opts = {}, retries = 2, backoffMs = 800) {
  const headers = Object.assign(
    { "User-Agent": "Mozilla/5.0 (compatible; Media2TG/1.0)" },
    opts.headers || {}
  );
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await axios.get(url, Object.assign({}, opts, { headers, validateStatus: null }));
      // treat 2xx as success
      if (r.status >= 200 && r.status < 300) return r;
      // for some status codes we may want to retry
      const retryable = [429, 502, 503, 504].includes(r.status);
      if (!retryable) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        err.response = r;
        throw err;
      }
      // else fallthrough to retry
      console.warn(`[HTTP] non-2xx status ${r.status} for ${url} (attempt ${attempt})`);
      if (attempt === retries) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      const isLast = attempt === retries;
      console.warn(`[HTTP] axiosGetWithRetry attempt=${attempt} url=${url} err=${e?.code||e?.message||String(e)}${isLast ? " final" : ""}`);
      if (isLast) throw e;
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw new Error("axiosGetWithRetry failed");
}

async function postWithRetry(url, body, tries = 2, axiosOpts = {}) {
  for (let i = 0; i <= tries; i++) {
    try {
      return await axios.post(url, body, axiosOpts);
    } catch (e) {
      const isLast = i === tries;
      console.warn(`[HTTP] postWithRetry attempt=${i} url=${url} err=${e?.code||e?.message||String(e)}${isLast ? " final" : ""}`);
      if (isLast) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// -------- 调用 MTProto uploader ----------
async function forwardToMtprotoUploader(chatId, file, caption, useHTML, reason) {
  if (!MTPROTO_UPLOADER) {
    throw new Error("MTProto uploader endpoint not configured");
  }
  const kind = mediaToKind(file);

  // validate url early
  if (!isHttpUrl(file.url)) {
    throw new Error(`Invalid file URL protocol: ${file.url}`);
  }

  const body = {
    chat_id: chatId,
    file_url: file.url,
    caption: caption || null,
    parse_mode: useHTML ? "HTML" : null,
    kind,
  };
  console.log(
    `[MTPROTO] forward to uploader, reason=${reason}, chat=${chatId}, kind=${kind}, url=${file.url}`
  );
  try {
    // use retry wrapper
    const resp = await postWithRetry(MTPROTO_UPLOADER, body, 2, {
      timeout: 300000,
      headers: { "Content-Type": "application/json" },
    });
    if (resp.data && resp.data.ok) return resp.data;
    throw new Error(`Uploader returned not ok: ${JSON.stringify(resp.data || {})}`);
  } catch (e) {
    console.error("[MTPROTO] uploader error", tgErrInfo(e));
    throw e;
  }
}

// -------- Telegram Senders (支持指定 chat_id) ----------
async function tgSendSingleTo(chatId, file, caption, useHTML) {
  const kind = mediaToKind(file);
  const endpoint = kind === "video" ? "sendVideo" : "sendPhoto";
  const payload = { chat_id: chatId };

  if (caption) {
    payload.caption = caption;
    if (useHTML) payload.parse_mode = "HTML";
  }
  if (kind === "video") {
    payload.video = file.url;
    payload.supports_streaming = true;
  } else {
    payload.photo = file.url;
  }

  // 1) 先尝试走 Bot（URL），失败再看要不要走 MTProto
  try {
    const res = await axios.post(`${TG_API}/${endpoint}`, payload, {
      timeout: 60000,
      validateStatus: null,
    });
    if (res.status >= 200 && res.status < 300) return res.data;
    // treat certain codes as errors to fallback
    const raw = res.data || {};
    const code = raw.error_code || res.status;
    const desc = raw.description || "";
    // If 413 or "too large" from telegram, we'll fallback
    const isTooLarge =
      code === 413 || /too (large|big)/i.test(desc || "") || false;
    if (!isTooLarge) {
      // Non-retryable (like 400/401/403) -> throw with reason
      throw { response: { status: res.status, data: res.data }, message: `TG API returned ${res.status}` };
    }
  } catch (e) {
    // If axios threw because of network or invalid protocol, handle below
    const raw = e?.response?.data || {};
    const code = raw?.error_code || e?.response?.status;
    const desc = raw?.description || e?.message || "";
    const isTooLarge =
      code === 413 || /too (large|big)/i.test(desc || "") || false;

    if (isTooLarge && MTPROTO_UPLOADER) {
      console.warn(
        `[TG] ${endpoint} by URL failed with 413, fallback to MTProto uploader...`
      );
      return await forwardToMtprotoUploader(
        chatId,
        file,
        caption,
        useHTML,
        "413"
      );
    }

    console.warn(
      `[TG] ${endpoint} by URL failed, try multipart...`,
      tgErrInfo(e)
    );

    // 2) 尝试 multipart 上传（小文件更稳） —— 这里做严格 url 校验与重试下载
    try {
      if (!isHttpUrl(file.url)) {
        // 如果不是 http(s) 直接拒绝，避免传入 blob:
        throw new Error(`Unsupported protocol or invalid url: ${file.url}`);
      }

      // 下载二进制数据，带重试
      const resp = await axiosGetWithRetry(file.url, { responseType: "arraybuffer", timeout: 180000 }, 3, 800);
      const buf = resp.data;

      const fd = new FormData();
      fd.append("chat_id", chatId);
      if (caption) {
        fd.append("caption", caption);
        if (useHTML) fd.append("parse_mode", "HTML");
      }
      const field = kind === "video" ? "video" : "photo";
      const filename = kind === "video" ? "video.mp4" : "image.jpg";
      // Buffer is acceptable to form-data in Node
      fd.append(field, Buffer.from(buf), { filename });

      const headers = fd.getHeaders();
      const res2 = await axios.post(`${TG_API}/${endpoint}`, fd, {
        headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 180000,
        validateStatus: null,
      });

      if (res2.status >= 200 && res2.status < 300) return res2.data;

      // If multipart also returns 413 and mtproto exists -> forward
      const raw2 = res2.data || {};
      const code2 = raw2.error_code || res2.status;
      const desc2 = raw2.description || "";
      const tooLarge2 = code2 === 413 || /too (large|big)/i.test(desc2 || "") || false;

      if (tooLarge2 && MTPROTO_UPLOADER) {
        console.warn(
          `[TG] multipart fallback failed with 413, fallback to MTProto uploader...`,
          tgErrInfo(res2)
        );
        return await forwardToMtprotoUploader(
          chatId,
          file,
          caption,
          useHTML,
          "multipart_fail"
        );
      }

      throw new Error(`sendSingle multipart failed: ${JSON.stringify(res2.data||res2.status)}`);
    } catch (e2) {
      const raw2 = e2?.response?.data || {};
      const code2 = raw2?.error_code || e2?.response?.status;
      const desc2 = raw2?.description || e2?.message || "";
      const tooLarge2 =
        code2 === 413 || /too (large|big)/i.test(desc2 || "") || false;

      if (tooLarge2 && MTPROTO_UPLOADER) {
        console.warn(
          `[TG] multipart fallback failed with 413, fallback to MTProto uploader...`,
          tgErrInfo(e2)
        );
        return await forwardToMtprotoUploader(
          chatId,
          file,
          caption,
          useHTML,
          "multipart_fail2"
        );
      }

      throw new Error(`sendSingle failed: ${tgErrInfo(e2)}`);
    }
  }

  // if initial try succeeded we already returned earlier
  // but to satisfy control flow, return a generic error
  throw new Error("tgSendSingleTo unexpected end");
}

async function tgSendGroupTo(chatId, files, caption, useHTML) {
  // 仅第一项带 caption
  const media = files.map((f, idx) => ({
    type: mediaToKind(f) === "video" ? "video" : "photo",
    media: f.url,
    caption: idx === 0 && caption ? caption : undefined,
    parse_mode: idx === 0 && caption && useHTML ? "HTML" : undefined,
  }));

  try {
    const res = await axios.post(
      `${TG_API}/sendMediaGroup`,
      {
        chat_id: chatId,
        media,
      },
      { timeout: 90000, validateStatus: null }
    );
    if (res.status >= 200 && res.status < 300) return res.data;
    console.warn("[TG] sendMediaGroup by URL failed, fallback to per-file...", res.status);
    // fallback: per-file
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const cap = i === 0 ? caption : undefined;
      out.push(await tgSendSingleTo(chatId, files[i], cap, useHTML));
    }
    return { ok: true, results: out };
  } catch (e) {
    console.warn("[TG] sendMediaGroup failed, fallback to per-file...", tgErrInfo(e));
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const cap = i === 0 ? caption : undefined;
      out.push(await tgSendSingleTo(chatId, files[i], cap, useHTML));
    }
    return { ok: true, results: out };
  }
}

// -------- Routes ----------
app.options("/api/send", cors());

app.post("/api/send", async (req, res) => {
  const t0 = Date.now();
  try {
    if (!BOT_TOKEN || !CHAT_ID_MAIN) {
      return res.status(500).json({
        ok: false,
        message:
          "Server env TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID missing.",
      });
    }

    const { noteUrl, pageUrl, title, author, files, source } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, message: "No files to process." });
    }

    // defensive: filter out invalid URLs early and mark which ones invalid
    const invalid = files.filter(f => !isHttpUrl(f.url));
    if (invalid.length > 0) {
      return res.status(400).json({
        ok: false,
        message: "Some file URLs are invalid or unsupported protocol (blob/data).",
        invalid: invalid.map(f => f.url),
      });
    }

    const captionMain = buildCaptionHTML({
      title,
      author,
      noteUrl,
      pageUrl,
      source,
    });

    const groups = chunk(files, 10);

    // 1) 主频道
    const mainResults = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.length === 1) {
        mainResults.push(
          await tgSendSingleTo(
            CHAT_ID_MAIN,
            g[0],
            gi === 0 ? captionMain : undefined,
            true
          )
        );
      } else {
        mainResults.push(
          await tgSendGroupTo(
            CHAT_ID_MAIN,
            g,
            gi === 0 ? captionMain : undefined,
            true
          )
        );
      }
    }

    // 2) 路由频道（只带平台 tag）
    const routedChat = routeChatBySource(source);
    const tagCaption = tagBySource(source);

    const routedResults = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.length === 1) {
        routedResults.push(
          await tgSendSingleTo(
            routedChat,
            g[0],
            gi === 0 ? tagCaption : undefined,
            false
          )
        );
      } else {
        routedResults.push(
          await tgSendGroupTo(
            routedChat,
            g,
            gi === 0 ? tagCaption : undefined,
            false
          )
        );
      }
    }

    const ms = Date.now() - t0;
    console.log(
      `[OK] forwarded ${files.length} file(s) in ${ms}ms, title="${(title || "").slice(
        0,
        40
      )}"`
    );
    return res.status(200).json({
      ok: true,
      message: "Successfully forwarded to main & routed channels.",
      data: { main: mainResults, routed: routedResults },
    });
  } catch (e) {
    const ms = Date.now() - t0;
    const info = tgErrInfo(e);
    console.error(`[ERR] /api/send failed in ${ms}ms -> ${info}`);
    // make error messages clearer for client debugging
    const status = e?.response?.status || 500;
    const detail = e?.response?.data || e?.message || String(e);
    return res
      .status(500)
      .json({ ok: false, message: `Failed to send to Telegram: ${detail}` });
  }
});

// 健康检查
app.get("/", (_req, res) => res.status(200).send("Media2TG backend is up."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Media2TG backend listening on :${PORT}`)
);
