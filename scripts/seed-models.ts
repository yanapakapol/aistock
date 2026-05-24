/**
 * Refresh the hardcoded model fallback list at apps/web/lib/llm/models.json.
 *
 * This is intentionally a thin stub. When run, it prints a checklist of the
 * official pricing/docs URLs to manually verify, then writes nothing.
 *
 * Why no auto-scrape: every provider's pricing page has a different shape and
 * scraping breaks silently. A human eyeball + JSON edit is the most reliable
 * way to keep the fallback fresh.
 */

const SOURCES: Array<{ provider: string; pricing: string; models: string }> = [
  { provider: 'openai', pricing: 'https://openai.com/api/pricing/', models: 'https://platform.openai.com/docs/models' },
  { provider: 'anthropic', pricing: 'https://platform.claude.com/docs/en/about-claude/pricing', models: 'https://platform.claude.com/docs/en/about-claude/models' },
  { provider: 'google', pricing: 'https://ai.google.dev/gemini-api/docs/pricing', models: 'https://ai.google.dev/gemini-api/docs/models' },
  { provider: 'mistral', pricing: 'https://mistral.ai/pricing', models: 'https://docs.mistral.ai/getting-started/models/models_overview/' },
  { provider: 'moonshot', pricing: 'https://platform.kimi.ai/docs/pricing/chat', models: 'https://platform.moonshot.ai/' },
  { provider: 'deepseek', pricing: 'https://api-docs.deepseek.com/quick_start/pricing', models: 'https://api-docs.deepseek.com/api/list-models' },
];

console.log('Open each URL, then edit apps/web/lib/llm/models.json:');
console.log('');
for (const s of SOURCES) {
  console.log(`  ${s.provider}`);
  console.log(`    pricing: ${s.pricing}`);
  console.log(`    models:  ${s.models}`);
}
console.log('');
console.log('Update each provider block with the current flagship + mid + cheap tier,');
console.log('plus pricing per 1M input/output tokens and the context window.');
