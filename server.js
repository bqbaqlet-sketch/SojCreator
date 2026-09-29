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

// Бірінші модель — негізгі, келесілері — қосалқы (негізгісі жүктелген болса ауысады).
// Керек болса Render-де GEMINI_MODELS айнымалысымен өзгертуге болады: "модель1,модель2"
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const MODELS = (process.env.GEMINI_MODELS || "gemini-3.8-flash,gemini-3.7-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const COLLEGE_NAME = "ТАРАЗ ИННОВАЦИЯЛЫҚ КӨПСАЛАЛЫ КОЛЛЕДЖІ";
const GOOGLE_CLIENT_ID =
  "1056990394829-p54m601t1j6p63r1fqfh9i3hv0q042ht.apps.googleusercontent.com";

// Қатеге код қосамыз: NOT_ALLOWED (тізімде жоқ) / INVALID_TOKEN (токен жарамсыз)
function authError(message, code, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

// Google-дан келген id_token шынайы ма, тексереді және email-ді қайтарады
async function verifyGoogleToken(idToken) {
  if (!idToken) throw authError("Кіру керек (Google арқылы).", "INVALID_TOKEN");

  const resp = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!resp.ok) throw authError("Кіру мерзімі аяқталды. Қайтадан кіріңіз.", "INVALID_TOKEN");

  const payload = await resp.json();

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    throw authError("Токен басқа қосымшаға арналған.", "INVALID_TOKEN");
  }
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    throw authError("Email расталмаған.", "INVALID_TOKEN");
  }

  const email = payload.email.toLowerCase();
  if (!ALLOWED_EMAILS.map((e) => e.toLowerCase()).includes(email)) {
    throw authError("Бұл email-ге рұқсат жоқ.", "NOT_ALLOWED", { email });
  }

  return email;
}

// Достаём чистый JSON из ответа модели (на случай если она обернёт в ```json ... ```)
function extractJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Модель не вернула JSON");
  const candidate = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // Кейде модель "\n" орнына нақты жол ауыстыруды қояды, бұл JSON-ды
    // бұзады. Жол ішіндегі қараусыз бақылау таңбаларын тазалап,
    // қайта көреміз.
    const repaired = candidate.replace(/"((?:[^"\\]|\\.)*)"/gs, (m, inner) =>
      '"' + inner.replace(/[\n\r\t]/g, (c) => ({ "\n": "\\n", "\r": "", "\t": "\\t" }[c])) + '"'
    );
    return JSON.parse(repaired);
  }
}

// Бір модельге бір сұраныс. Уақыт шегі бар: модель "қатып қалса" мәңгі күтпейміз.
const TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "90000", 10);
const COOLDOWN_MS = parseInt(process.env.GEMINI_COOLDOWN_MS || "180000", 10);
const cooldownUntil = {}; // модель -> қашанға дейін "демалады" (уақыт белгісі)

// Groq (басқа компания) — барлық Gemini модельдері өтпей қалса, соңғы амал ретінде
async function requestGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false, status: "no-key", raw: "GROQ_API_KEY орнатылмаған", ms: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.7,
        max_tokens: 8000, // JSON толық шықпай, үзіліп қалмас үшін
        // ЕСКЕРТУ: response_format:"json_object" қасақана қоспаймыз.
        // Groq-тың қатаң JSON тексерушісі кейде дұрыс жауапты да
        // "жарамсыз" деп тастайды (json_validate_failed). Оның орнына
        // модель кәдімгі мәтін ретінде жазады, ал JSON-ды өзіміз
        // extractJson() арқылы аламыз (Gemini-де де солай істейміз).
        messages: [
          {
            role: "user",
            content:
              prompt +
              '\n\nЖАУАПТЫ ТЕК ЖАРАМДЫ JSON ретінде қайтар. Басқа мәтін, түсініктеме немесе markdown (```) қоспа. JSON тырнақшаларының ("), артқы қиғаш сызықтардың (\\) дұрыс экрандалғанына көз жеткіз.',
          },
        ],
      }),
    });
    const raw = await resp.text();
    return { ok: resp.ok, status: resp.status, raw, ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = e.name === "AbortError";
    return { ok: false, status: timedOut ? "timeout" : "network", raw: e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function requestModel(model, apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
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
    const raw = await resp.text();
    return { ok: resp.ok, status: resp.status, raw, ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = e.name === "AbortError";
    return { ok: false, status: timedOut ? "timeout" : "network", raw: e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini({ subject, topic, plan }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY не задан. Скопируй .env.example в .env и вставь свой бесплатный ключ."
    );
  }

  const prompt = buildSystemPrompt({ subject, topic, plan });

  const RETRY_STATUSES = [500, 503];
  // Осы жағдайларда келесі модельге ауысамыз (немесе модель "демалады")
  const FALLBACK_STATUSES = [429, 500, 503, 404, "timeout", "network"];
  const COOLDOWN_STATUSES = [429, 500, 503, "timeout", "network"];

  // Жақында сәтсіз болған модельдерді тізімнің соңына жылжытамыз,
  // сонда әр жұмыс бос уақыт жоғалтпай, жұмыс істеп тұрған модельден бастайды
  const now = Date.now();
  const healthy = MODELS.filter((mdl) => !(cooldownUntil[mdl] > now));
  const cooling = MODELS.filter((mdl) => cooldownUntil[mdl] > now);
  const order = [...healthy, ...cooling];
  if (cooling.length) {
    console.log(`Кезекте кейінге қалды (жақында өтпеген): ${cooling.join(", ")}`);
  }

  let okResult = null;
  let lastFail = null;

  for (let m = 0; m < order.length; m++) {
    const model = order[m];
    const isLast = m === order.length - 1;
    // Соңғы модельде 1 қысқа қайталау ғана: одан кейін бәрібір Groq-қа өтеміз,
    // сондықтан ұзақ күтудің қажеті жоқ
    const delays = isLast ? [2500] : [];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      const r = await requestModel(model, apiKey, prompt);
      console.log(`⏱ ${model}: ${r.status} — ${(r.ms / 1000).toFixed(1)} с`);

      if (r.ok) {
        okResult = { model, raw: r.raw };
        break;
      }

      if (RETRY_STATUSES.includes(r.status) && attempt < delays.length) {
        console.log(`${model}: ${r.status}, ${delays[attempt] / 1000}с күтіп қайталаймын...`);
        await new Promise((res) => setTimeout(res, delays[attempt]));
        continue;
      }

      // Google-дың нақты қате мәтінін оқимыз, сонда шын себеп көрінеді
      let googleMsg = r.raw;
      try {
        googleMsg = JSON.parse(r.raw)?.error?.message || r.raw;
      } catch (_) {}
      googleMsg = String(googleMsg).slice(0, 300);
      console.error(`${model}: ${r.status}: ${googleMsg}`);
      lastFail = { model, status: r.status, msg: googleMsg };
      if (COOLDOWN_STATUSES.includes(r.status)) {
        cooldownUntil[model] = Date.now() + COOLDOWN_MS;
      }
      break;
    }

    if (okResult) {
      delete cooldownUntil[okResult.model];
      if (m > 0) console.log(`Қосалқы модель қолданылды: ${okResult.model}`);
      break;
    }
    if (!isLast && FALLBACK_STATUSES.includes(lastFail.status)) {
      console.log(`${model} өтпеді, келесі модельге ауысамын...`);
      continue;
    }
    break;
  }

  // Barлық Gemini модельдері өтпесе, соңғы амал ретінде Groq-қа сұраймыз
  // (Groq біздің соңғы мүмкіндігіміз болғандықтан, бір рет қайталап көреміз)
  if (!okResult) {
    for (let i = 0; i < 2; i++) {
      console.log(
        i === 0
          ? `Барлық Gemini модельдері өтпеді, Groq-қа (${GROQ_MODEL}) ауысамын...`
          : `Groq қайта көреді...`
      );
      const g = await requestGroq(prompt);
      console.log(`⏱ groq/${GROQ_MODEL}: ${g.status} — ${(g.ms / 1000).toFixed(1)} с`);

      if (g.ok) {
        okResult = { model: `groq/${GROQ_MODEL}`, raw: g.raw, provider: "groq" };
        break;
      }
      if (g.status === "no-key") break; // ключ жоқ болса, қайталаудың мәні жоқ
      console.error(`groq/${GROQ_MODEL}: ${g.status}: ${String(g.raw).slice(0, 300)}`);
    }
  }

  if (!okResult) {
    const { model, status, msg } = lastFail;
    if (status === 429) {
      throw new Error(`Gemini лимиті таусылды (429, ${model}). Google айтуы: ${msg}`);
    }
    if (status === "timeout") {
      throw new Error(`Gemini тым ұзақ жауап берді (${model}). Қайталап көріңіз.`);
    }
    if (RETRY_STATUSES.includes(status) || status === "network") {
      throw new Error(
        `Gemini және қосалқы қызмет (Groq) қазір жауап бермеді (${status}, ${model}). Бір-екі минуттан кейін қайталап көріңіз. Google айтуы: ${msg}`
      );
    }
    throw new Error(`Gemini API қатесі (${status}, ${model}): ${msg}`);
  }

  // Groq мен Gemini жауап пішіні әртүрлі, соған қарай мәтінді аламыз
  const data = JSON.parse(okResult.raw);
  let text;
  if (okResult.provider === "groq") {
    text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Groq бос жауап қайтарды");
  } else {
    const candidate = data?.candidates?.[0];
    text = candidate?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini бос жауап қайтарды");
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw new Error("Жауап үзіліп қалды. Қайтадан көріңіз.");
    }
  }

  return extractJson(text);
}

// Google арқылы кіргеннен кейін бірден рұқсатты тексереді
app.post("/api/check-access", async (req, res) => {
  try {
    const email = await verifyGoogleToken(req.body.idToken);
    res.json({ allowed: true, email });
  } catch (err) {
    if (err.code === "NOT_ALLOWED") {
      return res.status(403).json({ allowed: false, error: err.message, email: err.email });
    }
    res.status(401).json({ allowed: false, error: err.message || "Кіру қатесі" });
  }
});

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

    const tStart = Date.now();
    let content = await callGemini({
      subject: subject || "Пән",
      topic,
      plan,
    });

    const tGemini = Date.now();
    console.log(`⏱ Gemini жауабы: ${((tGemini - tStart) / 1000).toFixed(1)} с`);

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
    const status = err.code === "NOT_ALLOWED" ? 403 : err.code === "INVALID_TOKEN" ? 401 : 500;
    res.status(status).json({ error: err.message || "Белгісіз қате", email: err.email });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер іске қосылды: http://localhost:${PORT}`);
});
