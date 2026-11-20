const fs = require('fs');
const path = require('path');

const action = process.env.ACTION || '';
const usersInput = process.env.USERS_INPUT || '';
const TG_TOKEN   = process.env.TG_TOKEN   || '8794354513:AAHKXWAM9K_xPE6i4z25LLyrinKx9t4v4ho';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '1548646919';

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Failed to send telegram notification:', e.message);
  }
}

async function main() {
  const accountsFile = path.join(__dirname, '..', 'accounts.txt');
  let current = [];
  if (fs.existsSync(accountsFile)) {
    current = fs.readFileSync(accountsFile, 'utf8')
      .split(/[\r\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  const inputList = usersInput.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);

  if (inputList.length === 0) {
    console.log('⚠️ No usernames provided to add or remove.');
    await sendTelegram('⚠️ *Permanent List Not Modified*: No usernames were entered in the input box.');
    return;
  }

  if (action.includes('Add')) {
    const added = [];
    for (const u of inputList) {
      if (!current.some(c => c.toLowerCase() === u.toLowerCase())) {
        current.push(u);
        added.push(u);
      }
    }
    fs.writeFileSync(accountsFile, current.join('\n') + '\n', 'utf8');
    console.log(`✅ Added: ${added.join(', ')}`);
    console.log(`📋 Total: ${current.join(', ')}`);

    const msg = added.length > 0
      ? `✅ *Permanent Accounts Updated*\n➕ *Added:* \`${added.join(', ')}\`\n\n📋 *Total Accounts (${current.length}):*\n\`${current.join(', ')}\``
      : `ℹ️ *No Changes Made*: \`${inputList.join(', ')}\` is already in your permanent list.\n\n📋 *Current Accounts (${current.length}):*\n\`${current.join(', ')}\``;
    await sendTelegram(msg);

  } else if (action.includes('Remove')) {
    const removed = [];
    current = current.filter(c => {
      const match = inputList.some(u => u.toLowerCase() === c.toLowerCase());
      if (match) removed.push(c);
      return !match;
    });
    fs.writeFileSync(accountsFile, current.join('\n') + '\n', 'utf8');
    console.log(`🗑️ Removed: ${removed.join(', ')}`);
    console.log(`📋 Total: ${current.join(', ')}`);

    const msg = removed.length > 0
      ? `🗑️ *Permanent Accounts Updated*\n➖ *Removed:* \`${removed.join(', ')}\`\n\n📋 *Remaining Accounts (${current.length}):*\n\`${current.join(', ')}\``
      : `ℹ️ *No Changes Made*: \`${inputList.join(', ')}\` was not found in your permanent list.\n\n📋 *Current Accounts (${current.length}):*\n\`${current.join(', ')}\``;
    await sendTelegram(msg);
  }
}

main();
