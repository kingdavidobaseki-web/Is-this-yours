require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Keep requests small enough to stay comfortably inside Groq's free rate
// limits and avoid a single oversized payload timing out.
const MAX_SENTENCES = 120;
const MAX_CHARS_PER_SENTENCE = 600;

app.use(express.json({ limit: '1mb' }));

// Serve the three frontend files directly from the repo root — no
// subfolder needed, so no slash to type or mistype when creating files
// through GitHub's mobile web upload.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Very small sentence splitter. Good enough for prose; not meant to be
// a full NLP tokenizer. Keeps abbreviations like "Mr." from exploding
// into their own fragment by requiring a capital letter or quote to follow.
function splitIntoSentences(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const matches = normalized.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [];
  return matches
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_SENTENCES)
    .map((s) =>
      s.length > MAX_CHARS_PER_SENTENCE ? s.slice(0, MAX_CHARS_PER_SENTENCE) : s
    );
}

const SYSTEM_PROMPT = `You are an expert editor who spots AI-generated prose inside creative writing, especially web novel chapters. You will receive a numbered list of sentences from one chapter.

For EACH sentence, judge how likely it is to have been written by an AI rather than a human author. Weigh things like: generic or exaggerated descriptors, compressed/overly clever similes, uniform sentence rhythm across the piece, formulaic transitions, explicit narrator explanations of a character's feelings, cliched phrase patterns, and over-polished dialogue that no one would actually say out loud.

Respond with ONLY valid JSON in this exact shape, no other text:
{"overall": 0.0, "sentences": [{"i": 1, "score": 0.0}, {"i": 2, "score": 0.0}]}

"overall" is your 0-1 estimate for the whole passage. Each "score" is 0-1 for that one sentence. 0 means clearly human-written, 1 means clearly AI-written. Include every sentence number exactly once, in order.`;

async function callDetector(sentences) {
  const numbered = sentences.map((s, i) => `${i + 1}: ${s}`).join('\n');

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: numbered },
      ],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const raw = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (!raw) throw new Error('Empty response from model.');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Model returned text that was not valid JSON.');
  }

  return parsed;
}

app.post('/api/detect', async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GROQ_API_KEY. Add it to your .env file and restart.',
      });
    }

    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Paste some text first.' });
    }

    const sentences = splitIntoSentences(text);
    if (sentences.length === 0) {
      return res.status(400).json({ error: "Couldn't find any sentences in that." });
    }

    const result = await callDetector(sentences);

    const scoreByIndex = new Map(
      (result.sentences || []).map((s) => [s.i, s.score])
    );

    const perSentence = sentences.map((sentence, idx) => {
      const score = scoreByIndex.has(idx + 1) ? scoreByIndex.get(idx + 1) : 0.5;
      const clamped = Math.max(0, Math.min(1, Number(score) || 0));
      return { text: sentence, label: clamped >= 0.5 ? 'ai' : 'human', aiScore: clamped };
    });

    const overall =
      typeof result.overall === 'number'
        ? Math.max(0, Math.min(1, result.overall))
        : perSentence.reduce((sum, s) => sum + s.aiScore, 0) / perSentence.length;

    res.json({
      overallAiScore: overall,
      sentences: perSentence,
    });
  } catch (err) {
    console.error(err);
    const isRateLimit = err.message && /rate.?limit/i.test(err.message);
    res.status(502).json({
      error: isRateLimit
        ? 'Hit Groq\u2019s free-tier rate limit \u2014 wait a minute and try again.'
        : `Detector request failed: ${err.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Is This Yours? running at http://localhost:${PORT}`);
});
