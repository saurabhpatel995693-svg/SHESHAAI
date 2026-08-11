/**
 * SHESHAAI Centralized AI Model Registry & Constants
 * Single source of truth for all AI model endpoints across SHESHAAI platform.
 */
export const MODELS = {
  // Google Gemini Models (Updated to active stable GA models)
  GEMINI_PRIMARY: 'gemini-3.6-flash',
  GEMINI_FALLBACK: 'gemini-flash-latest',
  
  // Groq Models
  GROQ_PRIMARY: 'llama-3.3-70b-versatile',
  GROQ_INSTANT: 'llama-3.1-8b-instant',
  
  // NVIDIA NIM Models
  NVIDIA_PRIMARY: 'nvidia/llama-3.1-nemotron-70b-instruct',
  
  // OpenRouter Models
  OPENROUTER_DEFAULT: 'deepseek/deepseek-r1:free',

  // HuggingFace Models
  HF_PRIMARY: 'Qwen/Qwen2.5-72B-Instruct',
  
  // Free Fallback Engine
  POLLINATIONS_DEFAULT: 'openai'
};
