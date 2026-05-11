const fs = require('fs');
const path = require('path');

// 读取 data.json
const dataPath = process.argv[2] || 'data.json';
const outDir = process.argv[3] || 'exported_sessions';

console.log('读取数据文件...');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// 解析 assistants 和 topics 元数据
const cherry = JSON.parse(data.localStorage['persist:cherry-studio']);
const assistants = JSON.parse(cherry.assistants);

const topicMap = {};
[assistants.defaultAssistant, ...assistants.assistants].forEach(a => {
  (a.topics || []).forEach(t => {
    topicMap[t.id] = {
      name: t.name,
      assistantName: a.name,
      assistantId: a.id,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    };
  });
});

// message_blocks 映射
const blockMap = new Map();
(data.indexedDB.message_blocks || []).forEach(b => {
  if (!blockMap.has(b.messageId)) {
    blockMap.set(b.messageId, []);
  }
  blockMap.get(b.messageId).push(b);
});

// 安全文件名
function safeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

// 创建输出目录
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const topics = data.indexedDB.topics || [];
let exported = 0;
let skipped = 0;

console.log(`共 ${topics.length} 个会话，开始导出...`);

topics.forEach((topic, idx) => {
  const meta = topicMap[topic.id];
  const topicName = meta?.name || `未命名话题-${topic.id.slice(0, 8)}`;
  const assistantName = meta?.assistantName || '未知助手';

  // 如果没有任何消息，跳过
  if (!topic.messages || topic.messages.length === 0) {
    skipped++;
    return;
  }

  let md = `# ${topicName}\n\n`;
  md += `- **助手**: ${assistantName}\n`;
  if (meta?.createdAt) md += `- **创建时间**: ${meta.createdAt}\n`;
  if (meta?.updatedAt) md += `- **更新时间**: ${meta.updatedAt}\n`;
  md += `- **话题ID**: ${topic.id}\n\n`;
  md += `---\n\n`;

  topic.messages.forEach((msg, i) => {
    const roleLabel = msg.role === 'user' ? '👤 User' : `🤖 Assistant (${msg.model?.name || ''})`;
    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleString('zh-CN') : '';

    md += `## ${roleLabel}\n\n`;
    if (time) md += `*${time}*\n\n`;

    const blocks = blockMap.get(msg.id) || [];
    // 按 createdAt 排序 blocks
    blocks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    blocks.forEach(block => {
      if (block.type === 'main_text' && block.content) {
        md += block.content + '\n\n';
      } else if (block.type === 'thinking' && block.content) {
        md += `<details>\n<summary>Thinking (${block.thinking_millsec ? (block.thinking_millsec / 1000).toFixed(1) + 's' : ''})</summary>\n\n`;
        md += block.content + '\n\n';
        md += `</details>\n\n`;
      } else if (block.type === 'citation') {
        md += `*[引用]*\n\n`;
      } else if (block.type === 'image' && block.content) {
        md += `![image](${block.content})\n\n`;
      } else if (block.content) {
        md += block.content + '\n\n';
      }
    });

    md += `---\n\n`;
  });

  // 生成唯一文件名
  let baseName = `${safeFileName(assistantName)}_${safeFileName(topicName)}`;
  if (!baseName || baseName === '_') {
    baseName = `topic_${topic.id.slice(0, 8)}`;
  }
  let fileName = `${baseName}.md`;
  let filePath = path.join(outDir, fileName);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    fileName = `${baseName}_${counter}.md`;
    filePath = path.join(outDir, fileName);
    counter++;
  }

  fs.writeFileSync(filePath, md, 'utf8');
  exported++;

  if ((idx + 1) % 50 === 0) {
    console.log(`  已处理 ${idx + 1} / ${topics.length}...`);
  }
});

console.log(`\n导出完成！`);
console.log(`- 成功导出: ${exported} 个会话`);
console.log(`- 跳过空会话: ${skipped} 个`);
console.log(`- 输出目录: ${path.resolve(outDir)}`);
