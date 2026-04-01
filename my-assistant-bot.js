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

const SYSTEM_PROMPT = `You are a smart personal assistant for Ulik. You help with any everyday tasks and also have deep knowledge about Hammer Remodeling LLC for marketing tasks.

## About Hammer Remodeling LLC
- **Company:** Hammer Remodeling LLC
- **Services:** Bathroom and kitchen remodeling
- **Service area:** Arlington Heights, Buffalo Grove, Palatine, Schaumburg (northwest Chicago suburbs)
- **Tagline:** "Clear estimate before we start. No hidden fees"
- **Team:** European-trained professionals
- **Differentiators:** Transparent pricing, no hidden fees, skilled European-trained craftsmen, local to northwest Chicago suburbs

## Your capabilities
1. **Everyday tasks** — reminders, to-do lists, answering questions, translations, calculations, advice
2. **Marketing for Hammer Remodeling** — write social media posts (Facebook, Instagram, Nextdoor), ad copy, Google Ads headlines/descriptions, email campaigns, promotional offers
3. **Content creation** — blog post ideas, captions, hashtags, before/after post scripts, seasonal promotions
4. **Competitor & market analysis** — insights on remodeling market trends, local competition, pricing strategies, customer pain points
5. **General business advice** — lead generation ideas, customer follow-up scripts, review response templates, referral program ideas

## Tone & style
- Be concise and practical
- For marketing content, match the brand voice: trustworthy, professional, local, transparent
- When writing social media posts, include relevant hashtags unless asked otherwise
- Always be helpful and proactive — if you see an opportunity to make something better, mention it

Respond in the same language the user writes in (English or Russian or any other language).`;

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

const POST_REVIEW_PROMPT = `You are a social media content reviewer for Hammer Remodeling LLC (bathroom and kitchen remodeling in northwest Chicago suburbs).

Review the following Facebook post draft against these criteria:
1. Clear and professional tone
2. Relevant to home remodeling (bathroom/kitchen)
3. Has a call to action
4. Appropriate length (50-300 words)
5. No grammatical errors

Respond ENTIRELY in Russian (feedback, evaluation, everything) -- EXCEPT the "Suggested post:" section which must always be in English, since it will be published to an American audience on Facebook.

Respond with:
- A brief evaluation for each criterion in Russian (pass/fail + one sentence)
- A "Suggested post:" section with an improved version in English (always include this section)
- End with: "Ответьте *ok* для публикации или напишите правки."`;

// Shared marketing rules injected into both photo-related prompts
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

const POST_REVIEW_WITH_PHOTO_PROMPT = `You are a senior marketing expert specializing in home remodeling businesses. You are reviewing a Facebook post for Hammer Remodeling LLC -- a premium bathroom and kitchen remodeling company in the northwest Chicago suburbs. Be strict and honest. Do not give empty praise. Flag every rule violation clearly.

${MARKETING_RULES}

The user has submitted a photo with a caption. Analyze both together using the rules above.

Respond ENTIRELY in Russian -- EXCEPT the "Suggested post:" section which must be in English.

**Анализ фото:**
1. Качество фото -- резкость, освещение, композиция (Правило 1) ✅/❌ -- одно предложение
2. Соответствие теме -- ванная/кухня, ремонт ✅/❌ -- одно предложение
3. Профессиональный вид -- нет лишних предметов, чисто, аккуратно ✅/❌ -- одно предложение
4. Потенциал "до/после" -- показывает ли трансформацию или результат ✅/❌ -- одно предложение
5. Эмоциональный отклик -- хочется ли это иметь у себя дома ✅/❌ -- одно предложение
6. Соответствие бренду -- выглядит ли это как премиальная компания ✅/❌ -- одно предложение

**Рекомендации по улучшению фото:**
- Что добавить на изображение: логотип, текст-оверлей, контакты, раскладка "до/после" и т.д.
- Этап воронки, которому лучше всего соответствует это фото (Правило 4)
- Подходящая глубина CTA для этого этапа воронки (Правило 5)
- Адаптация под Facebook vs Instagram: что изменить для каждой платформы (Правило 7)

**Анализ подписи:**
1. Хук -- захватывает ли первая строка внимание (Правило 1) ✅/❌ -- одно предложение
2. Лексика -- нет ли размытых слов, есть ли конкретика и цифры (Правило 2) ✅/❌ -- одно предложение
3. Целевая аудитория -- узнают ли себя жители пригородов Чикаго (Правило 3) ✅/❌ -- одно предложение
4. Этап воронки -- соответствует ли текст этапу, которому служит фото (Правило 4) ✅/❌ -- одно предложение
5. Глубина CTA -- соответствует ли глубина действия этапу воронки (Правило 5) ✅/❌ -- одно предложение
6. Контактная информация -- один способ связи или несколько (Правило 6) ✅/❌ -- одно предложение
7. Адаптация под Facebook -- текст впереди, образ дополняет (Правило 7) ✅/❌ -- одно предложение
8. Хештеги -- релевантные, 5-10 штук ✅/❌ -- одно предложение
9. Тон -- профессиональный, но тёплый ✅/❌ -- одно предложение
10. Грамматика ✅/❌ -- одно предложение

**Общая оценка: X/10**
Напиши 2-3 предложения: что именно делает этот пост сильным или слабым с маркетинговой точки зрения и что конкретно повысит его эффективность.

Затем:
**Suggested post:** (in English -- improved caption following all 7 rules: flows naturally, specific language with numbers, speaks to northwest Chicago suburbs homeowners, matches funnel stage, appropriate CTA depth, single contact method, Facebook-first structure, 5-10 hashtags)

Завершить: "Ответьте *ok* для публикации или напишите правки."`;

const POST_APPLY_CORRECTION_PROMPT = `You are a social media copywriter for Hammer Remodeling LLC (bathroom and kitchen remodeling in northwest Chicago suburbs).

The user has a Facebook post draft and wants to apply corrections to it. Given the original post and the user's correction instructions, produce only the updated post text in English -- nothing else, no explanations, no labels.`;

async function reviewPost(postText) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
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

const PHOTO_CAPTION_SUGGEST_PROMPT = `You are a senior marketing expert specializing in home remodeling businesses. You are creating Facebook content for Hammer Remodeling LLC -- a premium bathroom and kitchen remodeling company in the northwest Chicago suburbs. Be strict and honest. Do not give empty praise.

${MARKETING_RULES}

The user has sent a photo without a caption. Analyze the photo using the rules above and suggest three caption options.

Respond ENTIRELY in Russian -- EXCEPT the three caption options which must be in English.

**Анализ фото:**
1. Качество фото -- резкость, освещение, композиция (Правило 1) ✅/❌ -- одно предложение
2. Соответствие теме -- ванная/кухня, ремонт ✅/❌ -- одно предложение
3. Профессиональный вид -- нет лишних предметов, чисто, аккуратно ✅/❌ -- одно предложение
4. Потенциал "до/после" -- показывает ли трансформацию или результат ✅/❌ -- одно предложение
5. Эмоциональный отклик -- хочется ли это иметь у себя дома ✅/❌ -- одно предложение
6. Соответствие бренду -- выглядит ли это как премиальная компания ✅/❌ -- одно предложение

**Маркетинговый потенциал фото: X/10**
Напиши 1-2 предложения: насколько это фото эффективно для продвижения и что можно улучшить при съёмке в следующий раз.

**Рекомендации по улучшению:**
- Что добавить на изображение: логотип, текст-оверлей, контакты, раскладка "до/после" и т.д.
- Этап воронки, которому лучше всего соответствует это фото (Правило 4)
- Подходящая глубина CTA для этого этапа воронки (Правило 5)
- Адаптация под Facebook vs Instagram: что изменить для каждой платформы (Правило 7)

**Варианты подписи (на английском):**

1. [Professional tone -- strong hook with a specific detail or number, clear value proposition, CTA matching funnel stage, 5-10 hashtags]

2. [Story-driven/emotional tone -- connects with northwest Chicago suburbs homeowner aspirations, CTA matching funnel stage, 5-10 hashtags]

3. [Short and punchy -- bold opener, one concrete value statement, urgent CTA, 5-10 hashtags]

Завершить (на русском): "Выберите вариант (1, 2 или 3) или напишите пожелания по тексту."`;

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

async function publishToFacebook(text, media) {
  if (media) {
    if (media.type === 'photo') {
      // Upload photo and attach to post
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
      // Upload video and attach to post
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

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(
    chatId,
    `Hey ${name}! I'm your personal assistant.\n\nI can help you with:\n• Everyday tasks (lists, questions, translations)\n• Marketing for Hammer Remodeling LLC\n• Social media posts & ad copy\n• Market research & competitor insights\n• Anything else you need\n\nJust type your message and I'll get right on it!`
  );
});

// /clear command -- reset conversation history
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  conversations.set(chatId, []);
  bot.sendMessage(chatId, 'Conversation history cleared. Fresh start!');
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*Available commands:*\n\n/start -- Welcome message\n/clear -- Clear conversation history\n/post [text] -- Review & publish a post to Facebook\n/help -- Show this message\n\n*What I can do:*\n• Answer any question\n• Write marketing content for Hammer Remodeling\n• Draft social media posts & ads\n• Review & publish posts to Facebook (with photos/videos)\n• Translate text\n• Make lists & reminders\n• Analyze competitors & market trends\n• And much more -- just ask!`,
    { parse_mode: 'Markdown' }
  );
});

// /post command
bot.onText(/\/post (.+)/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const postText = match[1].trim();
  await handlePostFlow(chatId, postText);
});

// Handle all regular messages
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
      // Treat as correction instructions -- re-generate captions with this feedback
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
              { type: 'text', text: `Please suggest three new caption options. User feedback: ${text}` },
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
      // User sent corrections -- apply them to the existing post and re-review
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

  // Show typing indicator
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

// Handle polling errors
bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('Bot is running...');
