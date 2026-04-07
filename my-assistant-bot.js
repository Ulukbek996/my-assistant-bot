const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const BOT_TOKEN = '8794427596:AAEVIDJFLJHb8tWjwKZ0aHMpCUXOExrQzRg';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const FB_PAGE_ID = '924698817396016';
const FB_PAGE_ACCESS_TOKEN = 'EAA98xKtbrZCYBREQnsrBFt6uSbO6pPwmrfE4vZAgjJQpj8OdxKhTRXGT6hX1ZBnZCzuaqAWZCArBkt7DAA7mz5p7GLonHyNwj719DS8Wp1sXnmRZASMIHYl8j0Gjjjm5hOnxSrquTzi9No4K42NDJVwmTUjjqZCsNZB6EYiCF0ikOZBDxCkq7ZBkstsZC6k0jOsEWZCGRTj1mcRBopt5ZBebdZAeTEKSVcMRKa7Qp9GafwAJfF0g8ZD';

// Instagram Business Account ID -- set via environment variable IG_BUSINESS_ACCOUNT_ID
// Uses the same FB_PAGE_ACCESS_TOKEN (works when Instagram is linked to the Facebook page)
const IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID || '';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Conversation history per chat
const conversations = new Map();

// Post sessions: chatId -> { text, pendingMedia, publishBoth?, interviewAnswers? }
const postSessions = new Map();

// Caption selection sessions (photo without caption, no trigger): chatId -> { captions, pendingMedia }
const captionSessions = new Map();

// Interview sessions: chatId -> { step: 1-5, answers: [], pendingMedia }
const interviewSessions = new Map();

// Strategy sessions: chatId -> { step: 1-5, answers: [] }
const strategySessions = new Map();

// Photo search sessions: chatId -> { query: string, usedQueries: string[] }
const photoSearchSessions = new Map();
// ---------------------------------------------------------------------------
// PostgreSQL – persistent memory
// ---------------------------------------------------------------------------

const DB_URL = 'postgresql://postgres:EJrRKdONCzmukcReqAlHWNEZvooMxAgm@postgres.railway.internal:5432/railway';
const pool = new Pool({ connectionString: DB_URL });

// Tracks which chatIds have already been loaded from DB this session
const dbHistoryLoaded = new Set();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         SERIAL PRIMARY KEY,
      chat_id    BIGINT       NOT NULL,
      role       VARCHAR(20)  NOT NULL,
      content    TEXT         NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversations(chat_id, created_at)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      chat_id     BIGINT  PRIMARY KEY,
      preferences JSONB   NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts_history (
      id           SERIAL PRIMARY KEY,
      chat_id      BIGINT       NOT NULL,
      post_text    TEXT         NOT NULL,
      platform     VARCHAR(20)  NOT NULL,
      published_at TIMESTAMPTZ  DEFAULT NOW(),
      approved     BOOLEAN      DEFAULT TRUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id            SERIAL PRIMARY KEY,
      chat_id       BIGINT       NOT NULL,
      reminder_text TEXT         NOT NULL,
      remind_at     TIMESTAMPTZ  NOT NULL,
      created_at    TIMESTAMPTZ  DEFAULT NOW(),
      sent          BOOLEAN      DEFAULT FALSE
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(remind_at) WHERE NOT sent'
  );
  console.log('Database tables ready.');
}

async function loadConversationFromDb(chatId) {
  const res = await pool.query(
    'SELECT role, content FROM conversations WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20',
    [chatId]
  );
  return res.rows.reverse();
}

async function saveMessageToDb(chatId, role, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  await pool.query(
    'INSERT INTO conversations (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, role, text]
  );
}

async function ensureHistoryLoaded(chatId) {
  if (dbHistoryLoaded.has(chatId)) return;
  dbHistoryLoaded.add(chatId);
  if (conversations.has(chatId) && conversations.get(chatId).length > 0) return;
  try {
    const rows = await loadConversationFromDb(chatId);
    if (rows.length > 0) {
      conversations.set(chatId, rows);
      console.log(`Loaded ${rows.length} messages from DB for chat ${chatId}`);
    }
  } catch (err) {
    console.error('Failed to load history from DB:', err.message);
  }
}

async function upsertUserPrefs(chatId, prefs) {
  try {
    await pool.query(
      `INSERT INTO user_preferences (chat_id, preferences, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id) DO UPDATE
         SET preferences = user_preferences.preferences || $2,
             updated_at  = NOW()`,
      [chatId, JSON.stringify(prefs)]
    );
  } catch (err) {
    console.error('upsertUserPrefs error:', err.message);
  }
}

async function savePublishedPost(chatId, postText, platform) {
  try {
    await pool.query(
      'INSERT INTO posts_history (chat_id, post_text, platform, approved) VALUES ($1, $2, $3, TRUE)',
      [chatId, postText, platform]
    );
  } catch (err) {
    console.error('savePublishedPost error:', err.message);
  }
}

async function detectAndSavePrefs(chatId, userMessage) {
  const prefs = {};
  if (/[а-яёА-ЯЁ]/.test(userMessage)) prefs.language = 'ru';
  else if (/[a-zA-Z]{3,}/.test(userMessage)) prefs.language = 'en';
  if (Object.keys(prefs).length > 0) {
    await upsertUserPrefs(chatId, prefs);
  }
}



// ---------------------------------------------------------------------------
// Brand knowledge
// ---------------------------------------------------------------------------

const BRAND_KNOWLEDGE = `## Hammer Remodeling LLC -- Brand Knowledge

**Company:** Hammer Remodeling LLC, based in Buffalo Grove, IL
**Main slogan:** "European craftsmanship. American standards. Done in days, not months."

**3 Brand Pillars -- at least one must appear in every post:**
1. QUALITY -- European-trained team, precision, attention to detail
2. SPEED -- complete bathroom remodel in 7-10 working days, not months
3. TRANSPARENCY -- full price before work starts, no surprises, no hidden fees

**Target client:** American homeowner, $150k-$300k+ income, lives in NW Chicago suburbs (Buffalo Grove, Arlington Heights, Palatine, Schaumburg, Hoffman Estates, Elk Grove Village, Northbrook, Glenview, Wilmette). Owns a single-family home or townhouse. NOT condo owners, NOT renters.

**4 Client fears -- address in content:**
1. Contractor will ghost mid-project --> "We show up every day. Your project manager keeps you updated."
2. Price will double after start --> "You get the full price before we start. No surprises."
3. Will take months --> "Complete bathroom remodel in 7-10 days, not months."
4. Bad quality --> "Our team trained across Europe. Precision is in our DNA."

**Main advertising focus:** Bathroom remodel $15,000-$25,000, 7-10 working days
**Full scope of work:** Bathroom remodel, kitchen remodel, tile installation, flooring (organic only), full home renovation, commercial/corporate remodeling, and any other remodeling work.

**Tone of voice -- USE:**
- "Your bathroom, done right in 10 days."
- "We trained across Europe. Now we build in Chicago."
- "No hidden fees. You see the full price before we start."
- "See what we did for a family in Arlington Heights."
- "Complete bathroom remodel: tile, plumbing, vanity -- all in 10 days."

**Tone of voice -- NEVER use:**
- "Exceed your expectations", "World-class", "best in class", "We deliver results", "Quality workmanship" (without specifics), generic AI phrases

**CONTENT RULE -- REAL PHOTOS ONLY:** Any photo of remodeling/construction work is valid. Only flag photos completely unrelated to construction (landscapes, food, people, etc.).

**5 Content types:** BEFORE/AFTER | PROCESS | EDUCATIONAL | SOCIAL PROOF | OFFER

**Hashtags:**
- Always: #hammerremodeling #bathroomremodel #chicagocontractor #homeimprovement #remodeling
- Local (rotate): #buffalogroveil #arlingtonheights #chicagosuburbs #nwsuburbs #palatineil #schaumburg #northbrook #glenview
- By work: #bathroomdesign #tileinstallation #bathroomrenovation #flooringinstall #kitchenremodel #beforeandafter #homerenovation

**Competitors:** Envy Home Services (veteran-owned), Sunny Construction (family since 2007), Regency Home (40+ yrs), Kitchen Village (Arlington Hts)`;

const LONGHORN_BRAND_KNOWLEDGE = `## Longhorn Construction -- Brand Knowledge

**Company:** Longhorn Construction, based in Austin, TX
**Market:** Austin, TX and surrounding suburbs (Round Rock, Cedar Park, Pflugerville, Georgetown, Kyle, Buda, Leander, Manor)

**3 Brand Pillars -- at least one must appear in every post:**
1. QUALITY -- skilled craftsmen, precision work, attention to detail
2. SPEED -- projects completed on schedule, no delays
3. TRANSPARENCY -- clear pricing upfront, no hidden fees, no surprises

**Target client:** Texas homeowner, $100k-$250k+ income, lives in Austin suburbs, owns a single-family home or townhouse. Aspiring, proud of their home, values reliability.

**4 Client fears -- address in content:**
1. Contractor won't show up --> "We show up every day until it's done."
2. Price will balloon --> "Full price agreed before we start. No surprises."
3. Project drags on --> "On schedule, every time."
4. Poor quality --> "Skilled craftsmen. Built to last."

**Main advertising focus:** Bathroom and kitchen remodeling
**Full scope of work:** Bathroom remodel, kitchen remodel, tile installation, flooring, full home renovation, commercial remodeling, and any other remodeling work.

**Tone:** Professional, direct, Texas-proud. Friendly but no-nonsense. Speak to Austin homeowners who value reliability and quality.

**NEVER use:** Generic AI phrases, "world-class", "exceed expectations", vague promises without specifics.

**CONTENT RULE -- REAL PHOTOS ONLY:** Any photo of remodeling/construction work is valid.

**5 Content types:** BEFORE/AFTER | PROCESS | EDUCATIONAL | SOCIAL PROOF | OFFER

**Hashtags:**
- Always: #longhornremodeling #austincontractor #austintx #austinhomes #texasremodeling #austinrenovation
- Local (rotate): #roundrocktx #cedarparktx #pflugervilletx #georgetowntx #kyletx #budatx #leandertx
- By work: #bathroomremodel #kitchenremodel #tileinstallation #flooringinstall #homeimprovement #beforeandafter #homerenovation`;

const MARKETING_RULES = `## 7 Core Marketing Rules

RULE 1 - MOVEMENT: One image = one idea. Understood in 3 seconds. Text flows naturally left-to-right.
RULE 2 - LEXICON: No vague words. Specific numbers, technical terms, real offers.
RULE 3 - TARGET AUDIENCE: Content must make local homeowners feel "they understand me".
RULE 4 - FUNNEL: TOP (warm-up: show transformation, build trust) or BOTTOM (ready to buy: price, CTA, contact).
RULE 5 - CTA DEPTH: Small (like/comment) | Medium (DM/form on platform) | Large (call/website). Match to funnel stage.
RULE 6 - CONTACT INFO: ONE contact method per post only.
RULE 7 - PLATFORM: Facebook = text first, image supports. Instagram = image first, text adds detail.`;

const IMAGE_EDITING_SECTION = `**🖼️ Креатив (Canva/Photoshop инструкции):**
- **Логотип:** позиция + размер + цвет + opacity (пр: "нижний правый, 12% ширины, белый, 70%")
- **Текст на фото:** точный текст + позиция + стиль (пр: "'Done in 10 Days' -- нижняя треть, белый bold 48pt, подложка #000 50%")
- **Кадрирование:** что убрать и зачем (пр: "обрезать 15% снизу -- убрать мусор, акцент на плитку")
- **До/после:** нужна ли раскладка (пр: "вертикальный сплит 50/50, плашки 'BEFORE'/'AFTER' сверху")
- **Графика:** бейджи, стрелки, локация-тег (пр: "бейдж 'Free Estimate' -- верхний левый, белый на #1a1a2e круге")
- **Цветокоррекция:** конкретная правка (пр: "тепло +15, контраст +10 -- убрать холодную синеву")
- **Контакт на фото:** что и где (пр: "телефон -- нижний левый, белый 16pt, под логотипом")
- **Маркетинговый приём:** оверлей с отзывом, статистика, срочность (пр: "'2 spots left in April' -- яркая плашка сверху")`;

const CLARIFYING_QUESTIONS_RULE = `Если критически важная информация неизвестна -- задай максимум 1-2 вопроса в конце. Только если ответ реально изменит рекомендации. Если всё ясно -- не спрашивай.`;

// ---------------------------------------------------------------------------
// Interview flow
// ---------------------------------------------------------------------------

const INTERVIEW_QUESTIONS = [
  'Для какой компании?\n\n*1* — Hammer Remodeling (Chicago)\n*2* — Longhorn Construction (Austin, TX)',
  'Что на фото? Опиши коротко (тип работы, до/после/процесс)',
  'Какая цель поста?\n\n*1* BEFORE/AFTER\n*2* PROCESS\n*3* EDUCATIONAL\n*4* SOCIAL PROOF\n*5* OFFER',
  'Нужно ли написать описание (caption) под фото? (да / нет)',
  'Нужны ли правки к самому изображению — логотип, текст, оформление? (да / нет)',
];

function isReviewRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return (
    lower.includes('проверь фото') ||
    lower.includes('проверь пост') ||
    lower.includes('check photo') ||
    lower.includes('check post') ||
    lower.includes('review photo') ||
    lower.includes('review post') ||
    lower === 'проверь' ||
    lower === 'check'
  );
}

function selectBrand(companyAnswer) {
  const s = companyAnswer.trim();
  return (s === '2' || /longhorn/i.test(s)) ? 'longhorn' : 'hammer';
}

// ---------------------------------------------------------------------------
// Strategy flow
// ---------------------------------------------------------------------------

const STRATEGY_QUESTIONS = [
  'Для какой компании строим стратегию?\n\n*1* — Hammer Remodeling (Chicago)\n*2* — Longhorn Construction (Austin, TX)\n*3* — Обе компании',
  'На какой период?\n\n*1* — 1 неделя\n*2* — 2 недели\n*3* — 1 месяц',
  'Сколько постов в неделю планируешь?',
  'Есть ли сейчас активные акции или спецпредложения? (опиши или напиши "нет")',
  'Какие типы контента сейчас работают лучше всего? (или напиши "не знаю")',
];

async function generateContentStrategy(answers) {
  const [companyAnswer, period, postsPerWeek, promos, bestContent] = answers;

  const bothCompanies = companyAnswer.trim() === '3' || /обе/i.test(companyAnswer);
  const brand = selectBrand(companyAnswer);
  const brandKnowledge = bothCompanies
    ? `${BRAND_KNOWLEDGE}\n\n---\n\n${LONGHORN_BRAND_KNOWLEDGE}`
    : brand === 'longhorn' ? LONGHORN_BRAND_KNOWLEDGE : BRAND_KNOWLEDGE;

  const strategyPrompt = `You are a senior social media strategist specializing in home remodeling businesses. Build a complete content strategy based on the inputs below.

${brandKnowledge}

${MARKETING_RULES}

User inputs:
- Company: ${companyAnswer}
- Period: ${period}
- Posts per week: ${postsPerWeek}
- Active promos/offers: ${promos}
- Best performing content so far: ${bestContent}

Generate a complete, actionable content strategy. Respond ENTIRELY in Russian -- EXCEPT post captions and any English copy which must be in English.

Be concise and specific. No generic advice. Everything must be tailored to the company, market, and inputs above.

**1. Контент-микс (соотношение типов)**
Show the recommended weekly ratio as a short table:
| Тип | % | Кол-во/нед |
List BEFORE/AFTER, PROCESS, EDUCATIONAL, SOCIAL PROOF, OFFER with rationale in one sentence each.

**2. Контент-план по дням**
For each day that has a post, provide:
- День и дата (starting from Monday of next week)
- Тип контента
- Идея поста (1 sentence in Russian)
- Готовый caption (in English, following all brand rules: hook + brand pillar + specific detail + CTA + hashtags)

**3. Лучшее время для публикаций**
- Facebook: best days and time windows with brief rationale
- Instagram: best days and time windows with brief rationale
Specific to the target market (Chicago suburbs or Austin TX homeowners).

**4. Хэштег-стратегия**
- Core set (always use)
- Rotation sets by content type (3-4 sets)
- One growth hashtag tip

**5. Тактики роста для рынка**
${bothCompanies ? '- Chicago suburbs (Hammer Remodeling): 3 specific tactics\n- Austin TX (Longhorn Construction): 3 specific tactics' : '3-4 specific growth tactics for this market. Local Facebook groups, Nextdoor, neighborhood-specific approaches.'}

**6. Отстройка от конкурентов**
2-3 specific content angles that directly counter competitors' positioning. What to say that they can't.

**7. Приоритет на эту неделю**
Top 3 actions to take right now, in order of impact.`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: strategyPrompt,
    messages: [{ role: 'user', content: `Build the strategy for: company=${companyAnswer}, period=${period}, posts/week=${postsPerWeek}, promos=${promos}, best content=${bestContent}` }],
  });
  return response.content[0].text;
}

async function generateCreativeBrief(imageBase64, answers) {
  const [companyAnswer, photoDesc, postGoal, needsCaptionAnswer, needsEditsAnswer] = answers;
  const brand = selectBrand(companyAnswer);
  const brandKnowledge = brand === 'longhorn' ? LONGHORN_BRAND_KNOWLEDGE : BRAND_KNOWLEDGE;
  const brandName = brand === 'longhorn' ? 'Longhorn Construction' : 'Hammer Remodeling';
  const needsCaption = /да|yes/i.test(needsCaptionAnswer);
  const needsEdits = /да|yes/i.test(needsEditsAnswer);

  const briefPrompt = `You are a senior marketing expert for ${brandName}. Generate a creative brief for a social media post based on the photo and context below.

${brandKnowledge}

${MARKETING_RULES}

Context provided by user:
- Photo: ${photoDesc}
- Post goal / content type: ${postGoal}
- Caption needed: ${needsCaptionAnswer}
- Image editing needed: ${needsEditsAnswer}

Be concise and punchy like a busy creative director. Short bullet points. One sentence per point. No fluff.
Respond ENTIRELY in Russian -- EXCEPT the caption and image editing instructions which must be as specified below.

**Анализ фото:**
- Пригодность для поста и соответствие цели (${postGoal}) ✅/❌
- Эмоциональный отклик и соответствие бренду ✅/❌
- Реальное фото с объекта (не сток, не AI) ✅/❌

**Оценка: X/10** -- одно предложение.

${needsEdits ? IMAGE_EDITING_SECTION : ''}

**Платформы:**
- *Facebook:* главное сообщение в тексте описания, фото дополняет
- *Instagram:* главное сообщение на самом изображении, описание добавляет детали

${CLARIFYING_QUESTIONS_RULE}

${needsCaption ? `After the analysis, output the ready-to-publish caption between these exact markers (no other text on those lines):
CAPTION_START
[English caption: strong hook + brand pillar + specific detail + CTA matching funnel stage for "${postGoal}" + correct hashtags for ${brandName}. No vague phrases.]
CAPTION_END` : 'CAPTION_START\n\nCAPTION_END'}`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: briefPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Photo: ${photoDesc}\nPost goal: ${postGoal}` },
      ],
    }],
  });

  const raw = response.content[0].text;
  const captionMatch = raw.match(/CAPTION_START\n([\s\S]*?)\nCAPTION_END/);
  const caption = captionMatch ? captionMatch[1].trim() : '';
  const displayText = raw.replace(/CAPTION_START[\s\S]*?CAPTION_END\n?/, '').trim();

  let fullDisplay = displayText;
  if (caption) {
    fullDisplay += `\n\n**Caption для публикации:**\n${caption}`;
  }
  fullDisplay += '\n\nОтветьте *ok* чтобы опубликовать на Facebook и Instagram, или напишите правки.';

  return { displayText: fullDisplay, caption };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function publishToFacebook(text, media) {
  if (media) {
    if (media.type === 'photo') {
      const fileLink = await bot.getFileLink(media.fileId);
      const imageData = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const formData = new (require('form-data'))();
      formData.append('source', Buffer.from(imageData.data), { filename: 'photo.jpg', contentType: 'image/jpeg' });
      formData.append('caption', text);
      formData.append('access_token', FB_PAGE_ACCESS_TOKEN);
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`,
        formData,
        { headers: formData.getHeaders() }
      );
      return res.data;
    } else if (media.type === 'video') {
      const fileLink = await bot.getFileLink(media.fileId);
      const videoData = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const formData = new (require('form-data'))();
      formData.append('source', Buffer.from(videoData.data), { filename: 'video.mp4', contentType: 'video/mp4' });
      formData.append('description', text);
      formData.append('access_token', FB_PAGE_ACCESS_TOKEN);
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/videos`,
        formData,
        { headers: formData.getHeaders() }
      );
      return res.data;
    }
  }
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
    { message: text, access_token: FB_PAGE_ACCESS_TOKEN }
  );
  return res.data;
}

async function publishToInstagram(text, fileId) {
  if (!IG_BUSINESS_ACCOUNT_ID) {
    return { skipped: true, reason: 'IG_BUSINESS_ACCOUNT_ID not configured' };
  }
  // Instagram requires a publicly accessible image URL
  const imageUrl = await bot.getFileLink(fileId);

  // Step 1: create media container
  const containerRes = await axios.post(
    `https://graph.facebook.com/v19.0/${IG_BUSINESS_ACCOUNT_ID}/media`,
    { image_url: imageUrl, caption: text, access_token: FB_PAGE_ACCESS_TOKEN }
  );

  // Step 2: publish the container
  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${IG_BUSINESS_ACCOUNT_ID}/media_publish`,
    { creation_id: containerRes.data.id, access_token: FB_PAGE_ACCESS_TOKEN }
  );

  return publishRes.data;
}

async function publishToBoth(text, media) {
  const results = { facebook: null, instagram: null, errors: [] };

  try {
    results.facebook = await publishToFacebook(text, media);
  } catch (err) {
    results.errors.push(`Facebook: ${err.response?.data?.error?.message || err.message}`);
  }

  if (media?.type === 'photo' && media.fileId) {
    try {
      results.instagram = await publishToInstagram(text, media.fileId);
    } catch (err) {
      results.errors.push(`Instagram: ${err.response?.data?.error?.message || err.message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Regular post flow (non-interview)
// ---------------------------------------------------------------------------

const POST_REVIEW_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Review the following Facebook post draft.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the "Suggested post:" section which must always be in English.

**Анализ текста:**
1. Столп бренда ✅/❌
2. Страх клиента ✅/❌
3. Хук ✅/❌
4. Лексика (нет клише) ✅/❌
5. Аудитория (пригороды Чикаго) ✅/❌
6. Конкретный пригород ✅/❌
7. Тип контента: before/after / process / educational / social proof / offer
8. Воронка + глубина CTA ✅/❌
9. Один способ связи ✅/❌
10. Хештеги (обязательные + локальные) ✅/❌
11. Грамматика ✅/❌

**Оценка: X/10** -- одно предложение: главная проблема или главный плюс.

**Suggested post:** (in English -- strong hook, brand pillar, client fear, specific suburb, concrete numbers, correct CTA depth, single contact, correct hashtags, no vague phrases)

Завершить: "Ответьте *ok* для публикации или напишите правки."`;

const POST_REVIEW_WITH_PHOTO_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Photo + caption review. Busy creative director style: short, direct, punchy. One sentence per point. No fluff.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the "Suggested post:" section which must be in English.

**Фото:**
1. Реальное фото с объекта ✅/❌
2. Качество (резкость, свет, композиция) ✅/❌
3. Тема (ремонт/стройка) ✅/❌
4. Чистый кадр ✅/❌
5. Трансформация/результат виден ✅/❌
6. Эмоциональный отклик ✅/❌
7. Соответствие бренду ✅/❌

${IMAGE_EDITING_SECTION}

**Продвижение:**
- Тип контента: before/after / process / educational / social proof / offer
- Воронка + глубина CTA (Правила 4-5)
- Facebook vs Instagram (Правило 7)

**Подпись:**
1. Столп бренда ✅/❌
2. Страх клиента ✅/❌
3. Хук ✅/❌
4. Лексика (нет клише) ✅/❌
5. Аудитория (пригороды Чикаго) ✅/❌
6. Конкретный пригород ✅/❌
7. Этап воронки ✅/❌
8. Глубина CTA ✅/❌
9. Один способ связи ✅/❌
10. Facebook-структура ✅/❌
11. Хештеги ✅/❌
12. Тон (без клише) ✅/❌
13. Грамматика ✅/❌

**Оценка: X/10** -- одно предложение.

**Suggested post:** (in English -- strong hook, brand pillar, client fear, specific suburb, concrete numbers, correct CTA depth, single contact, correct hashtags)

${CLARIFYING_QUESTIONS_RULE}

Завершить: "Ответьте *ok* для публикации или напишите правки."`;

const POST_APPLY_CORRECTION_PROMPT = `You are a social media copywriter for Hammer Remodeling LLC.

${BRAND_KNOWLEDGE}

The user has a Facebook post draft and wants to apply corrections to it. Given the original post and the user's correction instructions, produce only the updated post text in English -- nothing else, no explanations, no labels. The updated post must still follow brand rules: no vague phrases, at least one brand pillar, specific suburb if relevant, correct hashtag sets.`;

const PHOTO_CAPTION_SUGGEST_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Photo without caption -- analyze and write the single best caption. Busy creative director style: short, direct, punchy. One sentence per point.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the caption itself which must be in English.

**Фото:**
1. Реальное фото с объекта ✅/❌
2. Качество (резкость, свет, композиция) ✅/❌
3. Тема (ремонт/стройка) ✅/❌
4. Чистый кадр ✅/❌
5. Трансформация/результат виден ✅/❌
6. Эмоциональный отклик ✅/❌
7. Соответствие бренду ✅/❌

**Потенциал: X/10** -- одно предложение.

${IMAGE_EDITING_SECTION}

**Продвижение:**
- Тип контента: before/after / process / educational / social proof / offer
- Воронка + глубина CTA (Правила 4-5)
- Facebook vs Instagram (Правило 7)

**Предлагаемая подпись:**
[Single best English caption: strong hook, brand pillar, specific detail or number, CTA matching funnel stage, correct hashtags. No vague phrases.]

${CLARIFYING_QUESTIONS_RULE}

Завершить (на русском): "Если не подходит -- напишите что изменить."`;

// ---------------------------------------------------------------------------
// General conversation system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Ulik's senior marketing partner and personal assistant. Ulik owns Hammer Remodeling LLC (Chicago suburbs) and Longhorn Construction (Austin, TX). You know both businesses inside out.

${BRAND_KNOWLEDGE}

---

${LONGHORN_BRAND_KNOWLEDGE}

---

${MARKETING_RULES}

## How you operate

**CONTEXT AWARENESS**
You actively track the entire conversation. Reference specifics from earlier — if a project in Arlington Heights was mentioned, bring it up. If Ulik said he prefers shorter posts, remember that. Build on what was already said instead of treating each message as a blank slate.

**INDEPENDENT THINKING**
You notice things and say them without being asked. Examples of what you proactively bring up:
- "You've been posting mostly PROCESS content — you're missing SOCIAL PROOF which is what actually converts"
- "Third kitchen post this week — mix in an EDUCATIONAL piece before the algorithm starts deprioritizing you"
- "This caption reads too corporate — here's a version that sounds more like a real person built this"
- When asked for a post → also suggest what Story format would complement it
- When a photo has a composition issue → say so and how to fix it in Canva

**NO TEMPLATES, NO GENERIC PHRASES**
Every response is written specifically for this situation. You reference concrete details from the conversation. You are direct, opinionated, and honest — like a senior partner who has skin in the game, not a consultant covering their ass.
- Never: "Great question!", "Absolutely!", "Of course!", filler affirmations
- Never: vague advice without a specific next action
- Never: repeat the user's question back to them

**PROACTIVE INSIGHT**
After completing any task, add one short insight or suggestion the user didn't ask for but would find valuable. Max 1-2 sentences. Make it specific — not "consider using hashtags" but "swap #homeimprovement for #buffalogroveil on this one — more local reach for that price point."

**LANGUAGE**
Respond in the same language Ulik writes in. Russian → Russian. English → English. Mixed → match the dominant language.
`;


// ---------------------------------------------------------------------------
// Claude helpers
// ---------------------------------------------------------------------------

async function reviewPost(postText) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: POST_REVIEW_PROMPT,
    messages: [{ role: 'user', content: postText }],
  });
  return response.content[0].text;
}

async function reviewPostWithPhoto(postText, imageBase64) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: POST_REVIEW_WITH_PHOTO_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Caption: ${postText}` },
      ],
    }],
  });
  return response.content[0].text;
}

async function applyCorrection(originalText, correction, imageBase64 = null) {
  const userContent = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Original post:\n${originalText}\n\nCorrections: ${correction}` },
      ]
    : `Original post:\n${originalText}\n\nCorrections: ${correction}`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: POST_APPLY_CORRECTION_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content[0].text.trim();
}

async function analyzePhotoAndSuggestCaptions(imageBase64) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: PHOTO_CAPTION_SUGGEST_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Please analyze this photo and suggest three caption options.' },
      ],
    }],
  });
  return response.content[0].text;
}

function extractCaption(responseText) {
  // Try to grab the text after the "Предлагаемая подпись:" header
  const match = responseText.match(/\*\*Предлагаемая подпись:\*\*\s*\n([\s\S]*?)(?=\n\n|\n\*\*|$)/);
  if (match) return match[1].trim();
  // Fallback: last line that contains hashtags and is long enough to be a caption
  const lines = responseText.split('\n').filter(l => l.includes('#') && l.length > 40);
  return lines[lines.length - 1]?.trim() || '';
}

function getHistory(chatId) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId);
}

function trimHistory(history, maxMessages = 20) {
  if (history.length > maxMessages) history.splice(0, history.length - maxMessages);
}

const WEB_SEARCH_TOOL = [{ type: 'web_search_20250305', name: 'web_search' }];

function needsWebSearch(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /найди|поищи|поиск|погугли|что сейчас|последние новости|последние|тренды|конкурент|competitor|trends|price|prices|review|reviews|search|find me|look up|what are|latest|current market/.test(t);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function askClaude(chatId, userMessage) {
  await ensureHistoryLoaded(chatId);
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const useSearch = needsWebSearch(userMessage);
  const baseParams = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
  };
  if (useSearch) baseParams.tools = WEB_SEARCH_TOOL;

  // Use a separate array for the multi-turn tool loop
  // so intermediate tool_use/tool_result pairs don't pollute the history cache
  let messages = history.map(m => ({ ...m }));
  let response = await anthropic.messages.create({ ...baseParams, messages });

  // Multi-turn loop: let Claude finish all web searches before returning
  let safetyCounter = 0;
  while (response.stop_reason === 'tool_use' && safetyCounter++ < 5) {
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));
    messages.push({ role: 'user', content: toolResults });
    response = await anthropic.messages.create({ ...baseParams, messages });
  }

  const assistantMessage = extractText(response.content);
  history.push({ role: 'assistant', content: assistantMessage });

  // Persist to DB (fire-and-forget)
  saveMessageToDb(chatId, 'user', userMessage).catch(e => console.error('DB save error:', e.message));
  saveMessageToDb(chatId, 'assistant', assistantMessage).catch(e => console.error('DB save error:', e.message));
  detectAndSavePrefs(chatId, userMessage).catch(e => console.error('Prefs error:', e.message));

  return assistantMessage;
}

async function handlePostFlow(chatId, text, media = null) {
  bot.sendChatAction(chatId, 'typing');
  try {
    const review = media?.imageBase64
      ? await reviewPostWithPhoto(text, media.imageBase64)
      : await reviewPost(text);
    postSessions.set(chatId, { text, pendingMedia: media });
    await bot.sendMessage(chatId, review, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error reviewing post:', err.message);
    bot.sendMessage(chatId, 'Something went wrong while reviewing the post. Please try again.');
  }
}

// Download photo from Telegram and return base64
async function downloadPhoto(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const imageData = await axios.get(fileLink, { responseType: 'arraybuffer' });
  return Buffer.from(imageData.data).toString('base64');
}

// ---------------------------------------------------------------------------
// Facebook Analytics
// ---------------------------------------------------------------------------

async function fetchFbPageInsights() {
  const pageRes = await axios.get(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}`, {
    params: { fields: 'followers_count,fan_count', access_token: FB_PAGE_ACCESS_TOKEN },
  });
  const followers = pageRes.data.followers_count || pageRes.data.fan_count || 0;

  const postsRes = await axios.get(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/posts`, {
    params: {
      fields: 'message,likes.summary(true),comments.summary(true),shares,created_time',
      limit: 10,
      access_token: FB_PAGE_ACCESS_TOKEN,
    },
  });
  const posts = postsRes.data.data || [];
  return { followers, posts };
}

async function generateAnalyticsReport(followers, posts) {
  const postsData = posts.map((p, i) => ({
    index: i + 1,
    message: (p.message || '(no text)').substring(0, 80),
    likes: p.likes?.summary?.total_count || 0,
    comments: p.comments?.summary?.total_count || 0,
    shares: p.shares?.count || 0,
    date: p.created_time?.split('T')[0] || '',
    engagement: (p.likes?.summary?.total_count || 0) + (p.comments?.summary?.total_count || 0) + (p.shares?.count || 0),
  }));

  const sorted = [...postsData].sort((a, b) => b.engagement - a.engagement);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  const analyticsPrompt = `You are a social media analytics expert for Hammer Remodeling LLC.

${BRAND_KNOWLEDGE}

Analyze Facebook Page performance and give specific, actionable recommendations.
Respond entirely in Russian. Be direct and concrete — no generic advice.

Data:
- Followers: ${followers}
- Last 10 posts:
${postsData.map(p => `  Post ${p.index} (${p.date}): 👍${p.likes} 💬${p.comments} 🔁${p.shares} — "${p.message}"`).join('\n')}
- Best post: #${best.index} (${best.engagement} total engagement)
- Worst post: #${worst.index} (${worst.engagement} total engagement)

Format your response as:
**Обзор** — 2-3 предложения об общей картине вовлечённости
**Лучший пост** — что сработало и почему
**Худший пост** — что пошло не так и как исправить
**4 рекомендации** — конкретные действия прямо сейчас
**Следующий пост** — конкретная идея на основе данных`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: analyticsPrompt,
    messages: [{ role: 'user', content: 'Analyze and recommend.' }],
  });

  const table = postsData.map(p => `${p.index}. ${p.date}: 👍${p.likes} 💬${p.comments} 🔁${p.shares}`).join('\n');
  return `📊 *Facebook Analytics*\n\n👥 Подписчики: *${followers}*\n\n*Последние 10 постов:*\n${table}\n\n${response.content[0].text}`;
}

// ---------------------------------------------------------------------------
// Voice transcription
// ---------------------------------------------------------------------------

async function transcribeVoice(audioBuffer) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { Readable } = require('stream');
  const stream = Readable.from(audioBuffer);
  stream.path = 'voice.ogg';
  const response = await openai.audio.transcriptions.create({
    file: stream,
    model: 'whisper-1',
  });
  return response.text.trim();
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function isReminderRequest(text) {
  if (!text) return false;
  return /напомни|remind me|set a? ?reminder|поставь напоминание/i.test(text);
}

async function parseReminderWithClaude(text) {
  const now = new Date().toISOString();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Current UTC time: ${now}

User message: "${text}"

Extract the reminder. Reply ONLY with valid JSON — no markdown, no extra text:
{"text": "what to remind about", "iso": "YYYY-MM-DDTHH:MM:SSZ"}

If you cannot determine a clear future date/time, reply: {"error": "cannot parse"}`,
    }],
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { error: 'parse failed' };
  }
}

async function saveReminder(chatId, reminderText, remindAt) {
  const res = await pool.query(
    'INSERT INTO reminders (chat_id, reminder_text, remind_at) VALUES ($1, $2, $3) RETURNING id',
    [chatId, reminderText, remindAt]
  );
  return res.rows[0].id;
}

async function listReminders(chatId) {
  const res = await pool.query(
    `SELECT id, reminder_text, remind_at FROM reminders
     WHERE chat_id = $1 AND NOT sent AND remind_at > NOW()
     ORDER BY remind_at`,
    [chatId]
  );
  return res.rows;
}

async function cancelReminderById(chatId, id) {
  const res = await pool.query(
    'UPDATE reminders SET sent = TRUE WHERE id = $1 AND chat_id = $2 AND NOT sent',
    [id, chatId]
  );
  return res.rowCount > 0;
}

async function checkAndSendReminders() {
  try {
    const res = await pool.query(
      'SELECT id, chat_id, reminder_text FROM reminders WHERE NOT sent AND remind_at <= NOW()'
    );
    for (const row of res.rows) {
      try {
        await bot.sendMessage(row.chat_id, `⏰ *Напоминание:* ${row.reminder_text}`, { parse_mode: 'Markdown' });
        await pool.query('UPDATE reminders SET sent = TRUE WHERE id = $1', [row.id]);
      } catch (err) {
        console.error(`Failed to send reminder ${row.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Reminder check error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Document analysis
// ---------------------------------------------------------------------------

async function analyzeDocument(docBuffer, mimeType, filename, userQuestion) {
  const isPdf = mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
  const isDocx = filename.toLowerCase().endsWith('.docx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const systemPrompt = `You are Ulik's senior marketing partner and analyst.

${BRAND_KNOWLEDGE}

Analyze the document provided and give actionable insights for a remodeling business owner.
- Contracts: check terms, payment schedule, scope, red flags
- Estimates: check pricing, completeness, market rates
- Briefs: check clarity, requirements, feasibility
- Marketing materials: check brand alignment, effectiveness

Be concise and specific. Respond in the same language the user writes in.`;

  const question = userQuestion || 'Проанализируй этот документ. Выдели ключевые моменты, риски и рекомендации.';
  let messageContent;

  if (isPdf) {
    messageContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docBuffer.toString('base64') } },
      { type: 'text', text: question },
    ];
  } else {
    let textContent = '';
    if (isDocx) {
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer: docBuffer });
        textContent = result.value;
      } catch {
        textContent = `[Could not extract DOCX text from ${filename}]`;
      }
    } else {
      textContent = docBuffer.toString('utf-8');
    }
    messageContent = `Файл: ${filename}\n\nСодержимое:\n${textContent.substring(0, 12000)}\n\n${question}`;
  }

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }],
  });
  return response.content[0].text;
}

// ---------------------------------------------------------------------------
// Video analysis
// ---------------------------------------------------------------------------

async function extractVideoFrames(videoBuffer, intervalSeconds = 5) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgvid-'));
  const inputPath = path.join(tmpDir, 'input.mp4');
  const framesPattern = path.join(tmpDir, 'frame_%03d.jpg');

  try {
    fs.writeFileSync(inputPath, videoBuffer);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i', inputPath,
        '-vf', `fps=1/${intervalSeconds},scale=960:-1`,
        '-frames:v', '10',
        '-q:v', '5',
        framesPattern, '-y',
      ]);
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      ff.on('error', (err) => reject(new Error(`ffmpeg not found: ${err.message}`)));
    });

    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
      .sort()
      .map(f => fs.readFileSync(path.join(tmpDir, f)).toString('base64'));

    return frames;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function analyzeVideoContent(frames, caption) {
  const contentParts = frames.slice(0, 8).map(f => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: f },
  }));
  contentParts.push({
    type: 'text',
    text: caption
      ? `Video caption: "${caption}"\n\nAnalyze the frames above and give a marketing creative brief.`
      : 'Analyze these video frames and give a marketing creative brief.',
  });

  const videoPrompt = `You are a senior marketing expert for Hammer Remodeling LLC / Longhorn Construction.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Analyze the video frames and produce a creative brief.
Respond entirely in Russian — except the caption which must be in English.
Short, punchy, creative director style.

**Анализ видео:**
- Что показано (тип работы, этап)
- Качество съёмки (свет, стабильность, ракурс) ✅/❌
- Маркетинговый потенциал: X/10

${IMAGE_EDITING_SECTION}

**Для публикации:**
- Платформа: Facebook / Instagram Reels / оба
- Тип контента: before/after / process / educational / social proof / offer
- Воронка + глубина CTA

**Caption (English):**
[Strong hook + brand pillar + specific detail + CTA + hashtags]

Завершить: "Ответьте *ok* чтобы опубликовать, или напишите правки."`;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: videoPrompt,
    messages: [{ role: 'user', content: contentParts }],
  });
  return response.content[0].text;
}

async function downloadTelegramFile(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const res = await axios.get(fileLink, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ---------------------------------------------------------------------------
// Bot commands
// ---------------------------------------------------------------------------

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(
    chatId,
    `Hey ${name}! I'm your personal assistant and marketing expert.\n\nI work with:\n• Hammer Remodeling LLC (Chicago)\n• Longhorn Construction (Austin, TX)\n\n*What I can do:*\n• Photo + "проверь фото" → creative brief interview\n• Photo with caption → direct review & publish\n• Photo only → caption suggestions\n• Voice message → transcribe & respond\n• Video → analyze frames & brief\n• PDF/DOCX/TXT → analyze document\n• "напомни мне..." → set a reminder\n\nType /help for all commands.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, []);
  dbHistoryLoaded.delete(chatId);
  interviewSessions.delete(chatId);
  captionSessions.delete(chatId);
  postSessions.delete(chatId);
  strategySessions.delete(chatId);
  try {
    await pool.query('DELETE FROM conversations WHERE chat_id = $1', [chatId]);
  } catch (err) {
    console.error('Failed to clear DB history:', err.message);
  }
  bot.sendMessage(chatId, 'All sessions cleared. Fresh start!');
});

// ---------------------------------------------------------------------------
// Unsplash photo search
// ---------------------------------------------------------------------------

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';

function isPhotoSearchRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /найди\s+(фото|картинк|изображени|примеры?|снимк)|покажи\s+(фото|картинк|изображени|примеры?|снимк)|нужны?\s+(фото|картинк|изображени)|есть\s+(фото|картинк)|пришли\s+(фото|картинк)|find\s+(me\s+)?(a\s+)?(photo|picture|image|example)|show\s+(me\s+)?(a\s+)?(photo|picture|image|example)|search\s+(for\s+)?(photo|picture|image)/.test(t);
}

async function extractPhotoQuery(text) {
  const res = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: `Extract the photo search subject from this message and return ONLY a short English search query (2-5 words, no punctuation) suitable for a stock photo site:\n\n"${text}"`,
    }],
  });
  return res.content[0].text.trim().replace(/^["'`]|["'`]$/g, '');
}

async function searchUnsplashPhotos(query) {
  if (!UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY не настроен');
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&client_id=${UNSPLASH_ACCESS_KEY}`;
  const res = await axios.get(url);
  return res.data.results.map(p => ({
    url: p.urls.regular,
    description: p.description || p.alt_description || query,
    author: p.user.name,
    authorLink: p.user.links.html,
  }));
}

function buildPhotoMessage(photos, query) {
  if (photos.length === 0) return `Не нашёл фото по запросу "${query}". Попробуй другое описание.`;
  let msg = `Фото по запросу: ${query}\n\n`;
  photos.forEach(p => {
    msg += `${p.url}\n`;
  });
  msg += `\nНапиши "не подходит" или "другие" — найду с другими ключевыми словами.`;
  return msg;
}

bot.onText(/\/findphoto (.+)/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1].trim();
  bot.sendChatAction(chatId, 'typing');
  try {
    const photos = await searchUnsplashPhotos(query);
    photoSearchSessions.set(chatId, { query, usedQueries: [query] });
    await bot.sendMessage(chatId, buildPhotoMessage(photos, query));
  } catch (err) {
    console.error('Unsplash error:', err.message);
    bot.sendMessage(chatId, `Ошибка при поиске фото: ${err.message}`);
  }
});

bot.onText(/\/findphoto$/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Укажи описание: /findphoto закат над горами');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*Available commands:*\n\n/start — Welcome\n/clear — Clear all sessions and history\n/post [text] — Review & publish a text post\n/strategy — Build a content strategy (interview)\n/analytics — Facebook Page insights & recommendations\n/reminders — List your active reminders\n/cancelreminder [id] — Cancel a reminder by ID\n/findphoto [description] — Search free photos on Unsplash\n/help — This message\n\n*Photo flows:*\n• Photo + "проверь фото" → interview & creative brief\n• Photo + caption → direct review & publish\n• Photo only → caption suggestions\n\n*Other:*\n• Voice message → transcribe & respond\n• Video → frame analysis & creative brief\n• PDF/DOCX/TXT → document analysis\n• "напомни мне X в Y" → set a reminder\n• After /findphoto: "не подходит" или "другие" → new search`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/post (.+)/s, async (msg, match) => {
  const chatId = msg.chat.id;
  await handlePostFlow(chatId, match[1].trim());
});

bot.onText(/\/strategy/, (msg) => {
  const chatId = msg.chat.id;
  strategySessions.set(chatId, { step: 1, answers: [] });
  bot.sendMessage(chatId, STRATEGY_QUESTIONS[0], { parse_mode: 'Markdown' });
});

bot.onText(/\/analytics/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  try {
    const { followers, posts } = await fetchFbPageInsights();
    if (posts.length === 0) {
      bot.sendMessage(chatId, 'Не найдено постов на странице. Проверь FB_PAGE_ACCESS_TOKEN и FB_PAGE_ID.');
      return;
    }
    const report = await generateAnalyticsReport(followers, posts);
    const CHUNK = 4000;
    for (let i = 0; i < report.length; i += CHUNK) {
      await bot.sendMessage(chatId, report.slice(i, i + CHUNK), { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Analytics error:', err.response?.data || err.message);
    const detail = err.response?.data?.error?.message || err.message;
    bot.sendMessage(chatId, `Ошибка при получении аналитики: ${detail}`);
  }
});

bot.onText(/\/reminders/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const rows = await listReminders(chatId);
    if (rows.length === 0) {
      bot.sendMessage(chatId, 'Нет активных напоминаний.');
      return;
    }
    const list = rows.map(r => {
      const dt = new Date(r.remind_at);
      const formatted = dt.toLocaleString('ru-RU', { timeZone: 'America/Chicago', dateStyle: 'short', timeStyle: 'short' });
      return `*${r.id}.* ${r.reminder_text} — _${formatted}_`;
    }).join('\n');
    bot.sendMessage(chatId, `⏰ *Твои напоминания:*\n\n${list}\n\nОтмени командой /cancelreminder [id]`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('List reminders error:', err.message);
    bot.sendMessage(chatId, 'Ошибка при загрузке напоминаний.');
  }
});

bot.onText(/\/cancelreminder\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const id = parseInt(match[1]);
  try {
    const ok = await cancelReminderById(chatId, id);
    bot.sendMessage(chatId, ok ? `✅ Напоминание #${id} отменено.` : `Напоминание #${id} не найдено или уже отправлено.`);
  } catch (err) {
    console.error('Cancel reminder error:', err.message);
    bot.sendMessage(chatId, 'Ошибка при отмене напоминания.');
  }
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // ── PHOTO ──────────────────────────────────────────────────────────────────
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendChatAction(chatId, 'typing');

    let imageBase64;
    try {
      imageBase64 = await downloadPhoto(fileId);
    } catch (err) {
      console.error('Error downloading photo:', err.message);
      bot.sendMessage(chatId, 'Could not download the photo. Please try again.');
      return;
    }

    // Review request trigger → start interview
    if (isReviewRequest(msg.caption)) {
      interviewSessions.set(chatId, { step: 1, answers: [], pendingMedia: { type: 'photo', fileId, imageBase64 } });
      await bot.sendMessage(chatId, INTERVIEW_QUESTIONS[0], { parse_mode: 'Markdown' });
      return;
    }

    if (msg.caption) {
      // Photo WITH caption → direct review flow
      await handlePostFlow(chatId, msg.caption, { type: 'photo', fileId, imageBase64 });
    } else {
      // Photo WITHOUT caption → caption suggestions
      try {
        const suggestionResponse = await analyzePhotoAndSuggestCaptions(imageBase64);
        const caption = extractCaption(suggestionResponse);
        captionSessions.set(chatId, { caption, pendingMedia: { type: 'photo', fileId, imageBase64 } });
        await bot.sendMessage(chatId, suggestionResponse, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error suggesting captions:', err.message);
        bot.sendMessage(chatId, 'Something went wrong while analyzing the photo. Please try again.');
      }
    }
    return;
  }

  // ── VOICE ──────────────────────────────────────────────────────────────────
  if (msg.voice) {
    bot.sendChatAction(chatId, 'typing');
    try {
      const audioBuffer = await downloadTelegramFile(msg.voice.file_id);
      const transcribed = await transcribeVoice(audioBuffer);
      await bot.sendMessage(chatId, `🎤 _"${transcribed}"_`, { parse_mode: 'Markdown' });
      // Process as regular message
      const reply = await askClaude(chatId, transcribed);
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Voice error:', err.message);
      bot.sendMessage(chatId, 'Не удалось расшифровать голосовое сообщение. Попробуй ещё раз.');
    }
    return;
  }

  // ── DOCUMENT ───────────────────────────────────────────────────────────────
  if (msg.document) {
    const doc = msg.document;
    const fname = doc.file_name || 'document';
    const mime = doc.mime_type || 'application/octet-stream';
    const supported = /\.(pdf|docx|txt)$/i.test(fname) ||
      mime === 'application/pdf' ||
      mime === 'text/plain' ||
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (!supported) {
      bot.sendMessage(chatId, `Поддерживаемые форматы: PDF, DOCX, TXT. Получен: ${fname}`);
      return;
    }

    bot.sendChatAction(chatId, 'typing');
    try {
      const docBuffer = await downloadTelegramFile(doc.file_id);
      const analysis = await analyzeDocument(docBuffer, mime, fname, msg.caption || '');
      const CHUNK = 4000;
      for (let i = 0; i < analysis.length; i += CHUNK) {
        await bot.sendMessage(chatId, analysis.slice(i, i + CHUNK), { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error('Document analysis error:', err.message);
      bot.sendMessage(chatId, `Ошибка при анализе документа: ${err.message}`);
    }
    return;
  }

  // ── VIDEO ──────────────────────────────────────────────────────────────────
  if (msg.video || msg.video_note) {
    const videoFileId = msg.video ? msg.video.file_id : msg.video_note.file_id;
    const caption = msg.caption || '';

    // Caption triggers post review flow (existing behaviour)
    if (msg.video && caption && !isReviewRequest(caption)) {
      await handlePostFlow(chatId, caption, { type: 'video', fileId: videoFileId });
      return;
    }

    // Review request or no caption → analyze frames
    bot.sendChatAction(chatId, 'upload_video');
    try {
      const videoBuffer = await downloadTelegramFile(videoFileId);
      await bot.sendMessage(chatId, '⏳ Извлекаю кадры и анализирую видео...');
      bot.sendChatAction(chatId, 'typing');
      const frames = await extractVideoFrames(videoBuffer, 5);
      if (frames.length === 0) throw new Error('No frames extracted — is ffmpeg installed?');
      const brief = await analyzeVideoContent(frames, caption);
      // Store for potential publish
      postSessions.set(chatId, { text: '', pendingMedia: { type: 'video', fileId: videoFileId }, publishBoth: false });
      await bot.sendMessage(chatId, brief, { parse_mode: 'Markdown' });
      // If review request, also start interview
      if (isReviewRequest(caption)) {
        interviewSessions.set(chatId, { step: 1, answers: [], pendingMedia: { type: 'video', fileId: videoFileId, imageBase64: frames[0] } });
        await bot.sendMessage(chatId, INTERVIEW_QUESTIONS[0], { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error('Video analysis error:', err.message);
      bot.sendMessage(chatId, `Ошибка при анализе видео: ${err.message}`);
    }
    return;
  }

  // ── TEXT ONLY ──────────────────────────────────────────────────────────────
  if (!text || text.startsWith('/')) return;

  // ── PHOTO SEARCH SESSION ───────────────────────────────────────────────────
  if (photoSearchSessions.has(chatId) && text) {
    const normalized = text.trim().toLowerCase();
    if (normalized === 'не подходит' || normalized === 'другие' || normalized === 'ещё' || normalized === 'еще') {
      const session = photoSearchSessions.get(chatId);
      bot.sendChatAction(chatId, 'typing');
      try {
        // Ask Claude to suggest an alternative query
        const altRes = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: `Suggest ONE alternative English search query for stock photos related to "${session.query}". Already tried: ${session.usedQueries.join(', ')}. Reply with ONLY the query, no explanation.`,
          }],
        });
        const altQuery = altRes.content[0].text.trim().replace(/^["']|["']$/g, '');
        session.usedQueries.push(altQuery);
        photoSearchSessions.set(chatId, session);
        const photos = await searchUnsplashPhotos(altQuery);
        await bot.sendMessage(chatId, buildPhotoMessage(photos, altQuery));
      } catch (err) {
        console.error('Unsplash retry error:', err.message);
        bot.sendMessage(chatId, `Ошибка при поиске: ${err.message}`);
      }
      return;
    } else {
      // User moved on — clear session
      photoSearchSessions.delete(chatId);
    }
  }

  // ── STRATEGY SESSION ──────────────────────────────────────────────────────
  if (strategySessions.has(chatId)) {
    const session = strategySessions.get(chatId);
    session.answers.push(text.trim());

    if (session.step < 5) {
      session.step++;
      await bot.sendMessage(chatId, STRATEGY_QUESTIONS[session.step - 1], { parse_mode: 'Markdown' });
    } else {
      strategySessions.delete(chatId);
      upsertUserPrefs(chatId, { companyPreference: session.answers[0] }).catch(e => console.error('Prefs error:', e.message));
      bot.sendChatAction(chatId, 'typing');
      try {
        const strategy = await generateContentStrategy(session.answers);
        // Strategy can be long -- split into chunks if needed to avoid Telegram 4096-char limit
        const CHUNK = 4000;
        for (let i = 0; i < strategy.length; i += CHUNK) {
          await bot.sendMessage(chatId, strategy.slice(i, i + CHUNK), { parse_mode: 'Markdown' });
        }
      } catch (err) {
        console.error('Error generating strategy:', err.message);
        bot.sendMessage(chatId, 'Something went wrong generating the strategy. Please try again.');
      }
    }
    return;
  }

  // ── INTERVIEW SESSION ──────────────────────────────────────────────────────
  if (interviewSessions.has(chatId)) {
    const session = interviewSessions.get(chatId);
    session.answers.push(text.trim());

    if (session.step < 5) {
      session.step++;
      await bot.sendMessage(chatId, INTERVIEW_QUESTIONS[session.step - 1], { parse_mode: 'Markdown' });
    } else {
      // All 5 answers collected -- generate brief
      interviewSessions.delete(chatId);
      upsertUserPrefs(chatId, { companyPreference: selectBrand(session.answers[0]) }).catch(e => console.error('Prefs error:', e.message));
      bot.sendChatAction(chatId, 'typing');
      try {
        const { displayText, caption } = await generateCreativeBrief(session.pendingMedia.imageBase64, session.answers);
        // Store in postSessions for publish/correction flow
        postSessions.set(chatId, {
          text: caption,
          pendingMedia: session.pendingMedia,
          publishBoth: true,
          interviewAnswers: session.answers,
        });
        await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error generating brief:', err.message);
        bot.sendMessage(chatId, 'Something went wrong generating the brief. Please try again.');
      }
    }
    return;
  }

  // ── CAPTION SELECTION SESSION ──────────────────────────────────────────────
  if (captionSessions.has(chatId)) {
    const session = captionSessions.get(chatId);

    // Check if user is triggering a review interview instead
    if (isReviewRequest(text)) {
      captionSessions.delete(chatId);
      interviewSessions.set(chatId, { step: 1, answers: [], pendingMedia: session.pendingMedia });
      await bot.sendMessage(chatId, INTERVIEW_QUESTIONS[0], { parse_mode: 'Markdown' });
      return;
    }

    const normalized = text.trim().toLowerCase();

    if (normalized === 'ok' || normalized === 'ок') {
      // User approved the caption -- move to post review flow
      captionSessions.delete(chatId);
      await handlePostFlow(chatId, session.caption, session.pendingMedia);
    } else {
      // Any other reply is a correction request -- regenerate with feedback
      captionSessions.delete(chatId);
      bot.sendChatAction(chatId, 'typing');
      try {
        const updatedResponse = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          system: PHOTO_CAPTION_SUGGEST_PROMPT,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: session.pendingMedia.imageBase64 } },
              { type: 'text', text: `Correction request: ${text}` },
            ],
          }],
        });
        const newResponse = updatedResponse.content[0].text;
        const newCaption = extractCaption(newResponse);
        captionSessions.set(chatId, { caption: newCaption, pendingMedia: session.pendingMedia });
        await bot.sendMessage(chatId, newResponse, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error regenerating caption:', err.message);
        bot.sendMessage(chatId, 'Something went wrong. Please try again.');
      }
    }
    return;
  }

  // ── POST SESSION ───────────────────────────────────────────────────────────
  if (postSessions.has(chatId)) {
    const session = postSessions.get(chatId);
    const normalized = text.trim().toLowerCase();

    if (normalized === 'ok' || normalized === 'ок') {
      postSessions.delete(chatId);
      bot.sendChatAction(chatId, 'typing');

      if (session.publishBoth) {
        const results = await publishToBoth(session.text, session.pendingMedia);
        const fbOk = !!results.facebook;
        const igOk = results.instagram && !results.instagram.skipped;
        const igSkipped = results.instagram?.skipped;
        let reply = '';
        if (fbOk) reply += 'Facebook ✅\n';
        else reply += 'Facebook ❌\n';
        if (igOk) reply += 'Instagram ✅';
        else if (igSkipped) reply += 'Instagram ⏭ (IG_BUSINESS_ACCOUNT_ID не настроен)';
        else reply += 'Instagram ❌';
        if (results.errors.length) reply += `\n\nОшибки:\n${results.errors.join('\n')}`;
        bot.sendMessage(chatId, reply);
        if (results.facebook) savePublishedPost(chatId, session.text, 'facebook').catch(e => console.error('DB error:', e.message));
        if (results.instagram && !results.instagram?.skipped) savePublishedPost(chatId, session.text, 'instagram').catch(e => console.error('DB error:', e.message));
      } else {
        try {
          await publishToFacebook(session.text, session.pendingMedia);
          bot.sendMessage(chatId, 'Posted to Facebook successfully!');
          savePublishedPost(chatId, session.text, 'facebook').catch(e => console.error('DB error:', e.message));
        } catch (err) {
          console.error('Facebook publish error:', err.response?.data || err.message);
          bot.sendMessage(chatId, `Failed to publish: ${err.response?.data?.error?.message || err.message}`);
        }
      }
    } else {
      // Correction
      postSessions.delete(chatId);
      bot.sendChatAction(chatId, 'typing');
      try {
        if (session.publishBoth && session.interviewAnswers) {
          // Re-generate brief with correction applied to caption
          const updatedCaption = await applyCorrection(session.text || '', text, session.pendingMedia?.imageBase64 ?? null);
          const { displayText, caption } = await generateCreativeBrief(
            session.pendingMedia.imageBase64,
            session.interviewAnswers
          );
          // Use corrected caption if Claude produced one, otherwise use applyCorrection result
          const finalCaption = caption || updatedCaption;
          postSessions.set(chatId, { ...session, text: finalCaption });
          await bot.sendMessage(chatId, displayText, { parse_mode: 'Markdown' });
        } else {
          const updatedText = await applyCorrection(session.text, text, session.pendingMedia?.imageBase64 ?? null);
          await handlePostFlow(chatId, updatedText, session.pendingMedia);
        }
      } catch (err) {
        console.error('Error applying correction:', err.message);
        bot.sendMessage(chatId, 'Something went wrong while applying corrections. Please try again.');
      }
    }
    return;
  }

  // ── REVIEW REQUEST without photo context ───────────────────────────────────
  if (isReviewRequest(text)) {
    bot.sendMessage(chatId, 'Пожалуйста, отправьте фото вместе с этим сообщением или прикрепите фото и напишите "проверь фото" под ним.');
    return;
  }

  // ── PHOTO SEARCH REQUEST (natural language) ────────────────────────────────
  if (isPhotoSearchRequest(text)) {
    bot.sendChatAction(chatId, 'typing');
    try {
      const query = await extractPhotoQuery(text);
      const photos = await searchUnsplashPhotos(query);
      photoSearchSessions.set(chatId, { query, usedQueries: [query] });
      await bot.sendMessage(chatId, buildPhotoMessage(photos, query));
    } catch (err) {
      console.error('Photo search error:', err.message);
      bot.sendMessage(chatId, `Ошибка при поиске фото: ${err.message}`);
    }
    return;
  }

  // ── REMINDER REQUEST ───────────────────────────────────────────────────────
  if (isReminderRequest(text)) {
    bot.sendChatAction(chatId, 'typing');
    try {
      const parsed = await parseReminderWithClaude(text);
      if (parsed.error) {
        bot.sendMessage(chatId, 'Не смог разобрать дату/время напоминания. Попробуй: "напомни мне позвонить клиенту через 2 часа" или "напомни завтра в 10:00 проверить смету".');
      } else {
        const id = await saveReminder(chatId, parsed.text, parsed.iso);
        const dt = new Date(parsed.iso);
        const formatted = dt.toLocaleString('ru-RU', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
        bot.sendMessage(chatId, `✅ Напоминание #${id} сохранено:\n*${parsed.text}*\n🕐 ${formatted}`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      console.error('Reminder save error:', err.message);
      bot.sendMessage(chatId, 'Ошибка при сохранении напоминания. Попробуй ещё раз.');
    }
    return;
  }

  // ── REGULAR CONVERSATION ───────────────────────────────────────────────────
  bot.sendChatAction(chatId, 'typing');
  try {
    const reply = await askClaude(chatId, text);
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error calling Claude API:', err.message);
    if (err.status === 401) {
      bot.sendMessage(chatId, 'API key error. Please check ANTHROPIC_API_KEY.');
    } else if (err.status === 429) {
      bot.sendMessage(chatId, 'Too many requests. Please wait a moment.');
    } else {
      bot.sendMessage(chatId, 'Something went wrong. Please try again.');
    }
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

initDb().catch(err => console.error('DB init failed:', err.message));
setInterval(checkAndSendReminders, 60 * 1000);
console.log('Bot is running...');
