import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 直接从 search.mjs 导入统计数据
let statsModule;
try {
  statsModule = await import('./search.mjs');
} catch {
  // fallback
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // 尝试从 search.mjs 获取统计数据
  try {
    const searchModule = await import('./search.mjs');
    const stats = searchModule.getStats();
    res.json(stats);
  } catch {
    res.json({
      totalRequests: 'N/A（服务刚启动）',
      totalTokens: 0,
      recent: []
    });
  }
}