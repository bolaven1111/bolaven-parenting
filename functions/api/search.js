// Cloudflare Pages Functions — 育儿大师搜索API
// 知识库已内嵌为静态资源，部署零依赖外部文件

const API_BASE = 'https://api.deepseek.com';

// 模块级缓存（冷启动时加载一次，后续复用）
let _bundle = null;
let _index = null;

async function getBundle(env, request) {
  if (_bundle) return _bundle;
  const url = new URL('/knowledge-bundle.json', request.url);
  const resp = await env.ASSETS.fetch(url);
  _bundle = await resp.json();
  return _bundle;
}

async function getIndex(env, request) {
  if (_index) return _index;
  const url = new URL('/knowledge-index.json', request.url);
  const resp = await env.ASSETS.fetch(url);
  _index = await resp.json();
  return _index;
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS + OPTIONS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '只支持POST请求' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: '服务配置未完成，请联系管理员' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { question } = body || {};
  if (!question || !question.trim()) {
    return new Response(JSON.stringify({ error: '请输入问题' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const startTime = Date.now();
  let requestCount = 0;

  try {
    const index = await getIndex(env, request);
    const bundle = await getBundle(env, request);

    // 第一步：分类——找出最相关的章节
    const matched = await classifyQuestion(question.trim(), index, apiKey);
    if (!matched) {
      return new Response(JSON.stringify({
        answer: '这个问题暂时超出了我的知识范围，换种方式问问看？',
        sources: [],
        tokens: {}
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 从 bundle 中查找对应文件内容
    let chapterContent = null;
    let foundBook = null;
    for (const book of index.books) {
      const b = bundle[book.name];
      if (b && b[matched.file]) {
        chapterContent = b[matched.file];
        foundBook = book;
        break;
      }
    }

    if (!chapterContent) {
      return new Response(JSON.stringify({ error: '知识库文件未找到' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 第二步：生成回答
    const answer = await generateAnswer(question.trim(), chapterContent, foundBook, apiKey);

    return new Response(JSON.stringify({
      answer: answer.text,
      sources: answer.sources,
      tokens: answer.tokens
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Search error:', err);
    return new Response(JSON.stringify({ error: '服务暂时不可用，请稍后再试' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* 调用DeepSeek API */
async function callDeepSeek(messages, model, apiKey, temperature = 0.3) {
  const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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
async function classifyQuestion(question, index, apiKey) {
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

  const result = await callDeepSeek(messages, 'deepseek-v4-flash', apiKey, 0.1);
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
async function generateAnswer(question, chapterContent, book, apiKey) {
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

  const result = await callDeepSeek(messages, 'deepseek-v4-pro', apiKey, 0.5);
  const answerText = result.choices[0].message.content;

  return {
    text: answerText,
    sources: [`${bookName} - ${chapterTitle}`],
    tokens: result.usage
  };
}