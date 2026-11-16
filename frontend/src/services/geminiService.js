import { apiFetch } from './api/client.js'

// The Gemini key and model fallback live on the server.
export const askGemini = prompt => apiFetch('/api/ai/generate', { method: 'POST', body: JSON.stringify({ prompt }) })
export const generateAiForecast = data => apiFetch('/api/ai/forecast', { method: 'POST', body: JSON.stringify(data) })
export const generateDecisionSupport = data => apiFetch('/api/ai/dss', { method: 'POST', body: JSON.stringify(data) })
