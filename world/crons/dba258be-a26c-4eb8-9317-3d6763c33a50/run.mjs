// 任务提醒脚本 — 从 Discord 帖子读取待办事项
const THREAD_ID = '1476988157747531867';
const DISCORD_API = 'https://discord.com/api/v10';

async function fetchFirstMessage() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('⚠️ DISCORD_BOT_TOKEN 未设置');
    return null;
  }
  
  // 获取多条消息，按时间排序找最早的（帖子内容）
  const res = await fetch(`${DISCORD_API}/channels/${THREAD_ID}/messages?limit=50`, {
    headers: { Authorization: `Bot ${token}` }
  });
  
  if (!res.ok) {
    console.log(`⚠️ 获取消息失败: ${res.status}`);
    return null;
  }
  
  const messages = await res.json();
  if (messages.length === 0) return null;
  
  // 按时间戳排序，取最早的（第一条消息 = 帖子内容）
  const sorted = messages.sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  let content = sorted[0].content || '';
  // 去掉代码块包裹
  content = content.replace(/^```(?:markdown)?\n?/i, '').replace(/\n?```$/,'').trim();
  return content;
}

async function main() {
  const description = await fetchFirstMessage();
  
  console.log('⏰ 任务提醒 <@&1476176224945700894>');
  console.log('');
  
  if (description) {
    // 提取未完成项 (- [ ] ...)
    const lines = description.split('\n');
    const todos = lines.filter(l => l.match(/^-\s*\[\s*\]/));
    
    if (todos.length > 0) {
      console.log('当前待办：');
      todos.forEach(t => console.log(t));
    } else {
      // 如果没有找到 checkbox 格式，显示全部内容
      console.log('帖子内容：');
      console.log(description.slice(0, 500));
    }
  } else {
    console.log('_(无法读取帖子内容)_');
  }
  
  console.log('');
  console.log('_下次提醒：10分钟后_');
}

main().catch(e => console.log('❌ 错误:', e.message));
