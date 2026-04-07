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

// Active agent per chat: chatId -> agentId
const activeAgents = new Map();

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

// Auto-healing: last active chat per user (for УСЬ notifications)
let lastActiveChatId = null;
const lastActiveTime = new Map(); // chatId -> timestamp (for session cleanup)
const errorCounts = new Map();    // key -> { count, lastError, lastTime }
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tim_insights (
      id           SERIAL PRIMARY KEY,
      insight_type VARCHAR(50)  NOT NULL,
      content      TEXT         NOT NULL,
      created_at   TIMESTAMPTZ  DEFAULT NOW(),
      used_by_kana BOOLEAN      DEFAULT FALSE
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_tim_type ON tim_insights(insight_type, created_at DESC)'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kana_content (
      id           SERIAL PRIMARY KEY,
      chat_id      BIGINT       NOT NULL,
      content_type VARCHAR(50)  NOT NULL,
      text         TEXT         NOT NULL,
      approved     BOOLEAN      DEFAULT FALSE,
      created_at   TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_kana_chat ON kana_content(chat_id, created_at DESC)'
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
// ТИМ insights ↔ КАНА content shared memory
// ---------------------------------------------------------------------------

async function saveTimInsight(insightType, content) {
  try {
    await pool.query(
      'INSERT INTO tim_insights (insight_type, content) VALUES ($1, $2)',
      [insightType, content]
    );
  } catch (err) {
    console.error('saveTimInsight error:', err.message);
  }
}

// Returns the N most recent insights, optionally filtered by type
async function getRecentTimInsights(limit = 3, insightType = null) {
  try {
    const query = insightType
      ? 'SELECT insight_type, content, created_at FROM tim_insights WHERE insight_type = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT insight_type, content, created_at FROM tim_insights ORDER BY created_at DESC LIMIT $1';
    const params = insightType ? [insightType, limit] : [limit];
    const res = await pool.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('getRecentTimInsights error:', err.message);
    return [];
  }
}

async function saveKanaContent(chatId, contentType, text) {
  try {
    await pool.query(
      'INSERT INTO kana_content (chat_id, content_type, text) VALUES ($1, $2, $3)',
      [chatId, contentType, text]
    );
  } catch (err) {
    console.error('saveKanaContent error:', err.message);
  }
}

async function markKanaContentApproved(chatId) {
  try {
    // Mark the most recent unapproved entry for this chat as approved
    await pool.query(
      `UPDATE kana_content SET approved = TRUE
       WHERE id = (SELECT id FROM kana_content WHERE chat_id = $1 AND NOT approved ORDER BY created_at DESC LIMIT 1)`,
      [chatId]
    );
  } catch (err) {
    console.error('markKanaContentApproved error:', err.message);
  }
}

// Detect what type of content КАНА just produced from the response text
function detectKanaContentType(text) {
  const t = text.toLowerCase();
  if (/campaign|кампани/.test(t)) return 'campaign';
  if (/funnel|воронк/.test(t)) return 'funnel';
  if (/calendar|контент.план|content.*plan/.test(t)) return 'calendar';
  if (/offer|оффер/.test(t)) return 'offer';
  if (/caption|подпис|пост/.test(t)) return 'post';
  return 'content';
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
// Multi-agent system
// ---------------------------------------------------------------------------

const DEFAULT_AGENT = 'пятница';

const AGENTS = {
  кана: {
    id: 'кана',
    name: 'КАНА',
    emoji: '🎯',
    title: 'Маркетолог',
    systemPrompt: `Ты КАНА — маркетинговый эксперт мирового уровня. Думаешь как Alex Hormozi ($100M Offers), Gary Vee и David Ogilvy одновременно. Одержим одной метрикой: сгенерированные лиды.

${BRAND_KNOWLEDGE}

---

${LONGHORN_BRAND_KNOWLEDGE}

---

${MARKETING_RULES}

---

## МАРКЕТИНГОВЫЙ ФРЕЙМВОРК КАНЫ

### 1. КРЮЧОК (первые 3 секунды решают всё)
- Pattern interrupt — сломай ожидания читателя
- Конкретное число бьёт расплывчатое утверждение: "$18,500 bathroom in 10 days" > "quality remodeling"
- Pain-first (бей по боли) или dream-first (рисуй мечту) — зависит от уровня осведомлённости аудитории
- Структуры хуков: [Число] + [Результат] + [Срок] | [Место] + [Трансформация] | [Вопрос-триггер боли]

### 2. КОНСТРУКЦИЯ ОФФЕРА (Hormozi framework)
Сильный оффер = Dream Outcome + Perceived Likelihood + Time Delay↓ + Effort/Sacrifice↓
Для Hammer: "Complete bathroom transformation in 10 days, fixed price, zero surprises — or we pay the difference"
Для Longhorn: адаптируй под Austin TX рынок
Всегда стекай ценность и снижай риск через гарантию.

### 3. ТАРГЕТИНГ
Hammer: homeowners $150k–$300k доход, NW Chicago suburbs (Buffalo Grove, Arlington Heights, Palatine, Schaumburg, Northbrook, Glenview, Wilmette), возраст 35–65, own single family home, NOT condo/renters
Longhorn: аналогичный профиль, Austin TX suburbs (Round Rock, Cedar Park, Georgetown, Kyle, Buda, Leander)
Триггерные события: покупка дома (1–3 года назад), жизненное событие (новорождённый, родители переезжают), сезонность (март–июнь — пик ремонтного сезона)

### 4. КОНТЕНТ ПО УРОВНЯМ ОСВЕДОМЛЁННОСТИ
- Unaware → educational, problem agitation ("Why most homeowners regret cheap tile choices")
- Problem aware → "3 signs your bathroom is costing you money"
- Solution aware → comparison, competitor differentiation
- Product aware → social proof, before/after, testimonials
- Most aware → offer, urgency, hard CTA

### 5. ФОРМУЛЫ РЕКЛАМНЫХ ПОСТОВ
Before/After: "[Конкретный пригород] homeowner wanted [dream]. Here's what we did in [time]."
Problem agitation: "3 signs your bathroom is costing you money (and how to fix it in 10 days)"
Social proof: "47 families in Arlington Heights chose Hammer Remodeling. Here's why."
Urgency: "We have 2 project slots open in [month]. First come first served."
Seasonal: "Spring remodel season starts now. [Offer] for bookings before [date]."

### 6. ЛИДОГЕНЕРАЦИЯ
- Free estimate как лид-магнит
- Seasonal promotions: spring remodel season (март–июнь), end-of-year budget spending (ноябрь–декабрь)
- Referral program content
- Google review request campaigns
- Nextdoor neighborhood targeting

### 7. ДАННЫЕ ОТ ТИМА
В начале разговора тебе могут передать последние инсайты от Тима. Используй их при создании контента.
Если нужны свежие данные о конкурентах, скажи: "Нужны данные от Тима — запусти /report или попроси Тима проанализировать конкурентов."

---

## КАК РАБОТАЕШЬ

**СТРУКТУРА МЫШЛЕНИЯ**
Для каждого поста думаешь: Внимание → Интерес → Желание → Действие.
Называешь слабый контент слабым сразу. Не три варианта — одна чёткая рекомендация.

**НЕЗАВИСИМОЕ МЫШЛЕНИЕ**
Говоришь без просьбы:
- "Три поста PROCESS подряд — алгоритм начнёт депри­оритизировать, нужен SOCIAL PROOF"
- "Этот caption звучит как пресс-релиз — вот версия, которая звучит по-человечески"
- При запросе поста → предлагаешь формат Stories в дополнение
- При проблемной композиции → объясняешь как исправить в Canva

**БЕЗ ВОДЫ**
- Никогда: "Отличный вопрос!", "Конечно!", филлеры
- Никогда: расплывчатые советы без конкретного следующего шага
- Всегда: конкретные числа, конкретный пригород, конкретный следующий шаг

**ЯЗЫК**
Говоришь по-русски. Пишешь контент (посты, captions, ad copy) на английском.`,
  },

  пятница: {
    id: 'пятница',
    name: 'ПЯТНИЦА',
    emoji: '🤖',
    title: 'Личный ассистент',
    systemPrompt: `Ты ПЯТНИЦА — тёплый, умный личный ассистент Улика. Ты организованная, проактивная и по-настоящему полезная.

Контекст об Улике: владелец Hammer Remodeling LLC (пригороды Чикаго) и Longhorn Construction (Остин, TX). Управляет маркетингом, операциями и развитием бизнеса для обеих компаний.

Помогаешь с: любыми задачами, вопросами, переводами, напоминаниями, поиском информации, документами, планированием, организацией — всем, что нужно.

## Как работаешь

**ЛИЧНОСТЬ**
Тёплая, но эффективная. Не тратишь время впустую. Доводишь дела до конца и предвосхищаешь, что понадобится следующим. Говоришь как умный ассистент, который давно работает с Уликом и знает его приоритеты.

**ПРОАКТИВНОСТЬ**
После выполнения задачи добавляешь одно короткое наблюдение или предложение, о котором не спрашивали, но которое будет полезно. Максимум 1-2 предложения, конкретно.

**КОНТЕКСТНОЕ МЫШЛЕНИЕ**
Отслеживаешь весь разговор. Помнишь детали. Не обнуляешь контекст каждое сообщение.

**ЯЗЫК**
Всегда отвечаешь по-русски если Улик пишет на русском. English → English.`,
  },

  усь: {
    id: 'усь',
    name: 'УСЬ',
    emoji: '🔧',
    title: 'Тех поддержка',
    systemPrompt: `Ты УСЬ — дружелюбный айтишник, который следит за ботом и объясняет технические вещи простым языком. Никакого жаргона — только понятные объяснения и чёткие инструкции.

## Что ты знаешь о боте
- Бот работает на Node.js, задеплоен на Railway
- База данных: PostgreSQL на Railway (таблицы: conversations, user_preferences, posts_history, reminders)
- ИИ: Anthropic Claude API (claude-sonnet-4-20250514)
- Голос: OpenAI Whisper (расшифровка голосовых)
- Соцсети: Facebook и Instagram Graph API v19.0
- Видео: ffmpeg (извлекает кадры для анализа)
- Поиск фото: Unsplash API
- Файл бота: C:/Users/User/my-assistant-bot.js

## Как ты объясняешь проблемы

Когда пользователь описывает проблему или присылает ошибку:
1. Первые 1-2 предложения — что случилось, простым языком (используй аналогии: "бот уснул и нужен перезапуск", "токен как пропуск — он просрочился")
2. Нумерованные шаги — как исправить, конкретно и по порядку
3. Финал: "Если не помогло — скажи, разберёмся"

## Твоя личность
- Объясняешь как друг-айтишник, не как программист на собеседовании
- Используешь аналогии из обычной жизни для технических вещей
- Никогда не говоришь "ошибка 500" без объяснения что это значит
- Короткие ответы — максимум 5-7 предложений если нет чётких шагов

## Язык
Отвечаешь по-русски. Технические термины объясняешь в скобках если используешь.`,
  },

  тим: {
    id: 'тим',
    name: 'ТИМ',
    emoji: '📊',
    title: 'Аналитик',
    systemPrompt: `Ты ТИМ — старший бизнес-аналитик. Работаешь с данными, конкурентами, трендами и рынком. Каждое утверждение подкреплено цифрами или источником. Никогда не даёшь расплывчатых советов.

${BRAND_KNOWLEDGE}

---

${LONGHORN_BRAND_KNOWLEDGE}

---

## Твои специализации

### 1. АНАЛИЗ КОНКУРЕНТОВ
Конкуренты Hammer Remodeling (Чикаго): Envy Home Services, Sunny Construction, Regency Home, Kitchen Village.
Конкуренты Longhorn Construction (Остин): сначала ищи через web_search "remodeling contractors Austin TX" чтобы найти актуальных игроков.

Для КАЖДОГО анализируемого конкурента выполняй ВСЕ четыре шага по порядку:

**ШАГ 1 — Сайт (web_fetch)**
Зайди на сайт конкурента через web_fetch. Ищи и фиксируй:
- Главный оффер (что обещают, какой результат)
- Цены или диапазоны если указаны
- Главный CTA (кнопка/призыв)
- Перечень услуг
- УТП — чем отличаются от других

**ШАГ 2 — Реклама (web_fetch Facebook Ads Library)**
Открой через web_fetch:
https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q={НАЗВАНИЕ_КОНКУРЕНТА}
Анализируй:
- Есть ли активные объявления (и сколько)
- Что рекламируют: оффер, текст, визуал (по описанию)
- Акции и спецпредложения в рекламе
- Тон и стиль рекламных текстов

**ШАГ 3 — Трафик и SEO (web_search)**
Ищи через web_search: "[название] site:similarweb.com" или "[название] traffic estimate" или "[название] monthly visitors".
Также ищи: "[название] reviews 2024 2025" на Google, Yelp, Houzz, BBB.
Фиксируй: рейтинг, количество отзывов, динамика, типичные жалобы.

**ШАГ 4 — Итоговая сводка**
Оформляй каждого конкурента так:

---
**[НАЗВАНИЕ]** | Рейтинг: X/5 (N отзывов) | Трафик: ~N/мес (если найден)

🌐 **Сайт:** главный оффер в одном предложении | CTA | услуги (список)
💰 **Цены:** [что указано или "не указаны"]
📢 **Реклама:** [активных объявлений: N] — [краткое описание что рекламируют]
📊 **Трафик:** [данные или "данных нет"]
⭐ **Отзывы:** [рейтинг, кол-во, ключевые темы]

✅ **Сильные стороны:** [конкретно, 2-3 пункта]
❌ **Слабые стороны:** [конкретно, 2-3 пункта]
🎯 **Возможность для нас:** [конкретное действие с числами]
---

### 2. РЫНОЧНЫЕ ТРЕНДЫ
Всегда ищи актуальные данные перед ответом. Топ-3 источника для поиска: Houzz Research, NKBA reports, Remodeling Magazine Cost vs Value.
Формат: тренд + цифра + почему важно для Hammer/Longhorn.

### 3. БИЗНЕС-АНАЛИТИКА
Когда пользователь присылает данные (выручка, лиды, конверсия, бюджет рекламы) — находи паттерны, считай метрики, давай рекомендации с конкретными числами.
Всегда считай: CAC (стоимость привлечения клиента), ROI, conversion rate, средний чек.

### 4. КОНТЕНТНАЯ РАЗВЕДКА
Ищи через web_search что работает в нише home remodeling на Facebook/Instagram: форматы, хуки, длина постов, время публикации. Опирайся на данные, не на мнения.

### 5. ДЕМОГРАФИЯ РЫНКОВ
Чикаго NW suburbs (Hammer): Buffalo Grove, Arlington Heights, Palatine, Schaumburg — средний доход, возраст домовладельцев, бюджеты на ремонт.
Austin TX (Longhorn): Round Rock, Cedar Park, Georgetown, Kyle — те же метрики.
Всегда ищи актуальные Census/ACS данные.

### 6. ОТЧЁТЫ (/report)
Генерируй структурированный еженедельный отчёт по команде /report:
- Активность конкурентов за неделю
- Трендовые форматы контента
- Рыночные возможности
- Топ-3 рекомендации

---

## Правила работы

**ВЕБ-ПОИСК — ВСЕГДА**
Перед каждым ответом, где нужны актуальные данные, делаешь web_search. Не даёшь устаревшую информацию. Если данные старше 6 месяцев — предупреждаешь.

**ФОРМАТ ДАННЫХ**
- Цифры везде где возможно: %, $, дни, рейтинги
- Таблицы для сравнений
- Источник в скобках: (Houzz 2024), (Google Reviews, апрель 2025)
- Если данные недоступны — говоришь прямо: "точных данных нет, ориентировочно..."

**ЛИЧНОСТЬ**
Острый, прямой, конкретный. Говоришь как аналитик McKinsey — платишь за инсайт, не за слова.
Не пишешь "возможно стоит рассмотреть". Пишешь "делай X — потому что Y, это даст Z%".

**СВЯЗЬ С КАНОЙ**
Когда находишь данные полезные для маркетинга — заканчиваешь ответ:
"📢 *Для КАНЫ:* [конкретный инсайт для применения в контенте прямо сейчас]"

**ЯЗЫК**
Отвечаешь по-русски. Данные, названия брендов и метрики — на языке оригинала.`,
  },
};

const AGENTS_MENU_TEXT = `👥 *Выбери агента:*

1. 🎯 *КАНА* — Маркетолог
   Посты, рекламные кампании, оффер, воронки, контент-календарь. Команды: /campaign /funnel /offer /calendar

2. 🤖 *ПЯТНИЦА* — Личный ассистент
   Любые задачи, вопросы, переводы, напоминания, поиск информации, документы, планирование

3. 🔧 *УСЬ* — Тех поддержка
   Объясняет ошибки простым языком, мониторинг бота /status, помощь с техническими вопросами

4. 📊 *ТИМ* — Аналитик
   Анализ конкурентов, тренды, рыночные данные, бизнес-аналитика, еженедельный отчёт /report

Переключить: /кана · /пятница · /усь · /тим`;

function normalizeAgentId(raw) {
  const n = (raw || '').toLowerCase().trim();
  if (/^кан/.test(n)) return 'кана';
  if (/^пятниц/.test(n)) return 'пятница';
  if (/^ус/.test(n)) return 'усь';
  if (/^тим/.test(n)) return 'тим';
  return null;
}

// Returns { agentId, task } if message starts with agent name or contains switch command
function detectAgentDirective(text) {
  if (!text) return null;
  const t = text.trim();

  // "Кана, напиши пост..." or "ПЯТНИЦА: сделай..."
  const prefixMatch = t.match(/^(кана|пятница|усь|тим)[,:\s]\s*([\s\S]+)/iu);
  if (prefixMatch) {
    const agentId = normalizeAgentId(prefixMatch[1]);
    if (agentId) return { agentId, task: prefixMatch[2].trim() };
  }

  // "переключись на Кана" / "переключи на усь"
  const switchMatch = t.match(/перекл[уюи]чис[ьь]?\s+на\s+(\S+)/iu);
  if (switchMatch) {
    const agentId = normalizeAgentId(switchMatch[1]);
    if (agentId) return { agentId, task: null };
  }

  // "передай Кане [task]" / "передай тиму [task]"
  const delegateMatch = t.match(/передай\s+(\S+?)\s+([\s\S]+)/iu);
  if (delegateMatch) {
    const agentId = normalizeAgentId(delegateMatch[1]);
    if (agentId) return { agentId, task: delegateMatch[2].trim() };
  }

  return null;
}

async function getActiveAgent(chatId) {
  if (activeAgents.has(chatId)) return activeAgents.get(chatId);
  try {
    const res = await pool.query('SELECT preferences FROM user_preferences WHERE chat_id = $1', [chatId]);
    if (res.rows.length > 0 && res.rows[0].preferences?.activeAgent) {
      const agentId = res.rows[0].preferences.activeAgent;
      if (AGENTS[agentId]) {
        activeAgents.set(chatId, agentId);
        return agentId;
      }
    }
  } catch {}
  return DEFAULT_AGENT;
}

async function setActiveAgent(chatId, agentId) {
  activeAgents.set(chatId, agentId);
  await upsertUserPrefs(chatId, { activeAgent: agentId });
}

// Returns an immediate "thinking" message if ТИМ is about to do a long task,
// or null for quick questions that don't need a progress indicator.
function getTimThinkingMessage(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  if (/конкурент|competitor|envy|sunny|regency|kitchen village|rival|кухня вилладж/.test(t)) {
    return '🔍 *ТИМ:* Начинаю анализ, изучаю сайты и рекламу... Займёт 1-2 минуты.';
  }
  if (/рынок|market research|исследован|демограф|demographic|целевая аудитори/.test(t)) {
    return '📊 *ТИМ:* Запускаю исследование рынка, жди...';
  }
  if (/тренд|trend/.test(t)) {
    return '📈 *ТИМ:* Ищу актуальные тренды в нише...';
  }
  if (/трафик|traffic|similarweb|реклам.*анализ|анализ.*реклам|ads library/.test(t)) {
    return '🌐 *ТИМ:* Проверяю рекламу и трафик конкурентов...';
  }
  if (/найди|поищи|поиск|найти|проверь|изучи|собери данн|дай отчёт|дай анализ/.test(t)) {
    return '🌐 *ТИМ:* Проверяю через интернет...';
  }
  return null;
}

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

async function askClaude(chatId, userMessage, overrideAgentId = null) {
  const agentId = overrideAgentId || await getActiveAgent(chatId);
  const agent = AGENTS[agentId] || AGENTS[DEFAULT_AGENT];

  await ensureHistoryLoaded(chatId);
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  // КАНА: inject recent ТИМ insights into system prompt
  let systemPrompt = agent.systemPrompt;
  if (agentId === 'кана') {
    const insights = await getRecentTimInsights(3);
    if (insights.length > 0) {
      const insightBlock = insights
        .map(r => `[${new Date(r.created_at).toLocaleDateString('ru-RU')} | ${r.insight_type}] ${r.content.slice(0, 400)}`)
        .join('\n\n');
      systemPrompt += `\n\n---\n## Последние данные от Тима\n${insightBlock}`;
    }
  }

  // ТИМ always gets web search; others get it only when the message triggers it
  const useSearch = agentId === 'тим' || needsWebSearch(userMessage);
  const baseParams = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
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

  // ТИМ: save insights after any analysis
  if (agentId === 'тим') {
    const insightType = /конкурент|competitor|envy|sunny|regency|kitchen village/i.test(userMessage)
      ? 'competitor' : /тренд|trend/i.test(userMessage)
      ? 'trend' : /рынок|market|демограф/i.test(userMessage)
      ? 'market' : 'general';
    saveTimInsight(insightType, assistantMessage.slice(0, 2000)).catch(() => {});
  }

  // КАНА: save produced content to kana_content
  if (agentId === 'кана' && assistantMessage.length > 100) {
    const contentType = detectKanaContentType(userMessage + ' ' + assistantMessage);
    saveKanaContent(chatId, contentType, assistantMessage.slice(0, 3000)).catch(() => {});
  }

  return `${agent.emoji} *${agent.name}*\n\n${assistantMessage}`;
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

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, AGENTS_MENU_TEXT, { parse_mode: 'Markdown' });
});

bot.onText(/\/agents/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, AGENTS_MENU_TEXT, { parse_mode: 'Markdown' });
});

bot.onText(/\/кана/, async (msg) => {
  const chatId = msg.chat.id;
  await setActiveAgent(chatId, 'кана');
  bot.sendMessage(chatId, '🎯 *КАНА* активирован. Маркетолог на связи.', { parse_mode: 'Markdown' });
});

bot.onText(/\/пятница/, async (msg) => {
  const chatId = msg.chat.id;
  await setActiveAgent(chatId, 'пятница');
  bot.sendMessage(chatId, '🤖 *ПЯТНИЦА* активирована. Личный ассистент готов.', { parse_mode: 'Markdown' });
});

bot.onText(/\/усь/, async (msg) => {
  const chatId = msg.chat.id;
  await setActiveAgent(chatId, 'усь');
  bot.sendMessage(chatId, '🔧 *УСЬ* активирован. Тех поддержка на связи.', { parse_mode: 'Markdown' });
});

bot.onText(/\/тим/, async (msg) => {
  const chatId = msg.chat.id;
  await setActiveAgent(chatId, 'тим');
  bot.sendMessage(chatId, '📊 *ТИМ* активирован. Аналитик готов к работе.', { parse_mode: 'Markdown' });
});

async function checkBotStatus() {
  const results = [];

  // Database
  try {
    await pool.query('SELECT 1');
    results.push('✅ База данных работает');
  } catch (err) {
    results.push(`❌ База данных недоступна — ${err.message}`);
  }

  // Facebook token
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}`, {
      params: { fields: 'id', access_token: FB_PAGE_ACCESS_TOKEN },
      timeout: 5000,
    });
    results.push(res.data.id ? '✅ Facebook токен рабочий' : '❌ Facebook токен не прошёл проверку');
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    if (/token|expired|invalid/i.test(msg)) {
      results.push('❌ Facebook токен истёк — нужно обновить');
    } else {
      results.push(`❌ Facebook недоступен — ${msg}`);
    }
  }

  // OpenAI key
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      await openai.models.list({ limit: 1 });
      results.push('✅ OpenAI ключ рабочий (голосовые работают)');
    } catch (err) {
      if (err.status === 401) {
        results.push('❌ OpenAI ключ недействителен — голосовые не работают');
      } else {
        results.push(`⚠️ OpenAI — не удалось проверить: ${err.message}`);
      }
    }
  } else {
    results.push('⚠️ OpenAI ключ не настроен — голосовые недоступны');
  }

  // Unsplash key
  if (process.env.UNSPLASH_ACCESS_KEY) {
    try {
      await axios.get('https://api.unsplash.com/photos', {
        params: { per_page: 1, client_id: process.env.UNSPLASH_ACCESS_KEY },
        timeout: 5000,
      });
      results.push('✅ Unsplash ключ рабочий (поиск фото работает)');
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        results.push('❌ Unsplash ключ недействителен — поиск фото не работает');
      } else {
        results.push(`⚠️ Unsplash — не удалось проверить: ${err.message}`);
      }
    }
  } else {
    results.push('⚠️ Unsplash ключ не настроен — поиск фото недоступен');
  }

  return results;
}

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');
  await setActiveAgent(chatId, 'усь');
  try {
    const checks = await checkBotStatus();
    const allOk = checks.every(c => c.startsWith('✅'));
    const header = allOk
      ? '🔧 *УСЬ* — Всё работает, шеф 👍'
      : '🔧 *УСЬ* — Проверил, есть вопросы:';
    await bot.sendMessage(chatId, `${header}\n\n${checks.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, `🔧 *УСЬ* — Не смог провести проверку: ${err.message}`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, []);
  dbHistoryLoaded.delete(chatId);
  interviewSessions.delete(chatId);
  captionSessions.delete(chatId);
  postSessions.delete(chatId);
  strategySessions.delete(chatId);
  activeAgents.delete(chatId);
  try {
    await pool.query('DELETE FROM conversations WHERE chat_id = $1', [chatId]);
  } catch (err) {
    console.error('Failed to clear DB history:', err.message);
  }
  bot.sendMessage(chatId, 'Все сессии очищены. Активный агент сброшен на ПЯТНИЦА.');
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

async function searchUnsplashPhotos(query, attempt = 0) {
  if (!UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY не настроен');
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&client_id=${UNSPLASH_ACCESS_KEY}`;
  try {
    const res = await axios.get(url, { timeout: 8000 });
    return res.data.results.map(p => ({
      url: p.urls.regular,
      description: p.description || p.alt_description || query,
      author: p.user.name,
      authorLink: p.user.links.html,
    }));
  } catch (err) {
    const retryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' || (err.response?.status >= 500);
    if (attempt < 2 && retryable) {
      console.log(`Unsplash retry ${attempt + 1} for query "${query}"`);
      await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
      return searchUnsplashPhotos(query, attempt + 1);
    }
    throw err;
  }
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
    `*Команды:*\n\n/agents — Выбор агента\n/кана — Переключить на КАНА (маркетолог)\n/пятница — Переключить на ПЯТНИЦА (ассистент)\n/усь — Переключить на УСЬ (тех поддержка)\n/тим — Переключить на ТИМ (аналитик)\n\n/campaign [детали] — Полная рекламная кампания от КАНЫ\n/funnel [цель] — Контентная воронка по уровням осведомлённости\n/offer [детали] — Создать оффер по Hormozi framework\n/calendar [контекст] — Контент-календарь на 2 недели\n/report — Еженедельный аналитический отчёт от ТИМ (конкуренты, тренды, рекомендации)\n/status — Проверить состояние бота (БД, токены, ключи)\n/clear — Очистить историю и сессии\n/post [текст] — Проверить и опубликовать текстовый пост\n/strategy — Контент-стратегия (интервью)\n/analytics — Аналитика Facebook\n/reminders — Активные напоминания\n/cancelreminder [id] — Отменить напоминание\n/findphoto [описание] — Поиск фото на Unsplash\n/help — Это сообщение\n\n*Фото:*\n• Фото + "проверь фото" → интервью и бриф\n• Фото + подпись → прямая проверка\n• Фото без подписи → варианты caption\n\n*Другое:*\n• Голосовое → транскрипция и ответ\n• Видео → анализ кадров и бриф\n• PDF/DOCX/TXT → анализ документа\n• "напомни мне X в Y" → напоминание\n\n*Смена агента в чате:*\n• "Кана, напиши пост про ванную"\n• "переключись на Тим"\n• "передай Усю эту ошибку"`,
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

// ---------------------------------------------------------------------------
// ТИМ weekly report
// ---------------------------------------------------------------------------

async function generateTimReport(chatId) {
  const reportPrompt = `${AGENTS['тим'].systemPrompt}

Сегодня: ${new Date().toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Сгенерируй еженедельный аналитический отчёт. Используй web_search для получения актуальных данных по каждому разделу.

Обязательные разделы:

**1. АКТИВНОСТЬ КОНКУРЕНТОВ (последние 7 дней)**
Для каждого конкурента выполни полный 4-шаговый анализ из твоих инструкций:
- web_fetch сайта: текущий оффер, CTA, цены
- web_fetch Facebook Ads Library: активные объявления и что рекламируют
- web_search отзывов и трафика: новые отзывы за неделю, рейтинг
Конкуренты: Envy Home Services, Sunny Construction, Regency Home, Kitchen Village.
Формат на каждого: мини-карточка из ШАГа 4 + оценка угрозы (🔴/🟡/🟢).

**2. ТРЕНДЫ В НИШЕ**
Ищи: home remodeling trends 2025, bathroom remodel trends, contractor marketing social media.
Топ-3 тренда с данными и применением для Hammer/Longhorn.

**3. РЫНОЧНЫЕ ВОЗМОЖНОСТИ**
Ищи: remodeling demand Chicago suburbs 2025, Austin TX home renovation market.
2-3 конкретные возможности с обоснованием — цифры, сезонность, спрос.

**4. КОНТЕНТНАЯ РАЗВЕДКА**
Ищи: best performing contractor content Facebook Instagram 2025.
Что работает в нише прямо сейчас: форматы, хуки, темы. Примеры с метриками.

**5. ТОП-3 РЕКОМЕНДАЦИИ НА НЕДЕЛЮ**
Конкретные действия для Hammer Remodeling и Longhorn Construction. С числами и дедлайнами.

**📢 Для КАНЫ:**
Топ-2 контентных инсайта для немедленного применения.

Формат: структурированный, таблицы где уместно, цифры везде. Без воды.`;

  const messages = [{ role: 'user', content: 'Сгенерируй еженедельный отчёт.' }];
  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 6000,
    system: reportPrompt,
    tools: WEB_SEARCH_TOOL,
    messages,
  });

  // Run the full tool loop
  let safetyCounter = 0;
  while (response.stop_reason === 'tool_use' && safetyCounter++ < 20) {
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = response.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));
    messages.push({ role: 'user', content: toolResults });
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 6000,
      system: reportPrompt,
      tools: WEB_SEARCH_TOOL,
      messages,
    });
  }

  return extractText(response.content);
}

bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;
  await setActiveAgent(chatId, 'тим');
  bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId, '📊 *ТИМ:* Собираю данные, ищу по конкурентам и трендам... Займёт ~30 секунд.', { parse_mode: 'Markdown' });
  try {
    const report = await generateTimReport(chatId);
    // Save full report as insight for КАНА to use
    saveTimInsight('weekly_report', report.slice(0, 2000)).catch(() => {});
    const header = `📊 *ТИМ — Еженедельный отчёт*\n_${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}_\n\n`;
    const full = header + report;
    const CHUNK = 4000;
    for (let i = 0; i < full.length; i += CHUNK) {
      await bot.sendMessage(chatId, full.slice(i, i + CHUNK), { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('/report error:', err.message);
    bot.sendMessage(chatId, '📊 *ТИМ:* Не удалось собрать отчёт. Попробуй ещё раз или проверь /status.', { parse_mode: 'Markdown' });
  }
});

// ---------------------------------------------------------------------------
// КАНА commands: /campaign /funnel /offer /calendar
// ---------------------------------------------------------------------------

async function kanaCommand(chatId, taskPrompt, commandType) {
  await setActiveAgent(chatId, 'кана');
  bot.sendChatAction(chatId, 'typing');
  try {
    const reply = await askClaude(chatId, taskPrompt, 'кана');
    // saveKanaContent already called inside askClaude
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error(`/${commandType} error:`, err.message);
    bot.sendMessage(chatId, `🎯 *КАНА:* Не удалось создать ${commandType}. Попробуй ещё раз.`, { parse_mode: 'Markdown' });
  }
}

bot.onText(/\/campaign(?:\s+(.+))?/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const extra = match[1]?.trim() || '';
  const prompt = `Создай полную рекламную кампанию для Facebook/Instagram.${extra ? ` Детали: ${extra}` : ''}

Структура кампании:
1. **HOOK** — 3 варианта крючка (выбери лучший и объясни почему)
2. **AD COPY** — готовый текст объявления (по Hormozi framework)
3. **CTA** — конкретный призыв к действию с контактом
4. **IMAGE BRIEF** — точные инструкции для дизайнера (что на фото, текст overlay, логотип)
5. **TARGETING** — конкретная аудитория (возраст, интересы, гео, поведение)
6. **BUDGET RECOMMENDATION** — сколько тратить и на что
7. **KPI** — что считать успехом (CPL цель, CTR норма)`;
  await kanaCommand(chatId, prompt, 'campaign');
});

bot.onText(/\/funnel(?:\s+(.+))?/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const extra = match[1]?.trim() || '';
  const prompt = `Построй контентную воронку.${extra ? ` Цель/контекст: ${extra}` : ''}

Воронка по уровням осведомлённости:
1. **UNAWARE** (2-3 поста) — темы, хуки, format
2. **PROBLEM AWARE** (2-3 поста) — темы, хуки, format
3. **SOLUTION AWARE** (2-3 поста) — темы, хуки, format
4. **PRODUCT AWARE** (2-3 поста) — темы, хуки, format
5. **MOST AWARE** (1-2 поста) — оффер, CTA, urgency

Для каждого уровня: конкретные идеи постов с готовыми хуками.`;
  await kanaCommand(chatId, prompt, 'funnel');
});

bot.onText(/\/offer(?:\s+(.+))?/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const extra = match[1]?.trim() || '';
  const prompt = `Помоги создать неотразимый оффер по Hormozi framework.${extra ? ` Детали: ${extra}` : ''}

Разбор оффера:
1. **DREAM OUTCOME** — что получает клиент (конкретно)
2. **PERCEIVED LIKELIHOOD** — почему поверят (доказательства)
3. **TIME DELAY** — как минимизировать срок
4. **EFFORT/SACRIFICE** — как снизить усилия клиента
5. **RISK REVERSAL** — гарантия / страховка
6. **ГОТОВЫЙ ОФФЕР** — финальная формулировка для рекламы
7. **PRICE ANCHORING** — как подать цену чтобы она казалась дешёвой`;
  await kanaCommand(chatId, prompt, 'offer');
});

bot.onText(/\/calendar(?:\s+(.+))?/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const extra = match[1]?.trim() || '';
  const prompt = `Создай контент-календарь на 2 недели.${extra ? ` Контекст: ${extra}` : ''}

Для каждого поста укажи:
- День и дата (с сегодняшней даты)
- Платформа (Facebook / Instagram / оба)
- Тип контента (BEFORE/AFTER / PROCESS / EDUCATIONAL / SOCIAL PROOF / OFFER)
- Уровень осведомлённости
- Идея поста (1 предложение по-русски)
- Готовый hook (на английском)
- Готовый caption (на английском, со всеми хэштегами)

Соотношение: 30% BEFORE/AFTER, 25% PROCESS, 20% EDUCATIONAL, 15% SOCIAL PROOF, 10% OFFER.`;
  await kanaCommand(chatId, prompt, 'calendar');
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
  lastActiveChatId = chatId;
  lastActiveTime.set(chatId, Date.now());

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
      errorCounts.delete('voiceHandler');
      await bot.sendMessage(chatId, `🎤 _"${transcribed}"_`, { parse_mode: 'Markdown' });
      // Process as regular message
      const reply = await askClaude(chatId, transcribed);
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Voice error:', err.message);
      monitorError('voiceHandler', err, chatId);
      bot.sendMessage(chatId, 'Не удалось расшифровать голосовое. Попробуй ещё раз.');
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
      // Mark the most recent КАНА content as approved
      markKanaContentApproved(chatId).catch(() => {});

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
          errorCounts.delete('fbPublish');
          bot.sendMessage(chatId, '✅ Опубликовано в Facebook!');
          savePublishedPost(chatId, session.text, 'facebook').catch(e => console.error('DB error:', e.message));
        } catch (err) {
          console.error('Facebook publish error:', err.response?.data || err.message);
          monitorError('fbPublish', err, chatId);
          bot.sendMessage(chatId, `❌ Не удалось опубликовать: ${err.response?.data?.error?.message || err.message}`);
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

  // ── AGENT DIRECTIVE ────────────────────────────────────────────────────────
  const directive = detectAgentDirective(text);
  if (directive) {
    await setActiveAgent(chatId, directive.agentId);
    const agent = AGENTS[directive.agentId];
    if (!directive.task) {
      bot.sendMessage(chatId, `${agent.emoji} *${agent.name}* активирован.`, { parse_mode: 'Markdown' });
      return;
    }
    // Switch and execute task immediately
    bot.sendChatAction(chatId, 'typing');
    if (directive.agentId === 'тим') {
      const thinking = getTimThinkingMessage(directive.task);
      if (thinking) await bot.sendMessage(chatId, thinking, { parse_mode: 'Markdown' });
    }
    try {
      const reply = await askClaude(chatId, directive.task, directive.agentId);
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error calling Claude API:', err.message);
      bot.sendMessage(chatId, 'Что-то пошло не так. Попробуй ещё раз.');
    }
    return;
  }

  // ── REGULAR CONVERSATION ───────────────────────────────────────────────────
  bot.sendChatAction(chatId, 'typing');
  const activeAgentId = await getActiveAgent(chatId);
  if (activeAgentId === 'тим') {
    const thinking = getTimThinkingMessage(text);
    if (thinking) await bot.sendMessage(chatId, thinking, { parse_mode: 'Markdown' });
  }
  try {
    const reply = await askClaude(chatId, text);
    errorCounts.delete('askClaude'); // reset on success
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error calling Claude API:', err.message);
    monitorError('askClaude', err, chatId);
    if (err.status === 401) {
      bot.sendMessage(chatId, '🔧 *УСЬ:* Ключ API не работает. Напиши /status чтобы проверить.', { parse_mode: 'Markdown' });
    } else if (err.status === 429) {
      bot.sendMessage(chatId, 'Слишком много запросов. Подожди минуту и попробуй снова.');
    } else {
      bot.sendMessage(chatId, 'Что-то пошло не так. Попробуй ещё раз.');
    }
  }
});

// ---------------------------------------------------------------------------
// Auto-healing system (УСЬ)
// ---------------------------------------------------------------------------

function ushNotify(message) {
  if (!lastActiveChatId) return;
  bot.sendMessage(lastActiveChatId, `🔧 *УСЬ:* ${message}`, { parse_mode: 'Markdown' })
    .catch(e => console.error('ushNotify failed:', e.message));
}

// Track repeated errors — returns current consecutive count for the key
function trackError(key, err) {
  const now = Date.now();
  const entry = errorCounts.get(key) || { count: 0, lastTime: 0 };
  if (now - entry.lastTime > 10 * 60 * 1000) {
    // Reset if more than 10 minutes since last error in this category
    errorCounts.set(key, { count: 1, lastError: err.message, lastTime: now });
    return 1;
  }
  entry.count++;
  entry.lastError = err.message;
  entry.lastTime = now;
  errorCounts.set(key, entry);
  return entry.count;
}

// ── 1. DB auto-reconnect ───────────────────────────────────────────────────
let dbReconnectAttempts = 0;

pool.on('error', async (err) => {
  console.error('DB pool error:', err.message);
  dbReconnectAttempts++;

  if (dbReconnectAttempts > 3) {
    ushNotify(`База данных падала ${dbReconnectAttempts} раз и не восстановилась. Нужно перезапустить сервис на Railway → Deployments → Redeploy.`);
    return;
  }

  // pg Pool reconnects automatically; verify the connection came back
  let recovered = false;
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    try {
      await pool.query('SELECT 1');
      recovered = true;
      break;
    } catch {}
  }

  if (recovered) {
    console.log(`DB reconnected after ${dbReconnectAttempts} attempt(s)`);
    dbReconnectAttempts = 0;
  } else {
    ushNotify(`База данных упала, пытаюсь починить... Попытка ${dbReconnectAttempts}/3 — пока не получается. Если через минуту не восстановится — перезапусти бота на Railway.`);
  }
});

// ── 2. Polling auto-restart ────────────────────────────────────────────────
let pollingRetries = 0;
const MAX_POLLING_RETRIES = 5;

bot.on('polling_error', async (err) => {
  console.error('Polling error:', err.code, err.message);

  if (err.code !== 'EFATAL' && err.code !== 'ETELEGRAM') return; // transient, ignore

  pollingRetries++;
  if (pollingRetries > MAX_POLLING_RETRIES) {
    ushNotify(`Потерял связь с Telegram ${pollingRetries} раз и не смог восстановить. Нужен ручной перезапуск на Railway.`);
    return;
  }

  console.log(`Polling restart attempt ${pollingRetries}/${MAX_POLLING_RETRIES} in 5s...`);
  await new Promise(r => setTimeout(r, 5000));
  try {
    await bot.stopPolling();
    await bot.startPolling();
    console.log('Polling restarted OK');
    pollingRetries = 0;
  } catch (restartErr) {
    console.error('Polling restart failed:', restartErr.message);
    if (pollingRetries >= MAX_POLLING_RETRIES) {
      ushNotify(`Не могу восстановить соединение с Telegram. Перезапусти бота на Railway вручную.`);
    }
  }
});

// ── 3. Session cleanup (every hour) ───────────────────────────────────────
function cleanupExpiredSessions() {
  const now = Date.now();
  const TTL = 2 * 60 * 60 * 1000; // 2 hours
  let cleaned = 0;

  for (const sessions of [postSessions, captionSessions, interviewSessions, strategySessions, photoSearchSessions]) {
    for (const chatId of sessions.keys()) {
      const lastActive = lastActiveTime.get(chatId) || 0;
      if (now - lastActive > TTL) {
        sessions.delete(chatId);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) console.log(`Session cleanup: removed ${cleaned} stale entries`);
}

// ── 4. Anthropic API health check (startup + every 6 hours) ───────────────
async function checkAnthropicHealth() {
  try {
    await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    console.log('Anthropic API health check OK');
  } catch (err) {
    console.error('Anthropic API health check failed:', err.message);
    if (err.status === 401) {
      ushNotify('Anthropic API не отвечает — ключ недействителен. Обнови `ANTHROPIC_API_KEY` в настройках Railway.');
    } else if (err.status === 429) {
      ushNotify('Anthropic API: слишком много запросов. Подожди пару минут, потом попробуй снова.');
    } else {
      ushNotify(`Anthropic API не отвечает (${err.status || err.code}). Проверь ключ или статус на status.anthropic.com.`);
    }
  }
}

// ── 6. Error monitoring wrapper ────────────────────────────────────────────
// Maps friendly user-facing messages to specific error categories
const ERROR_EXPLANATIONS = {
  askClaude:    n => `Claudе не отвечает ${n} раза подряд — проблема с AI. Проверь ANTHROPIC_API_KEY через /status.`,
  fbPublish:    n => `Публикация в Facebook не работает ${n} раза подряд. Возможно истёк токен — проверь через /status.`,
  voiceHandler: n => `Расшифровка голоса не работает ${n} раза подряд. Проверь OPENAI_API_KEY через /status.`,
};

function monitorError(key, err, chatId) {
  const count = trackError(key, err);
  if (count >= 3 && ERROR_EXPLANATIONS[key]) {
    ushNotify(ERROR_EXPLANATIONS[key](count));
    errorCounts.get(key).count = 0; // Reset after notifying to avoid spam
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startup() {
  await initDb();
  console.log('Bot is running...');
  // Delay health check to give Railway time to settle after cold start
  setTimeout(checkAnthropicHealth, 8000);
}

startup().catch(err => console.error('Startup failed:', err.message));
setInterval(checkAndSendReminders, 60 * 1000);
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);        // every hour
setInterval(checkAnthropicHealth, 6 * 60 * 60 * 1000);      // every 6 hours
