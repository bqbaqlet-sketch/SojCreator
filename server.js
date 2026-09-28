require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch");
const { buildSystemPrompt } = require("./systemPrompt");
const { buildDocx } = require("./buildDocx");
const { ALLOWED_EMAILS } = require("./allowedEmails");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const GEMINI_MODEL = "gemini-3.8-flash";
const COLLEGE_NAME = "ТАРАЗ ИННОВАЦИЯЛЫҚ КӨПСАЛАЛЫ КОЛЛЕДЖІ";
const GOOGLE_CLIENT_ID =
  "1056990394829-p54m601t1j6p63r1fqfh9i3hv0q042ht.apps.googleusercontent.com";

// Google-дан келген id_token шынайы ма, тексереді және email-ді қайтарады
async function verifyGoogleToken(idToken) {
  if (!idToken) throw new Error("Кіру керек (Google арқылы).");

  const resp = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!resp.ok) throw new Error("Google токенін тексеру сәтсіз аяқталды.");

  const payload = await resp.json();

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    throw new Error("Токен басқа қосымшаға арналған.");
  }
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    throw new Error("Email расталмаған.");
  }

  const email = payload.email.toLowerCase();
  if (!ALLOWED_EMAILS.map((e) => e.toLowerCase()).includes(email)) {
    throw new Error("Бұл email-ге рұқсат жоқ. Әкімшіге хабарласыңыз.");
  }

  return email;
}

// Достаём чистый JSON из ответа модели (на случай если она обернёт в ```json ... ```)
function extractJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Модель не вернула JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGemini({ subject, topic, pages }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY не задан. Скопируй .env.example в .env и вставь свой бесплатный ключ."
    );
  }

  const prompt = buildSystemPrompt({ subject, topic, pages });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Gemini аса жүктелген кезде (503/429/500) бірнеше рет қайталап көреміз
  const RETRY_STATUSES = [429, 500, 503];
  const DELAYS_MS = [3000, 6000, 10000]; // 1-ші әрекеттен кейін 3с, содан 6с, 10с
  let resp;

  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
        },
      }),
    });

    if (resp.ok) break;

    if (RETRY_STATUSES.includes(resp.status) && attempt < DELAYS_MS.length) {
      console.log(`Gemini ${resp.status}, ${DELAYS_MS[attempt] / 1000}с күтіп қайталаймын...`);
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
      continue;
    }

    const errText = await resp.text();
    if (RETRY_STATUSES.includes(resp.status)) {
      throw new Error(
        "Gemini қазір тым жүктелген. 1-2 минуттан кейін қайталап көріңіз."
      );
    }
    throw new Error(`Gemini API қатесі (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini бос жауап қайтарды");

  return extractJson(text);
}

app.post("/api/generate", async (req, res) => {
  try {
    // Алдымен кіру құқығын тексереміз
    await verifyGoogleToken(req.body.idToken);

    const {
      topic,
      subject,
      course,
      group,
      student,
      teacher,
      pages,
    } = req.body;

    if (!topic || !student || !group) {
      return res.status(400).json({ error: "Тақырып, аты-жөні және топ міндетті түрде толтырылуы керек." });
    }

    const content = await callGemini({
      subject: subject || "Пән",
      topic,
      pages: pages || 3,
    });

    const buffer = await buildDocx(content, {
      college: COLLEGE_NAME,
      topic,
      subject: subject || "-",
      course: course || "1",
      group,
      student,
      teacher: teacher || "-",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="SOJ_${Date.now()}.docx"`
    );
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Белгісіз қате" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер іске қосылды: http://localhost:${PORT}`);
});
