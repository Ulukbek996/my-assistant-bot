const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const BOT_TOKEN = '8794427596:AAEVIDJFLJHb8tWjwKZ0aHMpCUXOExrQzRg';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Conversation history per chat
const conversations = new Map();

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

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'there';
  bot.sendMessage(
    chatId,
    `Hey ${name}! I'm your personal assistant.\n\nI can help you with:\n• Everyday tasks (lists, questions, translations)\n• Marketing for Hammer Remodeling LLC\n• Social media posts & ad copy\n• Market research & competitor insights\n• Anything else you need\n\nJust type your message and I'll get right on it!`
  );
});

// /clear command — reset conversation history
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
    `*Available commands:*\n\n/start — Welcome message\n/clear — Clear conversation history\n/help — Show this message\n\n*What I can do:*\n• Answer any question\n• Write marketing content for Hammer Remodeling\n• Draft social media posts & ads\n• Translate text\n• Make lists & reminders\n• Analyze competitors & market trends\n• And much more — just ask!`,
    { parse_mode: 'Markdown' }
  );
});

// Handle all regular messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip commands (handled above)
  if (!text || text.startsWith('/')) return;

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
