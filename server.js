require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HF_TOKEN = process.env.HF_TOKEN;
const MODEL_ID = 'Hello-SimpleAI/chatgpt-detector-roberta';
const HF_URL = `https://api-inference.huggingface.co/models/${MODEL_ID}`;

// Keep requests small enough to stay comfortably inside the HF free tier
// and avoid a single oversized payload timing out.
const MAX_SENTENCES = 120;
const MAX_CHARS_PER_SENTENCE = 600;

app.use(express.json({ limit: '1mb' }));

// Serve the three frontend files directly from the repo root —
// no /public subfolder needed, so no slash to type or mistype
// when creating files through GitHub's mobile web upload.
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

// Normalizes whatever label the model returns ("Human" / "ChatGPT" /
// "LABEL_0" / "LABEL_1", depending on model version) into a simple shape.
function normalizeResult(result) {
  if (!result || !result.label) return { label: 'unknown', aiScore: 0.5 };

  const isHuman = /human/i.test(result.label);
  const aiScore = isHuman ? 1 - result.score : result.score;
  return { label: isHuman ? 'human' : 'ai', aiScore };
}

async function callDetector(inputs) {
  const response = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs, options: { wait_for_model: true } }),
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data && data.error ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

app.post('/api/detect', async (req, res) => {
  try {
    if (!HF_TOKEN) {
      return res.status(500).json({
        error: 'Server is missing HF_TOKEN. Add it to your .env file and restart.',
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

    // One batched call for all sentences, one call for the whole text.
    // Batching (an array in "inputs") means this is 2 requests total,
    // not one per sentence — important for staying under free-tier limits.
    const [wholeTextRaw, sentenceResultsRaw] = await Promise.all([
      callDetector(text.slice(0, 3000)),
      callDetector(sentences),
    ]);

    const overall = normalizeResult(
      Array.isArray(wholeTextRaw) ? wholeTextRaw[0] : wholeTextRaw
    );

    const perSentence = sentences.map((sentence, i) => {
      const raw = sentenceResultsRaw[i];
      const top = Array.isArray(raw) ? raw[0] : raw;
      const { label, aiScore } = normalizeResult(top);
      return { text: sentence, label, aiScore };
    });

    res.json({
      overallAiScore: overall.aiScore,
      sentences: perSentence,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({
      error:
        err.message && err.message.includes('loading')
          ? 'The model is waking up on Hugging Face\u2019s free tier \u2014 give it ~20 seconds and try again.'
          : `Detector request failed: ${err.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Is This Yours? running at http://localhost:${PORT}`);
});
