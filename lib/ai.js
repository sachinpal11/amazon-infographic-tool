// Claude (prompt writing and review) and Gemini (Nano Banana Pro image generation).
// Both are plain HTTPS calls, so no SDK packages are needed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/png';
}

// Resizes and re-encodes an image so it is small enough to send to the APIs.
// Uses sharp when it is installed and falls back to the original bytes.
export async function prepImage(buf, maxDim = 1568) {
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(buf)
      .rotate()
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { mime: 'image/jpeg', data: out.toString('base64') };
  } catch {
    return { mime: sniffMime(buf), data: buf.toString('base64') };
  }
}

export async function askClaude(text, images = [], maxTokens = 6000) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the server.');
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((i) => ({
            type: 'image',
            source: { type: 'base64', media_type: i.mime, data: i.data },
          })),
          { type: 'text', text },
        ],
      },
    ],
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
    const errText = (await res.text()).slice(0, 500);
    lastErr = new Error(`Claude API error ${res.status}: ${errText}`);
    if (![429, 500, 502, 503, 529].includes(res.status)) break;
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

export function parseJson(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('Claude did not return JSON: ' + s.slice(0, 200));
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new Error('Claude returned invalid JSON: ' + s.slice(0, 200));
  }
}

// Nano Banana Pro through the Google Gemini API.
export async function generateImageGemini(prompt, refs = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set. Add it to .env.local and restart the server.');
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data } }))],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: process.env.IMAGE_SIZE || '2K' },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const imgs = parts.filter((p) => (p.inlineData || p.inline_data) && !p.thought);
      const part = imgs[imgs.length - 1];
      if (!part) {
        const why =
          parts.map((p) => p.text).filter(Boolean).join(' ') ||
          data.promptFeedback?.blockReason ||
          data.candidates?.[0]?.finishReason ||
          'no image in the response';
        throw new Error('The image model returned no image: ' + String(why).slice(0, 300));
      }
      const d = part.inlineData || part.inline_data;
      return { buf: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' };
    }
    const errText = (await res.text()).slice(0, 500);
    lastErr = new Error(`Image API error ${res.status}: ${errText}`);
    if (![429, 500, 502, 503].includes(res.status)) break;
    await sleep(3000 * (attempt + 1));
  }
  throw lastErr;
}

// Indirection so the pipeline can be tested with a fake AI.
export const ai = { askClaude, generateImageGemini, prepImage };
