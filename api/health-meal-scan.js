import { MODELS } from './models.js';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

// Simple 24-hour in-memory cache for Open Food Facts barcode lookups
const barcodeCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

async function lookupOpenFoodFacts(barcode) {
  if (!barcode || typeof barcode !== 'string') return null;
  const cleanBarcode = barcode.trim().replace(/[^0-9]/g, '');
  if (!cleanBarcode) return null;

  // Check cache
  const cached = barcodeCache.get(cleanBarcode);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`[OPEN FOOD FACTS] Cache hit for barcode: ${cleanBarcode}`);
    return cached.data;
  }

  try {
    console.log(`[OPEN FOOD FACTS] Fetching barcode: ${cleanBarcode}`);
    const url = `https://world.openfoodfacts.org/api/v2/product/${cleanBarcode}.json`;
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'SHESHAAI-Health/1.0 (contact: support@shesha.ai)',
        'Accept': 'application/json'
      }
    }, 5000);

    if (!res.ok) {
      console.warn(`[OPEN FOOD FACTS] HTTP ${res.status} for barcode ${cleanBarcode}`);
      return null;
    }

    const data = await res.json();
    if (data && data.status === 1 && data.product) {
      const product = data.product;
      const nutriments = product.nutriments || {};
      
      const verifiedInfo = {
        name: product.product_name || product.product_name_en || product.brands || `Packaged Food (${cleanBarcode})`,
        nutriscore: product.nutriscore_grade ? String(product.nutriscore_grade).toUpperCase() : null,
        calories_100g: Math.round(nutriments['energy-kcal_100g'] || nutriments['energy-kcal_value'] || nutriments['energy-kcal'] || 0),
        protein_100g: Math.round((nutriments['proteins_100g'] || nutriments['proteins_value'] || 0) * 10) / 10,
        carbs_100g: Math.round((nutriments['carbohydrates_100g'] || nutriments['carbohydrates_value'] || 0) * 10) / 10,
        fat_100g: Math.round((nutriments['fat_100g'] || nutriments['fat_value'] || 0) * 10) / 10,
        fiber_100g: Math.round((nutriments['fiber_100g'] || nutriments['fiber_value'] || 0) * 10) / 10,
        source: 'verified',
        badge: 'Verified via Open Food Facts',
        barcode: cleanBarcode
      };

      barcodeCache.set(cleanBarcode, { data: verifiedInfo, timestamp: Date.now() });
      return verifiedInfo;
    }
  } catch (err) {
    console.warn(`[OPEN FOOD FACTS] Lookup failed for ${cleanBarcode}:`, err.message);
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { image, mimeType, geminiKey, testBarcode } = req.body || {};
    
    // Direct barcode lookup test mode
    if (!image && testBarcode) {
      const verified = await lookupOpenFoodFacts(testBarcode);
      return res.status(200).json({
        items: verified ? [{
          name: verified.name,
          estimated_grams: 100,
          calories: verified.calories_100g,
          protein_g: verified.protein_100g,
          carbs_g: verified.carbs_100g,
          fat_g: verified.fat_100g,
          fiber_g: verified.fiber_100g,
          source: 'verified',
          badge: verified.badge,
          nutriscore: verified.nutriscore
        }] : [],
        totals: verified ? {
          calories: verified.calories_100g,
          protein_g: verified.protein_100g,
          carbs_g: verified.carbs_100g,
          fat_g: verified.fat_100g,
          fiber_g: verified.fiber_100g
        } : { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
        barcode_visible: true,
        barcode_value: testBarcode,
        open_food_facts_matched: !!verified,
        confidence: 'high',
        notes: verified ? `Verified with Open Food Facts (Nutri-Score: ${verified.nutriscore || 'N/A'})` : 'Barcode not found in Open Food Facts database.'
      });
    }

    if (!image) {
      return res.status(400).json({ error: 'Missing image data (base64 required)' });
    }

    // Clean image data if prefixed
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

    const systemPrompt = `You are a nutrition analysis assistant. Analyze this meal photo and identify every distinct food item visible, estimate portion size in grams, and return STRICT JSON only:
{
  "items": [{ "name": "", "estimated_grams": 0, "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0 }],
  "totals": { "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "fiber_g": 0 },
  "barcode_visible": true/false,
  "barcode_value": "if visible, else null",
  "confidence": "high|medium|low",
  "notes": "caveats about accuracy"
}
No text outside this JSON.`;

    let rawOutput = null;
    let lastError = null;

    const targetModels = [MODELS.GEMINI_PRIMARY, MODELS.GEMINI_FALLBACK];

    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[i];
      for (const modelName of targetModels) {
        try {
          console.log(`[MEAL SCAN] Requesting ${modelName} (Key index ${i})...`);
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
            console.warn(`[MEAL SCAN] ${lastError}`);
          }
        } catch (err) {
          lastError = `Gemini (${modelName}, Key ${i}) error: ${err.message}`;
          console.warn(`[MEAL SCAN] ${lastError}`);
        }
      }
      if (rawOutput) break;
    }

    if (!rawOutput) {
      return res.status(502).json({ error: 'All Gemini API keys failed to process image.', details: lastError });
    }

    // Parse Gemini JSON output
    let parsedData = null;
    try {
      const cleanJson = rawOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleanJson);
    } catch (e) {
      console.error('[MEAL SCAN] JSON parse failed, raw string:', rawOutput);
      return res.status(500).json({ error: 'Failed to parse Gemini output as JSON', raw: rawOutput });
    }

    // Add source tags to items
    if (parsedData.items && Array.isArray(parsedData.items)) {
      parsedData.items = parsedData.items.map(item => ({
        ...item,
        source: 'ai_estimate',
        badge: 'AI estimate'
      }));
    }

    // Check Open Food Facts if barcode is visible
    let openFoodFactsMatched = false;
    if (parsedData.barcode_visible && parsedData.barcode_value) {
      console.log(`[MEAL SCAN] Barcode reported: ${parsedData.barcode_value}. Checking Open Food Facts...`);
      const verified = await lookupOpenFoodFacts(parsedData.barcode_value);
      if (verified) {
        openFoodFactsMatched = true;
        
        const estGrams = parsedData.items?.[0]?.estimated_grams || 100;
        const multiplier = estGrams / 100;

        const verifiedItem = {
          name: verified.name,
          estimated_grams: estGrams,
          calories: Math.round(verified.calories_100g * multiplier),
          protein_g: Math.round(verified.protein_100g * multiplier * 10) / 10,
          carbs_g: Math.round(verified.carbs_100g * multiplier * 10) / 10,
          fat_g: Math.round(verified.fat_100g * multiplier * 10) / 10,
          fiber_g: Math.round(verified.fiber_100g * multiplier * 10) / 10,
          source: 'verified',
          badge: verified.badge,
          nutriscore: verified.nutriscore
        };

        if (parsedData.items && parsedData.items.length > 0) {
          parsedData.items[0] = verifiedItem;
        } else {
          parsedData.items = [verifiedItem];
        }

        // Recalculate totals
        parsedData.totals = parsedData.items.reduce((acc, curr) => ({
          calories: acc.calories + (curr.calories || 0),
          protein_g: Math.round((acc.protein_g + (curr.protein_g || 0)) * 10) / 10,
          carbs_g: Math.round((acc.carbs_g + (curr.carbs_g || 0)) * 10) / 10,
          fat_g: Math.round((acc.fat_g + (curr.fat_g || 0)) * 10) / 10,
          fiber_g: Math.round((acc.fiber_g + (curr.fiber_g || 0)) * 10) / 10,
        }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 });

        parsedData.notes = (parsedData.notes ? parsedData.notes + ' ' : '') + `[Verified via Open Food Facts database]`;
      }
    }

    parsedData.open_food_facts_matched = openFoodFactsMatched;
    return res.status(200).json(parsedData);

  } catch (err) {
    console.error('[MEAL SCAN] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
