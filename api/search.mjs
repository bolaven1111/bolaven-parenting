import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE = 'https://api.deepseek.com';

// Token统计（内存级，重启会重置）
let tokenStats = [];
let requestCount = 0;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只支持POST请求' });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: '服务配置未完成，请联系管理员' });
  }

  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: '请输入问题' });
  }

  const startTime = Date.now();
  requestCount++;

  try {
    const index = JSON.parse(
      readFileSync(join(root, 'knowledge', 'index.json'), 'utf-8')
    );

    // 分类——找到最相关的章节
    const matched = await classifyQuestion(question.trim(), index);
    if (!matched) {
      return res.json({
        answer: '这个问题暂时超出了我的知识范围，换种方式问问看？',
        sources: [],
        tokens: {}
      });
    }

    // 在所有书目录中查找对应文件
    let chapterContent = null;
    let foundBook = null;
    for (const book of index.books) {
      const dirName = book.name;
      const filePath = join(root, 'knowledge', dirName, matched.file);
      if (existsSync(filePath)) {
        chapterContent = readFileSync(filePath, 'utf-8');
        foundBook = book;
        break;
      }
    }

    if (!chapterContent) {
      return res.status(500).json({ error: '知识库文件未找到' });
    }

    // 生成回答
    const answer = await generateAnswer(question.trim(), chapterContent, foundBook);

    // 记录用量
    const elapsed = Date.now() - startTime;
    tokenStats.push({
      time: new Date().toISOString(),
      question: question.trim().substring(0, 30),
      chapter: matched.file,
      book: foundBook?.name || 'unknown',
      tokens: answer.tokens,
      ms: elapsed
    });
    if (tokenStats.length > 100) tokenStats.shift();

    res.json({
      answer: answer.text,
      sources: answer.sources,
      tokens: answer.tokens
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: '服务暂时不可用，请稍后再试' });
  }
}

/* 调用DeepSeek API */
async function callDeepSeek(messages, model, temperature = 0.3) {
  const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek API (${resp.status}): ${errText}`);
  }

  return resp.json();
}

/* 第一步：分类——找出最相关的章节 */
async function classifyQuestion(question, index) {
  const allChapters = index.books.flatMap(b => b.chapters);

  const chapterList = allChapters.map((c, i) =>
    `${i + 1}. [${c.book_short}] ${c.title}`
  ).join('\n');

  const messages = [
    {
      role: 'system',
      content: `你是一个育儿知识分类助手。从以下章节列表中选出最相关的1个章节编号。
章节按「[书名] 标题」格式列出。只输出数字，不要多余内容。
例如：问题"宝宝发烧" → "27"（如果27是《美国儿科学会育儿百科》的发热章节）`
    },
    {
      role: 'user',
      content: `用户提问：${question}\n\n可选章节：\n${chapterList}\n\n最相关的章节编号是：`
    }
  ];

  const result = await callDeepSeek(messages, 'deepseek-v4-flash', 0.1);
  const text = result.choices[0].message.content;
  const numbers = text.match(/\d+/g);

  if (!numbers || numbers.length === 0) return null;

  const idx = parseInt(numbers[0], 10) - 1;
  if (idx < 0 || idx >= allChapters.length) return null;

  return {
    file: allChapters[idx].file,
    chapter: allChapters[idx]
  };
}

/* 第二步：基于章节内容生成回答 */
async function generateAnswer(question, chapterContent, book) {
  const maxLen = 8000;
  const content = chapterContent.length > maxLen
    ? chapterContent.substring(0, maxLen) + '\n\n[内容较长，已截取关键部分]'
    : chapterContent;

  const titleMatch = chapterContent.match(/^#\s+(.+)/m);
  const chapterTitle = titleMatch ? titleMatch[1] : '育儿知识';

  const bookName = book?.name || '育儿百科';

  const messages = [
    {
      role: 'system',
      content: `你是"布拉万的育儿大师"助手，一个专业温暖的育儿知识顾问。

你的回答风格：
- 严格基于提供的章节内容，不编造
- 语言通俗易懂，条理清晰
- 保持温暖、让人安心的语气

回答最后注明来源，格式：📖 来源：《${bookName}》- ${chapterTitle}
如果章节内容不足以完整回答问题，如实告知，并提供已有信息。`
    },
    {
      role: 'user',
      content: `用户问题：${question}\n\n相关资料：\n${content}\n\n请整合后回答：`
    }
  ];

  const result = await callDeepSeek(messages, 'deepseek-v4-pro', 0.5);
  const answerText = result.choices[0].message.content;

  return {
    text: answerText,
    sources: [`${bookName} - ${chapterTitle}`],
    tokens: result.usage
  };
}

/* Token用量统计 */
export function getStats() {
  const totalInput = tokenStats.reduce((s, r) => s + (r.tokens?.prompt_tokens || 0), 0);
  const totalOutput = tokenStats.reduce((s, r) => s + (r.tokens?.completion_tokens || 0), 0);
  return {
    totalRequests: requestCount,
    recordedRequests: tokenStats.length,
    totalTokens: totalInput + totalOutput,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    recent: tokenStats.slice(-10).reverse()
  };
}