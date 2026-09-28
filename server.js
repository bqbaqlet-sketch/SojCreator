require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch");
const { buildSystemPrompt } = require("./systemPrompt");
const { buildDocx } = require("./buildDocx");
const { ALLOWED_EMAILS } = require("./allowedEmails");
const { fitContent } = require("./fitLength");
const { getPlan } = require("./plans");

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

async function callGemini({ subject, topic, plan }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY не задан. Скопируй .env.example в .env и вставь свой бесплатный ключ."
    );
  }

  const prompt = buildSystemPrompt({ subject, topic, plan });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // Gemini аса жүктелген кезде (503/500) бірнеше рет қайталап көреміз.
  // 429 (лимит таусылды) қайталанбайды: қайталау лимитті тағы жейді.
  const RETRY_STATUSES = [500, 503];
  const DELAYS_MS = [3000, 6000]; // бар болғаны 2 қайталау: 3с, содан 6с
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
          maxOutputTokens: 16384, // стандарт жұмысқа (~1200 сөз) жеткілікті
          // Ойлау деңгейін төмендету: жауап әлдеқайда тез келеді
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    });

    if (resp.ok) break;

    if (RETRY_STATUSES.includes(resp.status) && attempt < DELAYS_MS.length) {
      console.log(`Gemini ${resp.status}, ${DELAYS_MS[attempt] / 1000}с күтіп қайталаймын...`);
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
      continue;
    }

    // Google-дың нақты қате мәтінін оқимыз, сонда шын себеп көрінеді
    const errText = await resp.text();
    let googleMsg = errText;
    try {
      googleMsg = JSON.parse(errText)?.error?.message || errText;
    } catch (_) {}
    googleMsg = String(googleMsg).slice(0, 300);
    console.error(`Gemini ${resp.status}: ${googleMsg}`);

    if (resp.status === 429) {
      throw new Error(
        `Gemini лимиті таусылды (429). Google айтуы: ${googleMsg}`
      );
    }
    if (RETRY_STATUSES.includes(resp.status)) {
      throw new Error(
        `Gemini жауап бермеді (${resp.status}). Google айтуы: ${googleMsg}`
      );
    }
    throw new Error(`Gemini API қатесі (${resp.status}): ${googleMsg}`);
  }

  const data = await resp.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini бос жауап қайтарды");
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("Жауап тым ұзын болып, үзіліп қалды. Аз беттік нұсқаны таңдап көріңіз.");
  }

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

    const plan = getPlan(pages);

    let content = await callGemini({
      subject: subject || "Пән",
      topic,
      plan,
    });

    // Тым ұзын болса — толық сөйлемдермен қысқартамыз
    content = fitContent(content, plan);

    const buffer = await buildDocx(content, {
      college: COLLEGE_NAME,
      topic,
      subject: subject || "-",
      course: course || "1",
      group,
      student,
      teacher: teacher || "-",
      pageBreakBeforeNegizgi: plan.pageBreakBeforeNegizgi,
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
