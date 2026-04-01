const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const BOT_TOKEN = '8794427596:AAEVIDJFLJHb8tWjwKZ0aHMpCUXOExrQzRg';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const FB_PAGE_ID = '924698817396016';
const FB_PAGE_ACCESS_TOKEN = 'EAA98xKtbrZCYBREQnsrBFt6uSbO6pPwmrfE4vZAgjJQpj8OdxKhTRXGT6hX1ZBnZCzuaqAWZCArBkt7DAA7mz5p7GLonHyNwj719DS8Wp1sXnmRZASMIHYl8j0Gjjjm5hOnxSrquTzi9No4K42NDJVwmTUjjqZCsNZB6EYiCF0ikOZBDxCkq7ZBkstsZC6k0jOsEWZCGRTj1mcRBopt5ZBebdZAeTEKSVcMRKa7Qp9GafwAJfF0g8ZD';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Conversation history per chat
const conversations = new Map();

// Pending post sessions: chatId -> { text, pendingMedia }
// pendingMedia: null | { type: 'photo'|'video', fileId, imageBase64? }
const postSessions = new Map();

// Caption selection sessions (photo without caption): chatId -> { captions: [str, str, str], pendingMedia }
const captionSessions = new Map();

// ---------------------------------------------------------------------------
// Shared knowledge blocks injected into all marketing prompts
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
**Full scope of work:** Hammer Remodeling does ALL types of remodeling and renovation -- bathroom remodel, kitchen remodel, tile installation, flooring (organic only), full home renovation, commercial/corporate remodeling, and any other remodeling work. The company takes on any remodeling project.

**Tone of voice -- USE these phrases and style:**
- "Your bathroom, done right in 10 days."
- "We trained across Europe. Now we build in Chicago."
- "No hidden fees. You see the full price before we start."
- "See what we did for a family in Arlington Heights."
- "Complete bathroom remodel: tile, plumbing, vanity -- all in 10 days."
- European craftsmanship, precision, attention to detail
- Done in days, not months
- No surprises, clear pricing, full transparency

**Tone of voice -- NEVER use:**
- "Exceed your expectations"
- "World-class", "best in class"
- "We deliver results"
- "Quality workmanship" (without specifics)
- Generic AI-sounding phrases

**CONTENT RULE -- REAL PHOTOS ONLY:** Only use real photos from actual Hammer Remodeling projects. No stock photos, no AI-generated images, no other companies' work. Any photo showing remodeling or construction work -- bathrooms, kitchens, floors, tiles, commercial spaces, or any other renovation work -- is considered relevant and valid content. Only flag photos that are completely unrelated to construction or remodeling (e.g. landscapes, people, food, etc.).

**5 Content types -- always identify which type a post belongs to:**
1. BEFORE/AFTER -- carousel, demo to done, the main content type
2. PROCESS -- tile work, installation details, shows craftsmanship
3. EDUCATIONAL -- tips for homeowners, shows expertise
4. SOCIAL PROOF -- reviews, Google reviews, testimonials
5. OFFER -- direct CTA with price/timeline, max 1 per week

**Hashtag sets:**
- Always include: #hammerremodeling #bathroomremodel #chicagocontractor #homeimprovement #remodeling
- Local (rotate): #buffalogroveil #arlingtonheights #chicagosuburbs #nwsuburbs #palatineil #schaumburg #northbrook #glenview
- By work type: #bathroomdesign #tileinstallation #bathroomrenovation #flooringinstall #kitchenremodel #beforeandafter #homerenovation

**Key competitors:**
- Envy Home Services (Arlington Heights, veteran-owned) -- our differentiator: European craftsmanship
- Sunny Construction (family-owned since 2007) -- our differentiator: trained across Europe
- Regency Home (40+ years experience) -- our differentiator: done in days, not months
- Kitchen Village (kitchens + bathrooms, Arlington Hts) -- strong local brand`;

const MARKETING_RULES = `## 7 Core Marketing Rules (apply strictly when analyzing any content)

RULE 1 - MOVEMENT: Text must flow left-to-right naturally using rhythm, verbs, lists, and paragraphs. One image = one idea. The image must be understood within 3 seconds -- no visual clutter, no competing focal points.

RULE 2 - LEXICON: Never use vague expressions ("quality service", "we care", "best in class", "discounts", "promotions"). Use specific technical terms, concrete numbers, real offers. Example: "Tile install from $12/sq ft" not "affordable prices".

RULE 3 - TARGET AUDIENCE: Content must make northwest Chicago suburbs homeowners feel "they understand me". Reflect their lifestyle, aspirations, and local context. Speak to someone investing in their home, not a generic buyer.

RULE 4 - FUNNEL & CUSTOMER JOURNEY: Every piece of content is either:
- TOP OF FUNNEL (awareness/warm-up): show transformation, build trust, share social proof -- no hard sell
- BOTTOM OF FUNNEL (ready to buy): direct CTA, pricing, contact info, urgency
Flag which stage this content targets and whether the caption matches it.

RULE 5 - CTA DEPTH:
- Small depth (top of funnel): like, comment, share, save
- Medium depth (mid funnel): DM, message on Facebook, fill a form on the same platform
- Large depth (bottom of funnel): call us, visit website, fill a form on external site
For high-ticket remodeling, warm-up content with small/medium CTA depth must outnumber direct-response posts. Flag if CTA depth is mismatched for the content's funnel stage.

RULE 6 - CONTACT INFO: Only ONE contact method per post. If CTA is "call us" -- show only the phone number. If CTA is "visit our site" -- show only the website URL. Never mix both in the same post.

RULE 7 - PLATFORM ADAPTATION:
- Facebook: post starts with TEXT. Main message must be in the caption; image is supplementary. CTA button appears bottom-right.
- Instagram: post starts with IMAGE. Main message should be ON the image itself; caption adds detail.
Always adapt the caption structure and CTA placement accordingly.`;

const IMAGE_EDITING_SECTION = `**🖼️ Креатив -- что добавить/изменить (инструкции для Canva/Photoshop):**
Только конкретные дизайн-решения. Коротко, как арт-директор на брифинге:
- **Логотип:** позиция + размер + цвет + opacity (пр: "нижний правый, 12% ширины, белый, 70%")
- **Текст на фото:** точный текст + позиция + стиль (пр: "'Done in 10 Days' -- нижняя треть, белый bold 48pt, подложка #000 50%")
- **Кадрирование:** что убрать и зачем (пр: "обрезать 15% снизу -- убрать мусор, акцент на плитку")
- **До/после:** нужна ли раскладка и как (пр: "вертикальный сплит 50/50, плашки 'BEFORE'/'AFTER' сверху")
- **Графика:** бейджи, стрелки, локация-тег (пр: "бейдж 'Free Estimate' -- верхний левый, белый на #1a1a2e круге"; "pin 'Buffalo Grove, IL' -- нижний левый")
- **Цветокоррекция:** конкретная правка (пр: "тепло +15, контраст +10 -- убрать холодную синеву")
- **Контакт на фото:** что и где (пр: "телефон -- нижний левый, белый 16pt, под логотипом")
- **Маркетинговый приём:** оверлей с отзывом, статистика, элемент срочности (пр: "'2 spots left in April' -- яркая плашка сверху")`;

const CLARIFYING_QUESTIONS_RULE = `Если критически важная информация неизвестна -- задай максимум 1-2 вопроса в конце. Только если ответ реально изменит рекомендации. Примеры: "Жилой или коммерческий?", "До или после?", "Какой район?", "Есть фото 'до'?". Если всё ясно -- не спрашивай.`;

// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a smart personal assistant and senior marketing expert for Ulik, owner of Hammer Remodeling LLC.

${BRAND_KNOWLEDGE}

## Your capabilities
1. **Everyday tasks** -- reminders, to-do lists, answering questions, translations, calculations, advice
2. **Marketing for Hammer Remodeling** -- write social media posts (Facebook, Instagram, Nextdoor), ad copy, Google Ads headlines/descriptions, email campaigns, promotional offers
3. **Content creation** -- blog post ideas, captions, hashtags, before/after post scripts, seasonal promotions
4. **Competitor & market analysis** -- insights on remodeling market trends, local competition, pricing strategies, customer pain points
5. **General business advice** -- lead generation ideas, customer follow-up scripts, review response templates, referral program ideas

## When writing any marketing content, always:
- Include at least one of the 3 brand pillars (quality/speed/transparency)
- Speak to NW Chicago suburbs homeowners ($150k-$300k+ income, single-family home owners)
- Address at least one client fear when relevant
- Use specific numbers and concrete language -- never vague phrases
- Include the correct hashtag sets
- Mention a specific suburb (not just "Chicago")
- Match content type to funnel stage

Respond in the same language the user writes in (English or Russian or any other language).`;

const POST_REVIEW_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Review the following Facebook post draft.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the "Suggested post:" section which must always be in English.

**Анализ текста:**
1. Столпы бренда ✅/❌ -- один из трёх отражён?
2. Страх клиента ✅/❌ -- хотя бы один затронут?
3. Хук ✅/❌ -- первая строка цепляет?
4. Лексика ✅/❌ -- нет клише и пустых слов?
5. Целевая аудитория ✅/❌ -- жители пригородов Чикаго узнают себя?
6. Конкретный пригород ✅/❌ -- упомянут?
7. Тип контента -- before/after / process / educational / social proof / offer?
8. Этап воронки + глубина CTA ✅/❌ -- совпадают?
9. Контактная информация ✅/❌ -- только один способ связи?
10. Хештеги ✅/❌ -- обязательный набор + локальные?
11. Грамматика ✅/❌

**Оценка: X/10** -- одно предложение: главная проблема или главный плюс.

**Suggested post:** (in English -- strong hook, brand pillar, client fear, specific suburb, concrete numbers, correct CTA depth, single contact, correct hashtags, no vague phrases)

Завершить: "Ответьте *ok* для публикации или напишите правки."`;

const POST_REVIEW_WITH_PHOTO_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Photo + caption review. Think and respond like a busy creative director: short, direct, punchy. One sentence per point. No fluff.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the "Suggested post:" section which must be in English.

**Фото:**
1. Реальное фото с объекта ✅/❌
2. Качество (резкость, свет, композиция) ✅/❌
3. Тема (ремонт/стройка) ✅/❌
4. Чистый кадр (нет лишнего) ✅/❌
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
11. Хештеги (обязательные + локальные) ✅/❌
12. Тон (без клише) ✅/❌
13. Грамматика ✅/❌

**Оценка: X/10** -- одно предложение: главная проблема или главный плюс.

**Suggested post:** (in English -- strong hook, brand pillar, client fear, specific suburb, concrete numbers, correct CTA depth, single contact, correct hashtags, no vague phrases)

${CLARIFYING_QUESTIONS_RULE}

Завершить: "Ответьте *ok* для публикации или напишите правки."`;

const POST_APPLY_CORRECTION_PROMPT = `You are a social media copywriter for Hammer Remodeling LLC.

${BRAND_KNOWLEDGE}

The user has a Facebook post draft and wants to apply corrections to it. Given the original post and the user's correction instructions, produce only the updated post text in English -- nothing else, no explanations, no labels. The updated post must still follow brand rules: no vague phrases, at least one brand pillar, specific suburb if relevant, correct hashtag sets.`;

const PHOTO_CAPTION_SUGGEST_PROMPT = `You are a senior marketing expert for Hammer Remodeling LLC. Photo without caption -- analyze and suggest 3 options. Think like a busy creative director: short, direct, punchy. One sentence per point. No fluff.

${BRAND_KNOWLEDGE}

${MARKETING_RULES}

Respond ENTIRELY in Russian -- EXCEPT the three caption options which must be in English.

**Фото:**
1. Реальное фото с объекта ✅/❌
2. Качество (резкость, свет, композиция) ✅/❌
3. Тема (ремонт/стройка) ✅/❌
4. Чистый кадр (нет лишнего) ✅/❌
5. Трансформация/результат виден ✅/❌
6. Эмоциональный отклик ✅/❌
7. Соответствие бренду ✅/❌

**Потенциал: X/10** -- одно предложение.

${IMAGE_EDITING_SECTION}

**Продвижение:**
- Тип контента: before/after / process / educational / social proof / offer
- Воронка + глубина CTA (Правила 4-5)
- Facebook vs Instagram (Правило 7)

**Варианты подписи (на английском) -- каждый должен:**
- Содержать столп бренда + конкретику (числа, пригород) + правильные хештеги + CTA по воронке

1. [Прямой/профессиональный -- сильный хук с деталью или цифрой, страх клиента, CTA]

2. [Story-driven -- история жителя пригорода Чикаго, столп бренда, конкретный пригород, CTA]

3. [Короткий и дерзкий -- смелый открывашка, один столп бренда, срочный CTA]

${CLARIFYING_QUESTIONS_RULE}

Завершить (на русском): "Выберите вариант (1, 2 или 3) или напишите пожелания по тексту."`;

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

// Extract the three numbered captions from Claude's suggestion response
function extractCaptions(responseText) {
  const matches = [...responseText.matchAll(/^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.|\n\n[^\d]|$)/gms)];
  // Filter out very short matches that are likely analysis lines, not captions
  return matches.map(m => m[1].trim()).filter(c => c.length > 40);
}

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  return conversations.get(chatId);
}

function trimHistory(history, maxMessages = 20) {
  if (history.length > maxMessages) {
    history.splice(0, history.length - maxMessages);
  }
}

async function askClaude(chatId, userMessage) {
  const history = getHistory(chatId);

  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantMessage = response.content[0].text;
  history.push({ role: 'assistant', content: assistantMessage });

  return assistantMessage;
}

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
  // Text-only post
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
    { message: text, access_token: FB_PAGE_ACCESS_TOKEN }
  );
  return res.data;
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

// ---------------------------------------------------------------------------
// Bot commands
// ---------------------------------------------------------------------------

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(
    chatId,
    `Hey ${name}! I'm your personal assistant and marketing expert for Hammer Remodeling LLC.\n\nI can help you with:\n• Everyday tasks (lists, questions, translations)\n• Marketing & social media posts for Hammer Remodeling\n• Photo + caption review and Facebook publishing\n• Market research & competitor insights\n• Anything else you need\n\nJust type your message and I'll get right on it!`
  );
});

bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, []);
  bot.sendMessage(chatId, 'Conversation history cleared. Fresh start!');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*Available commands:*\n\n/start -- Welcome message\n/clear -- Clear conversation history\n/post [text] -- Review & publish a text post to Facebook\n/help -- Show this message\n\n*What I can do:*\n• Answer any question\n• Write marketing content for Hammer Remodeling\n• Review & publish posts to Facebook (text, photo, video)\n• Analyze photos against brand standards\n• Translate text\n• Competitor & market analysis\n• And much more -- just ask!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/post (.+)/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const postText = match[1].trim();
  await handlePostFlow(chatId, postText);
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Handle photo -- download first, then branch on caption presence
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    bot.sendChatAction(chatId, 'typing');
    let imageBase64;
    try {
      const fileLink = await bot.getFileLink(fileId);
      const imageData = await axios.get(fileLink, { responseType: 'arraybuffer' });
      imageBase64 = Buffer.from(imageData.data).toString('base64');
    } catch (err) {
      console.error('Error downloading photo:', err.message);
      bot.sendMessage(chatId, 'Could not download the photo. Please try again.');
      return;
    }

    if (msg.caption) {
      // Photo WITH caption -- vision-review and start post flow
      await handlePostFlow(chatId, msg.caption, { type: 'photo', fileId, imageBase64 });
    } else {
      // Photo WITHOUT caption -- analyze and suggest 3 captions
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

  // Handle video with caption -- treat as a post draft
  if (msg.video && msg.caption) {
    await handlePostFlow(chatId, msg.caption, { type: 'video', fileId: msg.video.file_id });
    return;
  }

  // Skip commands (handled above) and non-text messages
  if (!text || text.startsWith('/')) return;

  // If there's an active caption selection session, handle pick or correction
  if (captionSessions.has(chatId)) {
    const session = captionSessions.get(chatId);
    const pick = text.trim();
    const picked = { '1': 0, '2': 1, '3': 2 }[pick];

    if (picked !== undefined && session.captions[picked]) {
      captionSessions.delete(chatId);
      await handlePostFlow(chatId, session.captions[picked], session.pendingMedia);
    } else {
      // Treat as correction instructions or clarifying question answers -- re-generate captions
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
              { type: 'text', text: `Additional context / feedback from user: ${text}` },
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

  // If there's an active post session, handle approval or correction
  if (postSessions.has(chatId)) {
    const session = postSessions.get(chatId);
    const normalized = text.trim().toLowerCase();

    if (normalized === 'ok' || normalized === 'ок') {
      postSessions.delete(chatId);
      bot.sendChatAction(chatId, 'typing');
      try {
        await publishToFacebook(session.text, session.pendingMedia);
        bot.sendMessage(chatId, 'Posted to Facebook successfully!');
      } catch (err) {
        console.error('Facebook publish error:', err.response?.data || err.message);
        bot.sendMessage(chatId, `Failed to publish to Facebook: ${err.response?.data?.error?.message || err.message}`);
      }
    } else {
      // User sent corrections or answered clarifying questions -- re-apply and re-review
      postSessions.delete(chatId);
      bot.sendChatAction(chatId, 'typing');
      try {
        const updatedText = await applyCorrection(session.text, text, session.pendingMedia?.imageBase64 ?? null);
        await handlePostFlow(chatId, updatedText, session.pendingMedia);
      } catch (err) {
        console.error('Error applying correction:', err.message);
        bot.sendMessage(chatId, 'Something went wrong while applying corrections. Please try again.');
      }
    }
    return;
  }

  // Regular conversation
  bot.sendChatAction(chatId, 'typing');

  try {
    const reply = await askClaude(chatId, text);
    bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error calling Claude API:', err.message);

    if (err.status === 401) {
      bot.sendMessage(chatId, 'API key error. Please check that ANTHROPIC_API_KEY is set correctly.');
    } else if (err.status === 429) {
      bot.sendMessage(chatId, 'Too many requests. Please wait a moment and try again.');
    } else {
      bot.sendMessage(chatId, 'Something went wrong. Please try again.');
    }
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Bot is running...');
