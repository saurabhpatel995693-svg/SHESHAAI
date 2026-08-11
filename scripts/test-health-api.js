import fs from 'fs';
import path from 'path';
import handlerMealScan from '../api/health-meal-scan.js';
import handlerFormCheck from '../api/health-form-check.js';
import handlerPlanGen from '../api/health-plan-generator.js';

// Load .env.production into process.env if available
try {
  const envPath = path.join(process.cwd(), '.env.production');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    });
  }
} catch(e) {
  console.warn('Could not load .env.production:', e.message);
}

function createMockReqRes(body, headers = {}) {
  return {
    req: {
      method: 'POST',
      body,
      headers
    },
    res: {
      statusCode: 200,
      headers: {},
      bodyData: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.bodyData = data; return this; },
      end() { return this; }
    }
  };
}

async function runTests() {
  console.log('=== TEST 1: Open Food Facts Barcode Cross-Check (Feature 1) ===');
  const testBarcode = '737628064502'; // Thai Kitchen Pad Thai Rice Noodles
  const mock1 = createMockReqRes({ testBarcode });
  await handlerMealScan(mock1.req, mock1.res);

  console.log('STATUS:', mock1.res.statusCode);
  console.log('RESPONSE:', JSON.stringify(mock1.res.bodyData, null, 2));

  console.log('\n=== TEST 2: Form Checker API (Feature 3) ===');
  const sample1pxBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const mock2 = createMockReqRes({ 
    image: sample1pxBase64, 
    exerciseName: 'Barbell Squat' 
  });
  await handlerFormCheck(mock2.req, mock2.res);

  console.log('STATUS:', mock2.res.statusCode);
  console.log('RESPONSE:', JSON.stringify(mock2.res.bodyData, null, 2));

  console.log('\n=== TEST 3: Plan Generator API (Feature 2) ===');
  const mock3 = createMockReqRes({
    age: 28,
    goal: 'Muscle Building & Strength',
    activityLevel: 'Moderately Active',
    dietaryRestrictions: 'High-Protein Whole Foods',
    sleepIssues: 'Trouble falling asleep'
  });
  await handlerPlanGen(mock3.req, mock3.res);

  console.log('STATUS:', mock3.res.statusCode);
  console.log('RESPONSE:', JSON.stringify(mock3.res.bodyData, null, 2));
}

runTests().catch(err => console.error('TEST ERROR:', err));
