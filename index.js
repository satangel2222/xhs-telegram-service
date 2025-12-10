// --- Media2TG Backend v2.5 (主频道 + 路由频道 + MTProto 超大文件上传) ---
console.log("Booting Media2TG backend v2.5 ...");

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const FormData = require("form-data");

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
  return String(e);
}

// -------- 调用 MTProto uploader ----------
async function forwardToMtprotoUploader(chatId, file, caption, useHTML, reason) {
  if (!MTPROTO_UPLOADER) {
    throw new Error("MTProto uploader endpoint not configured");
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
  try {
    const resp = await axios.post(MTPROTO_UPLOADER, body, {
      timeout: 300000,
    });
    if (resp.data && resp.data.ok) return resp.data;
    throw new Error(
      `Uploader returned not ok: ${JSON.stringify(resp.data || {})}`
    );
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
    });
    return res.data;
  } catch (e) {
    const raw = e?.response?.data || {};
    const code = raw.error_code || e?.response?.status;
    const desc = raw.description || "";

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

    // 2) 尝试 multipart 上传（小文件更稳）
    try {
      const buf = await axios
        .get(file.url, { responseType: "arraybuffer", timeout: 90000 })
        .then((r) => r.data);

      const fd = new FormData();
      fd.append("chat_id", chatId);
      if (caption) {
        fd.append("caption", caption);
        if (useHTML) fd.append("parse_mode", "HTML");
      }
      const field = kind === "video" ? "video" : "photo";
      const filename = kind === "video" ? "video.mp4" : "image.jpg";
      fd.append(field, buf, { filename });

      const res2 = await axios.post(`${TG_API}/${endpoint}`, fd, {
        headers: fd.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000,
      });
      return res2.data;
    } catch (e2) {
      const raw2 = e2?.response?.data || {};
      const code2 = raw2.error_code || e2?.response?.status;
      const desc2 = raw2.description || "";
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
          "multipart_fail"
        );
      }

      throw new Error(`sendSingle failed: ${tgErrInfo(e2)}`);
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
    const res = await axios.post(
      `${TG_API}/sendMediaGroup`,
      {
        chat_id: chatId,
        media,
      },
      { timeout: 90000 }
    );
    return res.data;
  } catch (e) {
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
