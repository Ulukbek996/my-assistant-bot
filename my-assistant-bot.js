const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

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

const PHOTO_CAPTION_SUGGEST_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Photo without caption -- analyze and suggest 3 options. Busy creative director style: short, direct, punchy. One sentence per point.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the three caption options which must be in English.

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

**Варианты подписи (на английском) -- каждый: столп бренда + конкретика + правильные хештеги + CTA по воронке**

1. [Прямой -- сильный хук с деталью/цифрой, страх клиента, CTA]

2. [Story-driven -- история жителя пригорода Чикаго, конкретный пригород, CTA]

3. [Короткий и дерзкий -- смелый открывашка, один столп бренда, срочный CTA]

${CLARIFYING_QUESTIONS_RULE}

Завершить (на русском): "Выберите вариант (1, 2 или 3) или напишите пожелания по тексту."`;

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

function extractCaptions(responseText) {
  const matches = [...responseText.matchAll(/^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.|\n\n[^\d]|$)/gms)];
  return matches.map(m => m[1].trim()).filter(c => c.length > 40);
}

function getHistory(chatId) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId);
}

function trimHistory(history, maxMessages = 20) {
  if (history.length > maxMessages) history.splice(0, history.length - maxMessages);
}

async function askClaude(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: `You are a smart personal assistant and senior marketing expert for Ulik, owner of Hammer Remodeling LLC.\n\n${BRAND_KNOWLEDGE}\n\nRespond in the same language the user writes in.`,
    messages: history,
  });

  const assistantMessage = response.content[0].text;
  history.push({ role: 'assistant', content: assistantMessage });
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
// Bot commands
// ---------------------------------------------------------------------------

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(
    chatId,
    `Hey ${name}! I'm your personal assistant and marketing expert.\n\nI work with:\n• Hammer Remodeling LLC (Chicago)\n• Longhorn Construction (Austin, TX)\n\nSend a photo with "проверь фото" to start a creative brief interview.\nOr just send a photo with a caption to review it directly.\n\nType anything to chat!`
  );
});

bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, []);
  interviewSessions.delete(chatId);
  captionSessions.delete(chatId);
  postSessions.delete(chatId);
  strategySessions.delete(chatId);
  bot.sendMessage(chatId, 'All sessions cleared. Fresh start!');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*Available commands:*\n\n/start -- Welcome\n/clear -- Clear all sessions and history\n/post [text] -- Review & publish a text post\n/strategy -- Build a content strategy (interview)\n/help -- This message\n\n*Photo flows:*\n• Photo + "проверь фото" → interview & creative brief\n• Photo + caption → direct review & publish\n• Photo only → caption suggestions`,
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
        const captions = extractCaptions(suggestionResponse);
        captionSessions.set(chatId, { captions, pendingMedia: { type: 'photo', fileId, imageBase64 } });
        await bot.sendMessage(chatId, suggestionResponse, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error suggesting captions:', err.message);
        bot.sendMessage(chatId, 'Something went wrong while analyzing the photo. Please try again.');
      }
    }
    return;
  }

  // ── VIDEO ──────────────────────────────────────────────────────────────────
  if (msg.video && msg.caption) {
    await handlePostFlow(chatId, msg.caption, { type: 'video', fileId: msg.video.file_id });
    return;
  }

  // ── TEXT ONLY ──────────────────────────────────────────────────────────────
  if (!text || text.startsWith('/')) return;

  // ── STRATEGY SESSION ──────────────────────────────────────────────────────
  if (strategySessions.has(chatId)) {
    const session = strategySessions.get(chatId);
    session.answers.push(text.trim());

    if (session.step < 5) {
      session.step++;
      await bot.sendMessage(chatId, STRATEGY_QUESTIONS[session.step - 1], { parse_mode: 'Markdown' });
    } else {
      strategySessions.delete(chatId);
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

    // Check if user is triggering a review interview instead of picking a caption
    if (isReviewRequest(text)) {
      captionSessions.delete(chatId);
      interviewSessions.set(chatId, { step: 1, answers: [], pendingMedia: session.pendingMedia });
      await bot.sendMessage(chatId, INTERVIEW_QUESTIONS[0], { parse_mode: 'Markdown' });
      return;
    }

    const picked = { '1': 0, '2': 1, '3': 2 }[text.trim()];

    if (picked !== undefined && session.captions[picked]) {
      captionSessions.delete(chatId);
      await handlePostFlow(chatId, session.captions[picked], session.pendingMedia);
    } else {
      // Correction / clarifying answer -- re-generate captions
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
              { type: 'text', text: `Additional context / feedback: ${text}` },
            ],
          }],
        });
        const newResponse = updatedResponse.content[0].text;
        const newCaptions = extractCaptions(newResponse);
        captionSessions.set(chatId, { captions: newCaptions, pendingMedia: session.pendingMedia });
        await bot.sendMessage(chatId, newResponse, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error regenerating captions:', err.message);
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
      } else {
        try {
          await publishToFacebook(session.text, session.pendingMedia);
          bot.sendMessage(chatId, 'Posted to Facebook successfully!');
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

console.log('Bot is running...');
