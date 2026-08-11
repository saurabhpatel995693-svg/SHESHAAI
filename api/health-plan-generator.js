import { MODELS } from './models.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
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
    const { 
      age, goal, activityLevel, dietaryRestrictions, sleepIssues, 
      image, mimeType, sectionToRegenerate, geminiKey 
    } = req.body || {};

    let base64Data = null;
    let imageMime = mimeType || 'image/jpeg';
    if (image && typeof image === 'string') {
      if (image.startsWith('data:')) {
        const parts = image.split(',');
        const meta = parts[0];
        base64Data = parts[1];
        const mimeMatch = meta.match(/data:(.*?);base64/);
        if (mimeMatch) imageMime = mimeMatch[1];
      } else {
        base64Data = image;
      }
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

    const promptText = `You are a wellness, fitness, and lifestyle coach. Generate a personalized 3-part plan (Workout, Diet, Sleep) based on user profile.

User Profile:
- Age: ${age || 'Not specified'}
- Goal: ${goal || 'General Fitness & Well-being'}
- Activity Level: ${activityLevel || 'Moderately Active'}
- Dietary Restrictions: ${dietaryRestrictions || 'None'}
- Sleep Concerns: ${sleepIssues || 'None'}
${sectionToRegenerate ? `- Focus requested: Regenerate section '${sectionToRegenerate}' with fresh ideas.` : ''}

STRICT SAFETY & QUALITY RULES:
1. PHOTO ROLE (if present): If a photo is attached, use it ONLY for a broad qualitative impression of build/athletic status to calibrate exercise difficulty level and encouraging tone. NEVER estimate numeric body fat %, measurements, or make judgment calls on weight/shape.
2. NO DIAGNOSES: Never give medical diagnoses, disease names, sleep disorder labels, or prescription advice.
3. NO EXTREME RESTRICTIONS: Do not prescribe extreme low-calorie diets (<1200 kcal) or extreme fasting protocols. Keep diet guidance balanced, whole-food centered, and positive.
4. Return ONLY valid JSON in the exact structure below:

{
  "qualitative_impression": "encouraging general note on fitness readiness",
  "workout_plan": {
    "title": "Weekly Fitness Split",
    "difficulty": "Beginner | Intermediate | Advanced",
    "days": [
      {
        "day": "Day 1: Upper Body & Core",
        "exercises": [
          { "name": "Push-ups", "sets_reps": "3 sets of 10 reps", "notes": "Keep core tight" }
        ]
      }
    ],
    "tips": ["Progressive overload tip", "Rest day advice"]
  },
  "diet_plan": {
    "title": "Balanced Nutritional Framework",
    "guidance": "Sustainable whole-food meal structure",
    "restrictions_respected": ["Stated restrictions"],
    "sample_day": {
      "breakfast": "Nutrient-dense morning meal description",
      "lunch": "Balanced afternoon meal description",
      "dinner": "Evening meal description",
      "snacks": "Healthy snack options"
    },
    "whole_food_recommendations": ["Complex Carbs", "Lean Proteins", "Healthy Fats"]
  },
  "sleep_plan": {
    "title": "Sleep Hygiene & Recovery Protocol",
    "schedule": "Target 7-8 hours per night",
    "wind_down_routine": ["30-min screen-free wind-down", "Warm shower or chamomile tea"],
    "screen_time_cutoff": "Cut blue light 60 mins before target sleep time",
    "environment_tips": ["Dark, cool (18-20°C) bedroom", "Consistent wake-up time"]
  }
}
No text outside this JSON.`;

    let rawOutput = null;
    let lastError = null;

    const targetModels = [MODELS.GEMINI_PRIMARY, MODELS.GEMINI_FALLBACK];

    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[i];
      for (const modelName of targetModels) {
        try {
          console.log(`[PLAN GENERATOR] Requesting ${modelName} (Key index ${i}, Vision: ${!!base64Data})...`);
          
          const parts = [{ text: promptText }];
          if (base64Data) {
            parts.push({ inlineData: { mimeType: imageMime, data: base64Data } });
          }

          const response = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                  temperature: 0.3,
                  maxOutputTokens: 3000,
                  responseMimeType: "application/json"
                }
              })
            },
            20000
          );

          if (response.ok) {
            const resData = await response.json();
            rawOutput = resData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (rawOutput) break;
          } else {
            const errTxt = await response.text().catch(() => '');
            lastError = `Gemini (${modelName}, Key ${i}) failed (${response.status}): ${errTxt.substring(0, 100)}`;
            console.warn(`[PLAN GENERATOR] ${lastError}`);
          }
        } catch (err) {
          lastError = `Gemini (${modelName}, Key ${i}) error: ${err.message}`;
          console.warn(`[PLAN GENERATOR] ${lastError}`);
        }
      }
      if (rawOutput) break;
    }

    if (!rawOutput) {
      return res.status(502).json({ error: 'All Gemini API keys failed to generate plan.', details: lastError });
    }

    let parsedData = null;
    try {
      const cleanJson = rawOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleanJson);
    } catch (e) {
      console.error('[PLAN GENERATOR] JSON parse failed, raw string:', rawOutput);
      return res.status(500).json({ error: 'Failed to parse Gemini output as JSON', raw: rawOutput });
    }

    return res.status(200).json(parsedData);

  } catch (err) {
    console.error('[PLAN GENERATOR] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
