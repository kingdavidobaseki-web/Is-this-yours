const form = document.getElementById('checkForm');
const textarea = document.getElementById('manuscript');
const wordCountEl = document.getElementById('wordCount');
const checkBtn = document.getElementById('checkBtn');
const errorEl = document.getElementById('errorMsg');
const results = document.getElementById('results');
const stampEl = document.getElementById('stamp');
const scoreValueEl = document.getElementById('scoreValue');
const annotatedEl = document.getElementById('annotated');

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

textarea.addEventListener('input', () => {
  const n = countWords(textarea.value);
  wordCountEl.textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
});

function riskClass(aiScore) {
  if (aiScore >= 0.65) return 'risk-high';
  if (aiScore >= 0.35) return 'risk-mid';
  return 'risk-low';
}

function stampFor(overallAiScore) {
  if (overallAiScore >= 0.65) {
    return { className: 'ai', text: 'reads as AI' };
  }
  if (overallAiScore >= 0.35) {
    return { className: 'mixed', text: 'mixed signals' };
  }
  return { className: 'human', text: 'reads as human' };
}

function renderAnnotated(sentences) {
  annotatedEl.innerHTML = '';
  sentences.forEach((s) => {
    const span = document.createElement('span');
    span.className = `sentence ${riskClass(s.aiScore)}`;
    span.textContent = s.text + ' ';
    span.title = `${Math.round(s.aiScore * 100)}% AI-pattern score`;
    annotatedEl.appendChild(span);
  });
}

function setLoading(isLoading) {
  checkBtn.disabled = isLoading;
  checkBtn.textContent = isLoading ? 'Checking…' : 'Check the text';
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  results.hidden = true;

  const text = textarea.value.trim();
  if (!text) return;

  setLoading(true);
  try {
    const response = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await response.json();

    if (!response.ok) {
      showError(data.error || 'Something went wrong. Try again.');
      return;
    }

    const { className, text: stampText } = stampFor(data.overallAiScore);
    stampEl.className = `stamp ${className}`;
    stampEl.textContent = stampText;
    scoreValueEl.textContent = `${Math.round(data.overallAiScore * 100)}%`;

    renderAnnotated(data.sentences);
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError('Could not reach the server. Is it running?');
  } finally {
    setLoading(false);
  }
});
