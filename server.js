require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Keep requests small enough to stay comfortably inside Groq's free rate
// limits and avoid a single oversized payload timing out.
const MAX_SENTENCES = 120;
const MAX_CHARS_PER_SENTENCE = 600;

// Images arrive as base64 data URLs, which run noticeably bigger than
// the raw file — 10mb comfortably covers a typical phone photo.
app.use(express.json({ limit: '10mb' }));

// Serve the three frontend files directly from the repo root — no
// subfolder needed, so no slash to type or mistype when creating files
// through GitHub's mobile web upload.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

const OWNER_KEY = process.env.OWNER_KEY;

const HUMANIZE_SYSTEM_PROMPT = `You are a ghostwriter rewriting AI-drafted prose so it reads like one specific, slightly imperfect human author wrote it on deadline — not polished, not symmetrical, not safe.

Follow these rules exactly:

1. Vary sentence length aggressively. Never let three sentences in a row run the same length or rhythm. Follow a long sentence with a short one, or a fragment.

2. Never open two sentences in the same paragraph with the same word or the same grammatical construction. No repeated "He didn't... / She didn't..." patterns. No repeated "[Name] [verb]ed" openers back to back.

3. Cut any line that explains a character's emotion directly ("she felt sad", "he was relieved"). Show it through one concrete action or one piece of blunt dialogue instead.

4. Delete clever or compressed similes and metaphors ("like a wound that never closed"). If a comparison is truly needed, make it plain and almost too simple — not literary.

5. Make dialogue sound like real interrupted speech: people talk over each other, trail off, answer the wrong question, don't finish sentences. No character delivers a tidy, quotable "thesis statement" line.

6. Cut aphoristic one-liners entirely ("Money is never free." "Silence can be louder than words."). If a sentence sounds like it belongs on a poster, make it blunter and less symmetrical, or cut it.

7. Use plain, everyday vocabulary — nothing a careful ordinary writer wouldn't reach for. No thesaurus words.

8. Small imperfection is good: a sentence that trails off, a one-line paragraph, slightly uneven pacing.

9. No formulaic transitions ("Meanwhile," "Little did she know," "As the sun set over...").

10. Keep paragraphs short and uneven in length, not uniform blocks.

This is a style rewrite only — preserve every fact, plot point, and character detail exactly. Do not add new claims, dialogue, or events that weren't in the original. Do not change the point of view or tense.

Respond with ONLY the rewritten text. No preamble, no explanation, no quotation marks wrapping it.`;

const IMAGE_SYSTEM_PROMPT = `You are an expert at spotting AI-generated images (Midjourney, DALL-E, Stable Diffusion, Flux, and similar tools).

Look closely at the image for telltale signs: unnatural skin texture, warped or extra fingers, inconsistent lighting or shadows, garbled or nonsensical text, overly smooth or waxy surfaces, impossible reflections, asymmetric earrings/eyes/objects that should match, and backgrounds that don't quite make physical sense.

Note: this check is for AI-GENERATED images specifically, not for edited or doctored real photos/screenshots (like a faked bank balance) — that is a different kind of manipulation this check is not built to catch.

Respond with ONLY valid JSON in this exact shape, no other text:
{"aiScore": 0.0, "verdict": "short 4-8 word summary", "reasoning": "2-3 sentences explaining the specific visual evidence you saw"}

aiScore is 0-1: 0 means clearly a real photo/human-made image, 1 means clearly AI-generated.`;

app.post('/api/detect-image', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GEMINI_API_KEY. Add it to your .env file and restart.',
      });
    }

    const imageDataUrl = req.body && req.body.image ? String(req.body.image) : '';
    const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Upload an image first.' });
    }
    const [, mimeType, base64Data] = match;

    const geminiBody = JSON.stringify({
      contents: [
        {
          parts: [
            { text: IMAGE_SYSTEM_PROMPT },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    // Gemini's free tier occasionally returns a transient "overloaded"
    // error under demand spikes. One quick retry clears most of these
    // without the user needing to tap the button again themselves.
    let response;
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: geminiBody,
      });
      data = await response.json();
      if (response.ok) break;
      const isOverloaded = data && data.error && /overload|high demand|503/i.test(data.error.message || '');
      if (!isOverloaded || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!response.ok) {
      const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const raw = data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts.map((p) => p.text || '').join('')
      : null;
    if (!raw) throw new Error('Empty response from model.');

    const parsed = JSON.parse(raw);
    const aiScore = Math.max(0, Math.min(1, Number(parsed.aiScore) || 0));

    res.json({
      aiScore,
      verdict: parsed.verdict || '',
      reasoning: parsed.reasoning || '',
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Image check failed: ${err.message}` });
  }
});

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

const SYSTEM_PROMPT = `You are a strict AI-text auditor, the kind of editor who has read thousands of AI outputs and is hard to fool. The text may be fiction (such as web novel chapters), a how-to guide, or a chat-style reply, in English, Nigerian Pidgin, or a mix. You will receive a numbered list of sentences from one piece of writing.

For EACH sentence, score how likely it is that an AI wrote it rather than a person.

Judge pattern and structure, never polish or spelling:
- Clean grammar and punctuation are NOT evidence of AI.
- Typos, slang, dialect, Nigerian Pidgin and missing punctuation are NOT evidence of a human. AI writes in any dialect and can fake mistakes.

Signs of AI in prose:
- generic or exaggerated descriptors; compressed, overly clever similes
- the same sentence skeleton repeated several times in a row (for example "[Name] + verb + what they own" over and over)
- uniform sentence length or paragraph length
- lists of three; "not just X, it's Y" phrasing; neat summary lines that close a paragraph
- formulaic transitions and cliched phrases
- a narrator explaining a character's feelings instead of showing them
- characters explaining things to each other that both already know
- dialogue too polished or too complete for anyone to say out loud
- vague big words where a specific detail should be

Signs of an AI chatbot reply:
- numbered or bulleted step lists, tiers or levels ("Level 1, Level 2"), bold or asterisk markup, headings, emoji
- a friendly hype opener or praise for the idea
- reassuring absolutes such as "100% safe"
- every item given the same format and weight, like a price list
- a closing line that offers a next step or asks which option the reader wants

Signs of a human:
- an odd or unexpected detail that does no work for the main point
- uneven rhythm, a fragment, an abrupt turn
- opinion, humor, a slip in logic, a real personal voice

Scoring rules:
- Judge the piece as a whole first. If it shows three or more AI signs, "overall" must be at least 0.7. If it is a chat-style reply (a step list or levels plus a closing offer), "overall" must be at least 0.85.
- A sentence that belongs to an AI pattern (a numbered step, a bold item, a list entry, a closing offer) scores at least 0.7, even if it looks harmless alone.
- Score a sentence below 0.3 only if it shows a sign of a human. If you cannot tell, score it 0.5, not lower.
- Use the full range from 0 to 1. Do not bunch scores around the middle.

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
      max_completion_tokens: 10000,
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

app.post('/api/humanize', async (req, res) => {
  try {
    const ownerKey = req.body && req.body.ownerKey ? String(req.body.ownerKey) : '';
    const isOwner = Boolean(OWNER_KEY) && ownerKey === OWNER_KEY;

    if (!isOwner) {
      return res.status(402).json({
        error: 'This is a premium feature. Payment isn\u2019t wired up yet \u2014 message the site owner for access.',
        paymentRequired: true,
      });
    }

    if (!GROQ_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GROQ_API_KEY. Add it to your .env file and restart.',
      });
    }

    const text = (req.body && req.body.text ? String(req.body.text) : '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Paste some text first.' });
    }

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 1.0,
        max_completion_tokens: 10000,
        messages: [
          { role: 'system', content: HUMANIZE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data && data.error ? data.error.message || data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    const rewritten = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (!rewritten) throw new Error('Empty response from model.');

    res.json({ rewritten: rewritten.trim() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: `Humanize request failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Is This Yours? running at http://localhost:${PORT}`);
});
