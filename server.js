import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

const TEMP_DIR = path.join(__dirname, "temp");
const OUTPUT_DIR = path.join(__dirname, "outputs");
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function downloadVideoAndSubs(youtubeUrl, jobId) {
  const videoPath = path.join(TEMP_DIR, `${jobId}.mp4`);
  const subBase = path.join(TEMP_DIR, jobId);

  await execAsync(
    `yt-dlp -f "bv*[height<=720]+ba/b[height<=720]" --merge-output-format mp4 -o "${videoPath}" "${youtubeUrl}"`
  );

  await execAsync(
    `yt-dlp --write-auto-sub --sub-lang "th,en" --skip-download -o "${subBase}" "${youtubeUrl}"`
  ).catch(() => {});

  const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(jobId) && f.endsWith(".vtt"));
  const subPath = files.length > 0 ? path.join(TEMP_DIR, files[0]) : null;

  return { videoPath, subPath };
}

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

function findHighlightMoments(segments, targetClipCount, maxClipSeconds) {
  if (segments.length === 0) return [];

  const exclaimWords = [
    "โอ้", "วาว", "สุดยอด", "ตกใจ", "ฮา", "เจ็บ", "รัก", "ดีใจ", "เศร้า",
    "wow", "amazing", "incredible", "omg", "crazy", "insane", "love", "best",
  ];

  const windows = [];
  let cur = null;
  for (const seg of segments) {
    if (!cur) {
      cur = { start: seg.start, end: seg.end, text: seg.text };
    } else if (seg.end - cur.start <= maxClipSeconds) {
      cur.end = seg.end;
      cur.text += " " + seg.text;
    } else {
      windows.push(cur);
      cur = { start: seg.start, end: seg.end, text: seg.text };
    }
  }
  if (cur) windows.push(cur);

  const scored = windows.map((w) => {
    let score = w.text.length;
    if (/[!?]/.test(w.text)) score += 50;
    for (const word of exclaimWords) {
      if (w.text.toLowerCase().includes(word.toLowerCase())) score += 30;
    }
    return { ...w, score };
  });

  scored.sort((a, b) => b.score - a.score);
  let picked = scored.slice(0, targetClipCount);
  picked.sort((a, b) => a.start - b.start);

  return picked.map((w) => ({
    start: w.start,
    end: Math.min(w.end, w.start + maxClipSeconds),
    reason: "ช่วงที่มีคำพูดเยอะ/มีอารมณ์ร่วมตามการวิเคราะห์อัตโนมัติ",
  }));
}

async function cutAndMergeClips(videoPath, moments, jobId) {
  const clipPaths = [];

  for (let i = 0; i < moments.length; i++) {
    const { start, end } = moments[i];
    const duration = Mat
