import { MODELS } from './models.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

async function fetchWithTimeout(url, options, timeoutMs = 12000) {
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { image, mimeType, exerciseName, geminiKey } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: 'Missing image data (base64 required)' });
    }

    const exName = exerciseName || 'Exercise';

    let base64Data = image;
    let imageMime = mimeType || 'image/jpeg';
    if (image.startsWith('data:')) {
      const parts = image.split(',');
      const meta = parts[0];
      base64Data = parts[1];
      const mimeMatch = meta.match(/data:(.*?);base64/);
      if (mimeMatch) imageMime = mimeMatch[1];
    }

    // GEMINI KEY POOL
    const clientGeminiKey = req.headers['x-gemini-key'] || geminiKey || '';
    const GEMINI_KEYS = [
      clientGeminiKey,
      process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
      process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
    ].filter(Boolean);

    if (GEMINI_KEYS.length === 0) {
      return res.status(500).json({ error: 'No Gemini API key available on server or request headers.' });
    }

    const systemPrompt = `You are a fitness form coach. The user is performing a ${exName}. Analyze their visible posture/alignment and return JSON strictly:
{
  "overall": "good|needs_adjustment|unclear",
  "observations": ["short, specific, encouraging notes"],
  "corrections": ["specific actionable fixes, if any"],
  "safety_note": "only if a clear injury-risk pattern is visible (e.g. knees caving, rounded back under load) — omit otherwise"
}
Maintain an encouraging and helpful tone. No text outside JSON.`;

    let rawOutput = null;
    let lastError = null;

    const targetModels = [MODELS.GEMINI_PRIMARY, MODELS.GEMINI_FALLBACK];

    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[i];
      for (const modelName of targetModels) {
        try {
          console.log(`[FORM CHECK] Requesting ${modelName} (Key index ${i})...`);
          const response = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: systemPrompt },
                    { inlineData: { mimeType: imageMime, data: base64Data } }
                  ]
                }],
                generationConfig: {
                  temperature: 0.2,
                  maxOutputTokens: 2048,
                  responseMimeType: "application/json"
                }
              })
            },
            15000
          );

          if (response.ok) {
            const resData = await response.json();
            rawOutput = resData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (rawOutput) break;
          } else {
            const errTxt = await response.text().catch(() => '');
            lastError = `Gemini (${modelName}, Key ${i}) failed (${response.status}): ${errTxt.substring(0, 100)}`;
            console.warn(`[FORM CHECK] ${lastError}`);
          }
        } catch (err) {
          lastError = `Gemini (${modelName}, Key ${i}) error: ${err.message}`;
          console.warn(`[FORM CHECK] ${lastError}`);
        }
      }
      if (rawOutput) break;
    }

    if (!rawOutput) {
      return res.status(502).json({ error: 'All Gemini API keys failed to process image.', details: lastError });
    }

    let parsedData = null;
    try {
      const cleanJson = rawOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleanJson);
    } catch (e) {
      console.error('[FORM CHECK] JSON parse failed, raw string:', rawOutput);
      return res.status(500).json({ error: 'Failed to parse Gemini output as JSON', raw: rawOutput });
    }

    parsedData.exerciseName = exName;
    return res.status(200).json(parsedData);

  } catch (err) {
    console.error('[FORM CHECK] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
