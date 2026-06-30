import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * STEP 1: ดาวน์โหลดวิดีโอ + ซับไตเติล (auto-generated) จาก YouTube ด้วย yt-dlp
 * ต้องติดตั้ง yt-dlp และ ffmpeg ในเครื่อง/เซิร์ฟเวอร์ก่อน
 */
async function downloadVideoAndSubs(youtubeUrl, jobId) {
  const videoPath = path.join(TEMP_DIR, `${jobId}.mp4`);
  const subBase = path.join(TEMP_DIR, jobId);

  // ดาวน์โหลดวิดีโอ (จำกัดความละเอียดไม่เกิน 720p เพื่อความเร็ว)
  await execAsync(
    `yt-dlp -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 -o "${videoPath}" "${youtubeUrl}"`
  );

  // ดาวน์โหลดซับไตเติล (auto-caption ภาษาไทย/อังกฤษ) เป็น .vtt
  await execAsync(
    `yt-dlp --write-auto-sub --sub-lang "th,en" --skip-download -o "${subBase}" "${youtubeUrl}"`
  ).catch(() => {
    // ไม่มีซับก็ไม่เป็นไร จะ fallback ไปใช้วิธีอื่น
  });

  // หาไฟล์ .vtt ที่ดาวน์โหลดมา
  const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(jobId) && f.endsWith(".vtt"));
  const subPath = files.length > 0 ? path.join(TEMP_DIR, files[0]) : null;

  return { videoPath, subPath };
}

/**
 * STEP 2: แปลงไฟล์ .vtt เป็น array ของ { start, end, text } (วินาที)
 */
function parseVtt(vttContent) {
  const lines = vttContent.split("\n");
  const segments = [];
  const timeRegex = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;

  const toSeconds = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(timeRegex);
    if (match) {
      const start = toSeconds(match[1], match[2], match[3], match[4]);
      const end = toSeconds(match[5], match[6], match[7], match[8]);
      const textLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        textLines.push(lines[j].replace(/<[^>]+>/g, "").trim());
        j++;
      }
      const text = textLines.join(" ").trim();
      if (text) segments.push({ start, end, text });
    }
  }
  return segments;
}

/**
 * STEP 3: ให้ Claude วิเคราะห์ transcript แล้วเลือกช่วงที่น่าสนใจที่สุด
 * คืนค่าเป็น array ของ { start, end, reason }
 */
async function findHighlightMoments(segments, targetClipCount, maxClipSeconds) {
  // รวม transcript พร้อม timestamp ให้ Claude อ่าน
  const transcriptText = segments
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
    .join("\n");

  const prompt = `นี่คือ transcript ของวิดีโอ YouTube พร้อม timestamp (วินาที):

${transcriptText}

ช่วยเลือกช่วงที่น่าสนใจ/เด่น/มีอารมณ์ร่วมที่สุดมาทั้งหมด ${targetClipCount} ช่วง
แต่ละช่วงต้องยาวไม่เกิน ${maxClipSeconds} วินาที และควรเป็นช่วงที่ต่อเนื่องเข้าใจง่ายเมื่อตัดออกมาดูเดี่ยวๆ

ตอบกลับเป็น JSON array เท่านั้น ไม่ต้องมีคำอธิบายอื่น รูปแบบ:
[{"start": 12.5, "end": 28.0, "reason": "เหตุผลสั้นๆ ว่าทำไมช่วงนี้น่าสนใจ"}]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  return JSON.parse(text);
}

/**
 * STEP 4: ตัด + ต่อคลิปตามช่วงเวลาที่ได้ด้วย ffmpeg
 */
async function cutAndMergeClips(videoPath, moments, jobId) {
  const clipPaths = [];

  for (let i = 0; i < moments.length; i++) {
    const { start, end } = moments[i];
    const duration = Math.max(0.5, end - start);
    const clipPath = path.join(TEMP_DIR, `${jobId}_clip${i}.mp4`);
    await execAsync(
      `ffmpeg -y -ss ${start} -i "${videoPath}" -t ${duration} -c:v libx264 -c:a aac -avoid_negative_ts make_zero "${clipPath}"`
    );
    clipPaths.push(clipPath);
  }

  // สร้างไฟล์ list สำหรับ ffmpeg concat
  const listPath = path.join(TEMP_DIR, `${jobId}_list.txt`);
  fs.writeFileSync(listPath, clipPaths.map((p) => `file '${p}'`).join("\n"));

  const outputPath = path.join(OUTPUT_DIR, `${jobId}.mp4`);
  await execAsync(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`
  );

  return outputPath;
}

function cleanup(jobId) {
  const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(jobId));
  for (const f of files) {
    fs.unlinkSync(path.join(TEMP_DIR, f));
  }
}

// ===== API Endpoint =====
app.post("/api/process", async (req, res) => {
  const { youtubeUrl, clipCount = 3, maxClipSeconds = 15 } = req.body;
  if (!youtubeUrl) return res.status(400).json({ error: "กรุณาส่งลิงก์ YouTube มาด้วย" });

  const jobId = nanoid(8);

  try {
    console.log(`[${jobId}] กำลังดาวน์โหลดวิดีโอและซับไตเติล...`);
    const { videoPath, subPath } = await downloadVideoAndSubs(youtubeUrl, jobId);

    if (!subPath) {
      cleanup(jobId);
      return res.status(422).json({
        error: "ไม่พบซับไตเติลของวิดีโอนี้ (ต้องมี auto-caption หรือซับที่เปิดให้ใช้ จึงจะวิเคราะห์ช่วงเด่นได้)",
      });
    }

    console.log(`[${jobId}] กำลังแยกวิเคราะห์ transcript...`);
    const vttContent = fs.readFileSync(subPath, "utf-8");
    const segments = parseVtt(vttContent);

    console.log(`[${jobId}] กำลังให้ AI เลือกช่วงเด่น...`);
    const moments = await findHighlightMoments(segments, clipCount, maxClipSeconds);

    console.log(`[${jobId}] กำลังตัดและต่อคลิป...`);
    const outputPath = await cutAndMergeClips(videoPath, moments, jobId);

    cleanup(jobId);

    res.json({
      success: true,
      downloadUrl: `/outputs/${path.basename(outputPath)}`,
      moments,
    });
  } catch (err) {
    console.error(err);
    cleanup(jobId);
    res.status(500).json({ error: "เกิดข้อผิดพลาด: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 รันอยู่ที่ http://localhost:${PORT}`));
