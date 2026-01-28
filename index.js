// index.js
// --- Media2TG Backend v2.10 (改进Reddit支持和错误诊断) ---
console.log("Booting Media2TG backend v2.10 ...");

// Telegram 限制：媒体 caption 最多 1024 字符，文本消息最多 4096 字符
const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const FormData = require("form-data");
const stream = require("stream");
const util = require("util");
const pipeline = util.promisify(stream.pipeline);
const URL = require("url").URL;

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

// MTProto 上传服务地址：必须以 https:// 开头并指向你的 uploader 的 /upload 接口
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
  if (s === "reddit") return "#Reddit";
  return "#Unknown";
}

// 分割长文本为多个消息（每个最多 4096 字符，在换行处分割）
function splitLongText(text, maxLen = TG_TEXT_LIMIT) {
  if (!text || text.length <= maxLen) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    // 在 maxLen 范围内找最后一个换行符
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // 没有合适的换行符，在空格处分割
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // 还是没有，强制在 maxLen 处分割
      splitAt = maxLen;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}

// 发送纯文本消息（支持 HTML）
async function tgSendTextTo(chatId, text, useHTML = true) {
  const payload = {
    chat_id: chatId,
    text: text,
  };
  if (useHTML) payload.parse_mode = "HTML";

  const res = await axios.post(`${TG_API}/sendMessage`, payload, {
    timeout: 30000,
  });
  return res.data;
}

// 发送完整内容（自动分段，支持任意长度）
async function tgSendFullContent(chatId, fullCaption, useHTML = true) {
  const parts = splitLongText(fullCaption, TG_TEXT_LIMIT);
  const results = [];

  for (const part of parts) {
    results.push(await tgSendTextTo(chatId, part, useHTML));
  }

  return results;
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
  // 安全提取错误信息，避免循环引用问题
  const parts = [];

  try {
    // 1. 提取 HTTP 状态码
    if (e?.response?.status) {
      parts.push(`HTTP ${e.response.status}`);
    }

    // 2. 提取 Telegram API 错误
    if (e?.response?.data) {
      const data = e.response.data;
      if (typeof data === 'string') {
        parts.push(data);
      } else if (typeof data === 'object') {
        if (data.description) parts.push(data.description);
        else if (data.error_code) parts.push(`error_code=${data.error_code}`);
        else if (data.message) parts.push(data.message);
      }
    }

    // 3. 提取 axios 错误代码
    if (e?.code) {
      parts.push(`code=${e.code}`);
    }

    // 4. 提取错误消息
    if (e?.message && !parts.includes(e.message)) {
      parts.push(e.message);
    }

    // 5. 如果有 cause，也提取
    if (e?.cause?.message) {
      parts.push(`cause: ${e.cause.message}`);
    }
  } catch (extractErr) {
    // 提取失败，忽略
  }

  if (parts.length > 0) {
    return parts.join(' | ');
  }

  try {
    return String(e) || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

function isHttpUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

// -------- Retry helper ----------
function getRetryAfterMs(e) {
  // 从 Telegram 429 响应中提取 retry_after 秒数
  const data = e?.response?.data;
  const status = e?.response?.status;
  if (status !== 429 && data?.error_code !== 429) return null;
  const secs = data?.parameters?.retry_after || data?.retry_after;
  if (secs && typeof secs === "number") return secs * 1000 + 1000; // 多等 1s 余量
  return 35000; // 默认 35s（Telegram 常见限制 30s + 余量）
}

async function retry(fn, attempts = 3, baseDelay = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryAfter = getRetryAfterMs(e);
      const wait = retryAfter || baseDelay * Math.pow(2, i);
      console.warn(`[RETRY] attempt=${i + 1} failed, will wait ${wait}ms${retryAfter ? " (429 retry_after)" : ""} -> ${tgErrInfo(e)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// -------- 调用 MTProto uploader ----------
async function forwardToMtprotoUploader(chatId, file, caption, useHTML, reason) {
  if (!MTPROTO_UPLOADER) {
    throw new Error("MTProto uploader endpoint not configured");
  }
  if (!isHttpUrl(file.url)) {
    throw new Error("Invalid file.url for mtproto uploader");
  }

  const kind = mediaToKind(file);
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

  return await retry(async () => {
    const resp = await axios.post(MTPROTO_UPLOADER, body, {
      timeout: 300000,
    });
    if (resp.data && resp.data.ok) return resp.data;
    throw new Error(`Uploader returned not ok: ${JSON.stringify(resp.data || {})}`);
  }, 3, 1000).catch((e) => {
    console.error("[MTPROTO] uploader error after retries", tgErrInfo(e));
    throw e;
  });
}

// -------- Streaming download helper (used for multipart fallback) ----------
async function downloadStreamForMultipart(url, timeout = 180000) {
  if (!isHttpUrl(url)) throw new Error("Invalid URL");

  // 根据 URL 确定需要的 headers
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // Reddit 图片需要额外的 headers
  if (url.includes("redd.it") || url.includes("reddit.com")) {
    headers["Referer"] = "https://www.reddit.com/";
    headers["Origin"] = "https://www.reddit.com";
  }

  console.log(`[DOWNLOAD] Starting download: ${url.slice(0, 100)}...`);

  return await retry(async () => {
    const resp = await axios.get(url, {
      responseType: "stream",
      timeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers,
      // 跟随重定向
      maxRedirects: 5,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const err = new Error("Bad status " + resp.status);
      err.response = resp;
      throw err;
    }
    console.log(`[DOWNLOAD] Success: ${url.slice(0, 60)}... content-length=${resp.headers["content-length"] || "unknown"}`);
    return { stream: resp.data, headers: resp.headers };
  }, 3, 1000);
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

  if (!isHttpUrl(file.url)) {
    throw new Error("Invalid file URL");
  }

  // 1) 先尝试走 Bot（URL），带 429 重试
  try {
    const res = await retry(async () => {
      return await axios.post(`${TG_API}/${endpoint}`, payload, {
        timeout: 60000,
      });
    }, 4, 1000);
    return res.data;
  } catch (e) {
    const raw = e?.response?.data || {};
    const code = raw.error_code || (e?.response && e.response.status) || null;
    const desc = raw.description || "";

    const isTooLarge =
      code === 413 || /too (large|big)/i.test(desc || "") || false;

    if (isTooLarge && MTPROTO_UPLOADER) {
      console.warn(
        `[TG] ${endpoint} by URL failed with 413, fallback to MTProto uploader...`
      );
      return await forwardToMtprotoUploader(chatId, file, caption, useHTML, "413");
    }

    // 如果 429 重试全部用尽，不再降级到 multipart（multipart 一样会 429）
    if (code === 429 || raw.error_code === 429) {
      throw new Error(`sendSingle failed: rate limited after retries (URL: ${file.url.slice(0, 80)}...)`);
    }

    const urlErr = tgErrInfo(e);
    console.warn(`[TG] ${endpoint} by URL failed: ${urlErr}`);
    console.log(`[TG] URL was: ${file.url}`);
    console.log(`[TG] Trying multipart upload fallback...`);

    // 2) 尝试 multipart 上传（stream 下载并直接 pipe 到 form-data），带 429 重试
    try {
      const { stream: videoStream, headers } = await downloadStreamForMultipart(file.url, 180000);

      const fd = new FormData();
      fd.append("chat_id", chatId);
      if (caption) {
        fd.append("caption", caption);
        if (useHTML) fd.append("parse_mode", "HTML");
      }
      const field = kind === "video" ? "video" : "photo";
      const filename = kind === "video" ? "video.mp4" : "image.jpg";

      // 如果远端返回 content-length，可以传 knownLength，FormData getLengthSync 有时失败，包里会自动处理
      const contentLength = headers && (headers["content-length"] || headers["Content-Length"]);
      if (contentLength) {
        fd.append(field, videoStream, { filename, knownLength: Number(contentLength) });
      } else {
        fd.append(field, videoStream, { filename });
      }

      const res2 = await axios.post(`${TG_API}/${endpoint}`, fd, {
        headers: {
          ...fd.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 180000,
      });
      return res2.data;
    } catch (e2) {
      const raw2 = e2?.response?.data || {};
      const code2 = raw2.error_code || (e2?.response && e2.response.status) || null;
      const desc2 = raw2.description || "";
      const tooLarge2 =
        code2 === 413 || /too (large|big)/i.test(desc2 || "") || false;

      if (tooLarge2 && MTPROTO_UPLOADER) {
        console.warn(
          `[TG] multipart fallback failed with 413, fallback to MTProto uploader...`,
          tgErrInfo(e2)
        );
        return await forwardToMtprotoUploader(chatId, file, caption, useHTML, "multipart_fail");
      }

      const multipartErr = tgErrInfo(e2);
      console.error(`[TG] Multipart upload also failed: ${multipartErr}`);
      console.error(`[TG] Failed URL: ${file.url}`);
      throw new Error(`sendSingle failed: ${multipartErr || "unknown error"} (URL: ${file.url.slice(0, 80)}...)`);
    }
  }
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
    const res = await retry(async () => {
      return await axios.post(
        `${TG_API}/sendMediaGroup`,
        {
          chat_id: chatId,
          media,
        },
        { timeout: 90000 }
      );
    }, 4, 1000);
    return res.data;
  } catch (e) {
    // 如果是 429 重试全部用尽，不再降级为逐个发送（会加剧速率限制）
    const raw = e?.response?.data || {};
    const code = raw.error_code || (e?.response && e.response.status) || null;
    if (code === 429 || raw.error_code === 429) {
      console.error("[TG] sendMediaGroup rate limited after retries, not falling back to per-file");
      throw e;
    }

    console.warn(
      "[TG] sendMediaGroup by URL failed, fallback to per-file...",
      tgErrInfo(e)
    );
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

    // 基本验证每个 file.url 是 http(s)
    for (const f of files) {
      if (!f || typeof f.url !== "string" || !isHttpUrl(f.url)) {
        return res.status(400).json({ ok: false, message: "Invalid file.url in request." });
      }
    }

    const captionMain = buildCaptionHTML({
      title,
      author,
      noteUrl,
      pageUrl,
      source,
    });

    const groups = chunk(files, 10);

    // 辅助函数：发送媒体到指定频道，支持超长内容
    async function sendMediaWithLongCaption(chatId, mediaGroups, fullCaption) {
      const results = [];
      const isLongCaption = fullCaption && fullCaption.length > TG_CAPTION_LIMIT;

      // 如果内容超长，媒体不带caption，稍后单独发送文本
      const mediaCaption = isLongCaption ? null : fullCaption;

      for (let gi = 0; gi < mediaGroups.length; gi++) {
        // 多组之间间隔 2s，主动避免触发 Telegram 速率限制
        if (gi > 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        const g = mediaGroups[gi];
        const cap = gi === 0 ? mediaCaption : undefined;

        if (g.length === 1) {
          results.push(await tgSendSingleTo(chatId, g[0], cap, true));
        } else {
          results.push(await tgSendGroupTo(chatId, g, cap, true));
        }
      }

      // 如果内容超长，单独发送完整文本消息（自动分段）
      if (isLongCaption) {
        console.log(`[LONG] caption ${fullCaption.length} chars > ${TG_CAPTION_LIMIT}, sending as separate text`);
        const textResults = await tgSendFullContent(chatId, fullCaption, true);
        results.push({ type: 'text_messages', count: textResults.length, results: textResults });
      }

      return results;
    }

    // 1) 主频道：发送完整内容
    const mainResults = await sendMediaWithLongCaption(CHAT_ID_MAIN, groups, captionMain);

    // 频道间间隔 3s，避免 Telegram 速率限制
    await new Promise((r) => setTimeout(r, 3000));

    // 2) 路由频道：根据来源决定内容
    const routedChat = routeChatBySource(source);
    const tagCaption = tagBySource(source);
    const srcLower = (source || "").toLowerCase();

    // XHS 路由频道 (@xhsgallery)：发送完整内容 + tag
    // 其他平台路由频道 (@mybigbreastgal)：只发送 tag，不公开其他内容
    const captionRouted = srcLower === "xhs"
      ? captionMain + `\n\n${tagCaption}`  // XHS: 完整内容 + tag
      : tagCaption;                         // 其他: 仅 tag

    const routedResults = await sendMediaWithLongCaption(routedChat, groups, captionRouted);

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
    return res
      .status(500)
      .json({ ok: false, message: `Failed to send to Telegram: ${info}` });
  }
});

// 健康检查
app.get("/", (_req, res) => res.status(200).send("Media2TG backend is up."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Media2TG backend listening on :${PORT}`)
);
