import { MODELS } from './models.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key, x-groq-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { audio, mimeType, lang } = req.body || {};
  if (!audio) {
    return res.status(400).json({ error: 'Missing audio data' });
  }

  // ── LAYER 2: Groq Whisper API ──
  const clientGroqKey = req.headers['x-groq-key'] || '';
  const serverGroqKeys = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2].filter(Boolean);
  const groqKeysPool = [clientGroqKey, ...serverGroqKeys].filter(Boolean);

  console.log(`[TRANSCRIBE] Groq Keys Pool size: ${groqKeysPool.length}`);

  for (let i = 0; i < groqKeysPool.length; i++) {
    const key = groqKeysPool[i];
    try {
      console.log(`[TRANSCRIBE] Trying Groq Whisper (Key index ${i})...`);
      
      const buffer = Buffer.from(audio, 'base64');
      const blob = new Blob([buffer], { type: mimeType || 'audio/webm' });
      
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');
      formData.append('model', 'whisper-large-v3');
      if (lang) {
        const shortLang = lang.split('-')[0];
        formData.append('language', shortLang);
      }

      const groqRes = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`
        },
        body: formData
      }, 15000);

      if (groqRes.ok) {
        const data = await groqRes.json();
        if (data.text && data.text.trim().length > 0) {
          console.log(`[TRANSCRIBE] Groq Whisper OK: ${data.text.length} chars`);
          return res.status(200).json({
            transcript: data.text,
            layer: 'Groq Whisper (Layer 2)'
          });
        }
      } else {
        const errText = await groqRes.text().catch(() => '');
        console.warn(`[TRANSCRIBE] Groq Whisper failed with status ${groqRes.status}: ${errText.substring(0, 150)}`);
      }
    } catch (e) {
      console.warn(`[TRANSCRIBE] Groq Whisper attempt ${i} error:`, e.message);
    }
  }

  // ── LAYER 3: Gemini Audio Input (Final Fallback) ──
  const clientGeminiKey = req.headers['x-gemini-key'] || '';
  const serverGeminiKeys = [
    process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6
  ].filter(Boolean);
  const geminiKeysPool = [clientGeminiKey, ...serverGeminiKeys].filter(Boolean);

  console.log(`[TRANSCRIBE] Gemini Keys Pool size: ${geminiKeysPool.length}`);

  for (let i = 0; i < geminiKeysPool.length; i++) {
    const key = geminiKeysPool[i];
    try {
      console.log(`[TRANSCRIBE] Trying Gemini Audio (Key index ${i})...`);
      
      const payload = {
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: mimeType || 'audio/webm',
                  data: audio
                }
              },
              {
                text: "Please transcribe the following audio recording exactly as spoken. If there are multiple languages (like Hindi and English), transcribe the spoken words in their respective language. Return ONLY the transcript text, nothing else."
              }
            ]
          }
        ]
      };

      const geminiRes = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.GEMINI_PRIMARY}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 20000);

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim().length > 0) {
          console.log(`[TRANSCRIBE] Gemini Audio OK: ${text.length} chars`);
          return res.status(200).json({
            transcript: text,
            layer: 'Gemini Audio (Layer 3)'
          });
        }
      } else {
        const errText = await geminiRes.text().catch(() => '');
        console.warn(`[TRANSCRIBE] Gemini Audio failed with status ${geminiRes.status}: ${errText.substring(0, 150)}`);
      }
    } catch (e) {
      console.warn(`[TRANSCRIBE] Gemini Audio attempt ${i} error:`, e.message);
    }
  }

  // All layers failed
  console.error('[TRANSCRIBE-FAIL] All transcription fallback layers failed.');
  return res.status(500).json({
    error: 'Recording process nahi ho payi, please phir se try karein ya topic directly type karein.'
  });
}
