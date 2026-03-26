import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import PDFDocument from "pdfkit";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

/** PDF 한글 출력용 (Helvetica 등 기본 폰트는 한글 미지원 → 깨짐) */
const KR_SANS_FONT = join(__dirname, "..", "fonts", "NotoSansKR-Regular.otf");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN
      ? process.env.CLIENT_ORIGIN.split(",").map((s) => s.trim())
      : true,
  })
);

app.use(express.json({ limit: "2mb" }));

// Render/브라우저에서 '/'로 접근했을 때도 상태를 확인할 수 있게 합니다.
app.get("/", (_req, res) => {
  res.status(200).send("book-list-maker server is running. /api/health 를 확인하세요.");
});

const geminiApiKey = process.env.GEMINI_API_KEY?.trim() || null;
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";
const GEMINI_MAX_OUTPUT_TOKENS = Math.min(
  8192,
  Math.max(
    1024,
    Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? "8192", 10) || 8192
  )
);

const DEFAULT_START_PAGE = 1;
const DEFAULT_END_PAGE = 8;
const ABS_MAX_SPAN = 40;

function magicScanPageCount() {
  return Math.min(
    50,
    Math.max(
      5,
      Number.parseInt(process.env.MAGIC_SCAN_PAGES ?? "25", 10) || 25
    )
  );
}

const DETECT_TOC_PROMPT = `You are given consecutive images of PDF pages from page 1 upward (each image is labeled by its 1-based page number in the user message).
Identify which of these pages are PRIMARILY a table of contents (목차): lines of titles with page numbers, "Contents", chapter listings, dot leaders, etc.
Respond with ONLY valid JSON (no markdown fence): {"tocPages":[number,...]}
- tocPages: 1-based page numbers that are TOC pages, in ascending order. Empty array if none.
- At most 12 page numbers. Only include pages you are shown (do not guess pages beyond the scan).`;

function parsePagesJsonField(raw) {
  if (raw == null || raw === "") return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  let arr;
  try {
    arr = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr;
}

function parsePageNum(v, fallback) {
  const x = Number.parseInt(String(v ?? ""), 10);
  if (Number.isNaN(x) || x < 1) return fallback;
  return x;
}

/** PNG → 긴 변 기준 축소 + JPEG (비전 입력 토큰·용량 절감) */
async function prepareImageForGemini(pngBuffer) {
  const shrink =
    String(process.env.GEMINI_SHRINK_IMAGES ?? "true").toLowerCase() !==
    "false";
  if (!shrink) {
    return {
      mimeType: "image/png",
      base64: pngBuffer.toString("base64"),
    };
  }
  const maxSide = Math.min(
    2048,
    Math.max(
      400,
      Number.parseInt(process.env.GEMINI_IMAGE_MAX_SIDE ?? "1000", 10) || 1000
    )
  );
  const quality = Math.min(
    92,
    Math.max(
      55,
      Number.parseInt(process.env.GEMINI_JPEG_QUALITY ?? "72", 10) || 72
    )
  );
  try {
    const jpegBuf = await sharp(pngBuffer)
      .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    return {
      mimeType: "image/jpeg",
      base64: jpegBuf.toString("base64"),
    };
  } catch (e) {
    console.warn("[이미지 축소 실패, 원본 PNG 전송]", e);
    return {
      mimeType: "image/png",
      base64: pngBuffer.toString("base64"),
    };
  }
}

/**
 * @param {string} pdfPath
 * @param {unknown[]} rawPageNumbers
 * @returns {Promise<{ pages: { base64: string; pageIndex: number; mimeType: string }[]; pdfTotalPages: number; pageNumbers: number[] }>}
 */
async function pdfPagesListToPngBase64(pdfPath, rawPageNumbers) {
  const scale = Math.min(
    2,
    Math.max(
      0.5,
      Number.parseFloat(process.env.PDF_IMAGE_SCALE ?? "0.85") || 0.85
    )
  );
  const doc = await pdf(pdfPath, { scale });
  const total = doc.length;

  const seen = new Set();
  const nums = [];
  for (const raw of rawPageNumbers) {
    const x = Number.parseInt(String(raw), 10);
    if (Number.isNaN(x) || x < 1 || x > total) continue;
    if (!seen.has(x)) {
      seen.add(x);
      nums.push(x);
    }
  }
  nums.sort((a, b) => a - b);

  if (nums.length === 0) {
    const err = new Error("유효한 페이지 번호가 없습니다.");
    err.code = "NO_PAGES";
    throw err;
  }

  if (nums.length > ABS_MAX_SPAN) {
    const err = new Error(
      `한 번에 최대 ${ABS_MAX_SPAN}페이지까지 분석할 수 있습니다. (선택: ${nums.length}페이지)`
    );
    err.code = "PAGE_SPAN_TOO_LARGE";
    throw err;
  }

  const out = [];
  for (const p of nums) {
    const image = await doc.getPage(p);
    const buf = Buffer.isBuffer(image) ? image : Buffer.from(image);
    const prepared = await prepareImageForGemini(buf);
    out.push({
      pageIndex: p,
      base64: prepared.base64,
      mimeType: prepared.mimeType,
    });
  }

  return {
    pages: out,
    pdfTotalPages: total,
    pageNumbers: nums,
  };
}

/**
 * @param {string} pdfPath
 * @param {number} startPage 1-based inclusive
 * @param {number} endPage 1-based inclusive
 * @returns {Promise<{ pages: { base64: string; pageIndex: number; mimeType: string }[]; pdfTotalPages: number; range: { start: number; end: number }; pageNumbers: number[] }>}
 */
async function pdfPageRangeToPngBase64(pdfPath, startPage, endPage) {
  const scale = Math.min(
    2,
    Math.max(
      0.5,
      Number.parseFloat(process.env.PDF_IMAGE_SCALE ?? "0.85") || 0.85
    )
  );
  const doc = await pdf(pdfPath, { scale });
  const total = doc.length;

  let start = parsePageNum(startPage, DEFAULT_START_PAGE);
  let end = parsePageNum(endPage, DEFAULT_END_PAGE);
  if (start > end) {
    const t = start;
    start = end;
    end = t;
  }

  start = Math.min(Math.max(1, start), total);
  end = Math.min(Math.max(1, end), total);
  if (start > end) {
    [start, end] = [end, start];
  }

  const span = end - start + 1;
  if (span > ABS_MAX_SPAN) {
    const err = new Error(
      `한 번에 최대 ${ABS_MAX_SPAN}페이지까지 분석할 수 있습니다. (선택 구간: ${span}페이지, ${start}–${end})`
    );
    err.code = "PAGE_SPAN_TOO_LARGE";
    throw err;
  }

  const nums = [];
  for (let p = start; p <= end; p++) nums.push(p);

  const out = [];
  for (const p of nums) {
    const image = await doc.getPage(p);
    const buf = Buffer.isBuffer(image) ? image : Buffer.from(image);
    const prepared = await prepareImageForGemini(buf);
    out.push({
      pageIndex: p,
      base64: prepared.base64,
      mimeType: prepared.mimeType,
    });
  }

  return {
    pages: out,
    pdfTotalPages: total,
    range: { start, end },
    pageNumbers: nums,
  };
}

const SYSTEM_PROMPT = `You are helping extract a table of contents from images of PDF pages.
The PDF may not have a formal TOC; infer chapter/section titles from headings and structure visible on these pages.
Respond with ONLY valid JSON (no markdown fence, no trailing commentary), shape:
{"entries":[{"level":1,"title":"string","approxPage":number|null}]}
- level: 1 = top-level chapter, 2 = section, 3 = subsection
- approxPage: PDF page number as printed on the page if visible, else null
- Order entries as they appear. If unsure, omit doubtful lines.
- IMPORTANT: At most 50 entries total. Each title under 100 characters. Skip fine-grained bullet lists.
- You MUST end with a complete JSON object: closing brackets ]} must be present.`;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasGemini: Boolean(genAI),
    model: GEMINI_MODEL,
  });
});

app.post("/api/toc-pdf", async (req, res) => {
  /** @type {{ entries?: unknown; title?: unknown }} */
  const body = req.body ?? {};
  const entriesRaw = body.entries;
  if (!Array.isArray(entriesRaw)) {
    return res.status(400).json({ error: "entries 배열이 필요합니다." });
  }

  if (!existsSync(KR_SANS_FONT)) {
    return res.status(500).json({
      error:
        "PDF 한글 폰트가 서버에 없습니다. 배포에 server/fonts/NotoSansKR-Regular.otf 가 포함되는지 확인하세요.",
    });
  }

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 120)
      : "목차";

  const cleaned = entriesRaw
    .map((e) => {
      const level = Number.parseInt(String(e?.level ?? ""), 10);
      const title = String(e?.title ?? "").trim();
      const approxPageRaw = e?.approxPage;
      const approxPage =
        approxPageRaw == null || approxPageRaw === ""
          ? null
          : Number.parseInt(String(approxPageRaw), 10);
      if (!title) return null;
      return {
        level: Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 1,
        title: title.slice(0, 200),
        approxPage:
          approxPage == null || Number.isNaN(approxPage) || approxPage < 1
            ? null
            : approxPage,
      };
    })
    .filter(Boolean);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    info: { Title: title },
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("error", (err) => {
    console.error(err);
  });

  doc.fontSize(18).font(KR_SANS_FONT).text(title, { align: "left" });
  doc.moveDown(0.6);
  doc
    .fontSize(10)
    .font(KR_SANS_FONT)
    .fillColor("#444")
    .text(`생성 시각: ${new Date().toISOString()}`);
  doc.moveDown(1.0);

  doc.fillColor("#111");

  const usableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rightX = doc.page.margins.left + usableWidth;

  for (const row of cleaned) {
    const indent = (row.level - 1) * 16;
    const leftX = doc.page.margins.left + indent;
    const pageStr = row.approxPage != null ? String(row.approxPage) : "";

    // Title (굵은 전용 OTF 없음 → 레벨 1은 글자 크기로만 구분)
    doc.fontSize(row.level === 1 ? 12.5 : 11);
    doc.font(KR_SANS_FONT);

    const yBefore = doc.y;
    doc.text(row.title, leftX, yBefore, {
      width: usableWidth - indent - (pageStr ? 28 : 0),
      continued: false,
    });

    // Page number on same first line (best-effort)
    if (pageStr) {
      const y = yBefore;
      doc.fontSize(10).font(KR_SANS_FONT).fillColor("#555");
      doc.text(pageStr, rightX - 6, y, { align: "right", width: 28 });
      doc.fillColor("#111");
    }

    doc.moveDown(0.25);
  }

  doc.end();

  const pdfBuffer = await new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="toc.pdf"');
  res.status(200).send(pdfBuffer);
});

app.post("/api/detect-toc-pages", upload.single("file"), async (req, res) => {
  if (!genAI) {
    return res.status(500).json({
      error: "GEMINI_API_KEY가 설정되지 않았습니다. server/.env를 확인하세요.",
    });
  }

  if (!req.file?.buffer) {
    return res.status(400).json({ error: "PDF 파일(file)이 필요합니다." });
  }

  if (req.file.mimetype !== "application/pdf") {
    return res
      .status(400)
      .json({ error: "application/pdf만 업로드할 수 있습니다." });
  }

  const tempPath = join(tmpdir(), `toc-detect-${randomUUID()}.pdf`);

  try {
    await writeFile(tempPath, req.file.buffer);

    const scale = Math.min(
      2,
      Math.max(
        0.5,
        Number.parseFloat(process.env.PDF_IMAGE_SCALE ?? "0.85") || 0.85
      )
    );
    const doc = await pdf(tempPath, { scale });
    const total = doc.length;
    const scanEnd = Math.min(magicScanPageCount(), total);

    const imageByPage = new Map();
    const geminiImages = [];
    for (let p = 1; p <= scanEnd; p++) {
      const image = await doc.getPage(p);
      const buf = Buffer.isBuffer(image) ? image : Buffer.from(image);
      const prepared = await prepareImageForGemini(buf);
      imageByPage.set(p, {
        base64: prepared.base64,
        mimeType: prepared.mimeType,
      });
      geminiImages.push({
        inlineData: {
          mimeType: prepared.mimeType ?? "image/jpeg",
          data: prepared.base64,
        },
      });
    }

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: DETECT_TOC_PROMPT,
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: Math.min(2048, GEMINI_MAX_OUTPUT_TOKENS),
      },
    });

    const parts = [
      {
        text: `이 PDF는 총 ${total}페이지입니다. 아래 이미지는 **1페이지부터 ${scanEnd}페이지까지** 순서대로입니다. 목차로 보이는 페이지 번호만 JSON으로 답하세요.`,
      },
      ...geminiImages,
    ];

    const result = await model.generateContent(parts);
    let raw;
    try {
      raw = result.response.text().trim();
    } catch (geminiErr) {
      const msg =
        geminiErr instanceof Error
          ? geminiErr.message
          : "Gemini 응답을 읽을 수 없습니다.";
      return res.status(502).json({
        error: `모델 응답 오류: ${msg}`,
      });
    }

    let tocPages = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed?.tocPages) ? parsed.tocPages : [];
        tocPages = arr
          .map((n) => Number.parseInt(String(n), 10))
          .filter((n) => !Number.isNaN(n) && n >= 1 && n <= scanEnd);
        tocPages = [...new Set(tocPages)].sort((a, b) => a - b).slice(0, 12);
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]);
            const arr = Array.isArray(parsed?.tocPages) ? parsed.tocPages : [];
            tocPages = arr
              .map((n) => Number.parseInt(String(n), 10))
              .filter((n) => !Number.isNaN(n) && n >= 1 && n <= scanEnd);
            tocPages = [...new Set(tocPages)].sort((a, b) => a - b).slice(0, 12);
          } catch {
            tocPages = [];
          }
        }
      }
    }

    const previews = tocPages.map((pageIndex) => {
      const img = imageByPage.get(pageIndex);
      if (!img) return null;
      return {
        pageIndex,
        mimeType: img.mimeType ?? "image/jpeg",
        data: img.base64,
      };
    }).filter(Boolean);

    res.json({
      pdfTotalPages: total,
      scannedRange: { start: 1, end: scanEnd },
      suggestedTocPages: tocPages,
      previews,
    });
  } catch (err) {
    console.error(err);
    const status = /** @type {{ status?: number }} */ (err).status;
    if (status === 429) {
      return res.status(429).json({
        error:
          "Gemini API 한도(429)입니다. 잠시 후 다시 시도하거나 할당량을 확인하세요.",
      });
    }
    res.status(500).json({
      error:
        err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.",
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
});

app.post("/api/page-previews", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "PDF 파일(file)이 필요합니다." });
  }

  if (req.file.mimetype !== "application/pdf") {
    return res
      .status(400)
      .json({ error: "application/pdf만 업로드할 수 있습니다." });
  }

  const pagesField =
    req.body?.pages ?? req.query?.pages ?? req.body?.pageNumbers;
  const parsed = parsePagesJsonField(pagesField);
  if (!parsed || parsed.length === 0) {
    return res.status(400).json({
      error: 'pages 필드에 JSON 배열이 필요합니다. 예: "[3,4,5]"',
    });
  }

  const tempPath = join(tmpdir(), `toc-prev-${randomUUID()}.pdf`);

  try {
    await writeFile(tempPath, req.file.buffer);
    let bundle;
    try {
      bundle = await pdfPagesListToPngBase64(tempPath, parsed);
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "PAGE_SPAN_TOO_LARGE") {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "페이지 수가 너무 많습니다.",
        });
      }
      if (/** @type {{ code?: string }} */ (e).code === "NO_PAGES") {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "유효한 페이지가 없습니다.",
        });
      }
      throw e;
    }

    res.json({
      pdfTotalPages: bundle.pdfTotalPages,
      previews: bundle.pages.map((p) => ({
        pageIndex: p.pageIndex,
        mimeType: p.mimeType ?? "image/jpeg",
        data: p.base64,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error:
        err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.",
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
});

app.post("/api/extract-toc", upload.single("file"), async (req, res) => {
  if (!genAI) {
    return res.status(500).json({
      error: "GEMINI_API_KEY가 설정되지 않았습니다. server/.env를 확인하세요.",
    });
  }

  if (!req.file?.buffer) {
    return res.status(400).json({ error: "PDF 파일(file)이 필요합니다." });
  }

  if (req.file.mimetype !== "application/pdf") {
    return res
      .status(400)
      .json({ error: "application/pdf만 업로드할 수 있습니다." });
  }

  const startPage = req.body?.startPage ?? req.query?.startPage;
  const endPage = req.body?.endPage ?? req.query?.endPage;
  const pagesListRaw =
    req.body?.pages ?? req.query?.pages ?? req.body?.pageNumbers;
  const explicitPages = parsePagesJsonField(pagesListRaw);

  const tempPath = join(tmpdir(), `toc-${randomUUID()}.pdf`);

  try {
    await writeFile(tempPath, req.file.buffer);
    let bundle;
    try {
      if (explicitPages && explicitPages.length > 0) {
        bundle = await pdfPagesListToPngBase64(tempPath, explicitPages);
      } else {
        bundle = await pdfPageRangeToPngBase64(tempPath, startPage, endPage);
      }
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "PAGE_SPAN_TOO_LARGE") {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "페이지 구간이 너무 깁니다.",
        });
      }
      if (/** @type {{ code?: string }} */ (e).code === "NO_PAGES") {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "유효한 페이지가 없습니다.",
        });
      }
      throw e;
    }

    const { pages, pdfTotalPages, pageNumbers } = bundle;
    const range =
      "range" in bundle && bundle.range
        ? bundle.range
        : {
            start: pageNumbers[0],
            end: pageNumbers[pageNumbers.length - 1],
          };
    if (pages.length === 0) {
      return res
        .status(400)
        .json({ error: "PDF에서 페이지 이미지를 만들 수 없습니다." });
    }

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
      },
    });

    const rangeDesc =
      pageNumbers.length === range.end - range.start + 1
        ? `**${range.start}–${range.end}페이지**(${pages.length}장)`
        : `페이지 **${pageNumbers.join(", ")}** (${pages.length}장)`;

    const parts = [
      {
        text: `이 PDF는 총 ${pdfTotalPages}페이지입니다. 아래는 ${rangeDesc}입니다. 이 페이지들에서 목차 후보만 JSON으로 추출하세요. 항목은 최대 50개, 제목은 짧게.`,
      },
      ...pages.map((p) => ({
        inlineData: {
          mimeType: p.mimeType ?? "image/jpeg",
          data: p.base64,
        },
      })),
    ];

    const result = await model.generateContent(parts);

    let raw;
    try {
      raw = result.response.text().trim();
    } catch (geminiErr) {
      const msg =
        geminiErr instanceof Error
          ? geminiErr.message
          : "Gemini 응답을 읽을 수 없습니다.";
      return res.status(502).json({
        error: `모델 응답 오류: ${msg}`,
      });
    }

    if (!raw) {
      return res.status(502).json({
        error:
          "모델이 빈 텍스트를 반환했습니다. 안전 필터·차단 또는 응답 후보 없음일 수 있습니다. 페이지 구간을 줄이거나 다른 이미지로 시도해 보세요.",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          const fr =
            result.response.candidates?.[0]?.finishReason ?? "UNKNOWN";
          const tokenHint =
            fr === "MAX_TOKENS"
              ? " (출력 토큰 한도로 중간에 끊김)"
              : "";
          return res.status(502).json({
            error:
              `모델이 잘린 JSON을 반환했습니다${tokenHint}. 페이지 구간을 줄이거나, .env에서 GEMINI_MAX_OUTPUT_TOKENS=8192(최대)로 두었는지 확인하세요. finishReason=${fr}`,
          });
        }
      } else {
        return res.status(502).json({
          error:
            "모델 응답에 JSON이 없습니다. 프롬프트 준수 실패일 수 있어 응답 앞부분: " +
            raw.slice(0, 200),
        });
      }
    }

    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    res.json({
      meta: {
        pagesAnalyzed: pages.length,
        pdfTotalPages,
        pageRange: range,
        pageNumbers,
        model: GEMINI_MODEL,
      },
      entries,
    });
  } catch (err) {
    console.error(err);
    const status = /** @type {{ status?: number }} */ (err).status;
    if (status === 429) {
      return res.status(429).json({
        error:
          "Gemini API 한도(429)입니다. 페이지를 3장만내도 뜰 수 있습니다. 원인은 보통 (1) 무료 등급의 분당·일일 요청/토큰 한도 소진 (2) 같은 키로 다른 앱에서 이미 많이 호출한 경우입니다. Google AI Studio에서 할당량을 확인하고, 수십 분~다음 날까지 기다리거나 결제/유료 한도를 쓰거나, GEMINI_MODEL을 gemini-1.5-flash 등으로 바꿔 보세요. 서버는 이미지를 JPEG로 줄여내도록 설정되어 있습니다.",
      });
    }
    res.status(500).json({
      error:
        err instanceof Error ? err.message : "처리 중 오류가 발생했습니다.",
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`서버 http://localhost:${PORT}`);
});
