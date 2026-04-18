/**
 * Carroll Street Café — Telegram POS Bot
 * Supports: text commands, voice notes (transcribed via Whisper API)
 * Deploy to Railway (free tier) — set env vars below
 *
 * ENV VARS REQUIRED:
 *   BOT_TOKEN         — from @BotFather
 *   SUPABASE_URL      — your Supabase project URL
 *   SUPABASE_KEY      — your Supabase anon key
 *   ALLOWED_CHAT_IDS  — comma-separated chat IDs allowed to use bot
 *   OPENAI_API_KEY    — for voice transcription (free tier: 60min/month)
 *   PORT              — Railway sets this automatically
 */

const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim());

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── MENU (must match frontend) ──────────────────────────────
const MENU = [
  {name:'Coffee',aliases:['coffee','regular coffee','reg coffee'],price:2.75,cat:'Hot Drinks'},
  {name:'Americano',aliases:['americano'],price:3.25,cat:'Hot Drinks'},
  {name:'Latte',aliases:['latte','latte small'],price:4.50,cat:'Hot Drinks'},
  {name:'Latte (Large)',aliases:['large latte','latte large','big latte'],price:5.50,cat:'Hot Drinks'},
  {name:'Cappuccino',aliases:['cappuccino','cap'],price:4.50,cat:'Hot Drinks'},
  {name:'Matcha Latte',aliases:['matcha','matcha latte'],price:5.25,cat:'Hot Drinks'},
  {name:'Hot Chocolate',aliases:['hot chocolate','hot choc','choc'],price:3.75,cat:'Hot Drinks'},
  {name:'Iced Coffee',aliases:['iced coffee','ice coffee'],price:3.50,cat:'Iced Drinks'},
  {name:'Iced Latte',aliases:['iced latte','ice latte'],price:4.75,cat:'Iced Drinks'},
  {name:'Iced Matcha',aliases:['iced matcha','ice matcha'],price:5.50,cat:'Iced Drinks'},
  {name:'Ginger Tea',aliases:['ginger tea','ginger'],price:3.25,cat:'Herbal Teas'},
  {name:'Chamomile Tea',aliases:['chamomile','chamomile tea'],price:3.25,cat:'Herbal Teas'},
  {name:'Peppermint Tea',aliases:['peppermint','peppermint tea','mint tea'],price:3.25,cat:'Herbal Teas'},
  {name:'Hibiscus Tea',aliases:['hibiscus','hibiscus tea'],price:3.25,cat:'Herbal Teas'},
  {name:'Apple Carrot Beet Juice',aliases:['acb juice','apple carrot beet','beet juice'],price:9.00,cat:'Juices'},
  {name:'Apple Parsley Lemon Juice',aliases:['apl juice','apple parsley','green juice'],price:9.00,cat:'Juices'},
  {name:'Apple Banana Blueberry Smoothie',aliases:['abb smoothie','banana smoothie','blueberry smoothie'],price:7.50,cat:'Smoothies'},
  {name:'Pineapple Mango Smoothie',aliases:['pineapple mango','mango smoothie','pineapple smoothie'],price:7.50,cat:'Smoothies'},
  {name:'Chocolate Banana Smoothie',aliases:['choc banana','chocolate banana','choc smoothie'],price:7.50,cat:'Smoothies'},
  {name:'Canned Soda',aliases:['soda','canned soda','can'],price:2.50,cat:'Drinks'},
  {name:'Avocado Toast',aliases:['avocado toast','avo toast','av toast'],price:7.50,cat:'Food'},
  {name:'Parfait',aliases:['parfait','chia parfait'],price:6.50,cat:'Food'},
  {name:'Blueberry Muffin',aliases:['blueberry muffin','bb muffin'],price:3.00,cat:'Food'},
  {name:'Corn Muffin',aliases:['corn muffin'],price:3.00,cat:'Food'},
  {name:'Plain Bagel',aliases:['plain bagel','bagel'],price:1.50,cat:'Food'},
  {name:'Butter Bagel w/ Cream Cheese',aliases:['butter bagel','cream cheese bagel','bagel cream cheese'],price:2.00,cat:'Food'},
  {name:'Vegan Tuna Wrap',aliases:['vegan tuna','tuna wrap','chickpea wrap'],price:9.50,cat:'Food'},
  {name:'Veggie Wrap',aliases:['veggie wrap','vegetable wrap','veg wrap'],price:8.50,cat:'Food'},
  {name:'Falafel Wrap',aliases:['falafel wrap','falafel'],price:8.50,cat:'Food'},
  {name:'Grilled Chicken Sandwich',aliases:['chicken sandwich','grilled chicken','chicken'],price:10.50,cat:'Food'},
  {name:'Burrito',aliases:['burrito'],price:10.50,cat:'Food'},
  {name:'Rice Bowl',aliases:['rice bowl','bowl'],price:10.00,cat:'Food'},
  {name:'Salad Bowl',aliases:['salad bowl','salad'],price:10.00,cat:'Food'},
];

// Sessions per chat (pending order building)
const sessions = {};

// ── TELEGRAM HELPERS ──────────────────────────────────────────
async function tgSend(chatId, text, opts={}) {
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: chatId, text, parse_mode:'HTML', ...opts})
  });
}

async function tgFile(fileId) {
  const r = await fetch(`${TG}/getFile?file_id=${fileId}`);
  const d = await r.json();
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`;
}

// ── VOICE TRANSCRIPTION ──────────────────────────────────────
async function transcribeVoice(fileId) {
  try {
    const url = await tgFile(fileId);
    const audioResp = await fetch(url);
    const buffer = await audioResp.buffer();

    const form = new FormData();
    form.append('file', buffer, {filename:'voice.ogg', contentType:'audio/ogg'});
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');
    form.append('prompt', 'Carroll Street Café order: coffee latte matcha wrap burrito bowl smoothie juice');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {'Authorization': `Bearer ${GROQ_KEY}`, ...form.getHeaders()},
      body: form
    });
    const data = await resp.json();
    return data.text || '';
  } catch(e) {
    console.error('Transcription error:', e);
    return '';
  }
}

// ── ORDER PARSING ──────────────────────────────────────────
function parseOrder(text) {
  const lower = text.toLowerCase();
  const found = [];

  // Try to find quantity + item patterns
  // e.g. "2 lattes", "one coffee", "3x matcha"
  const numberWords = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};

  MENU.forEach(item => {
    item.aliases.forEach(alias => {
      const patterns = [
        new RegExp(`(\\d+)\\s*[x×]?\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        new RegExp(`(one|two|three|four|five|six|seven|eight|nine|ten)\\s+${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
        new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[x×]\\s*(\\d+)`, 'i'),
        new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      ];

      for(let p=0; p<patterns.length; p++) {
        const m = lower.match(patterns[p]);
        if(m) {
          let qty = 1;
          if(p === 0 && m[1]) qty = parseInt(m[1]);
          else if(p === 1 && m[1]) qty = numberWords[m[1].toLowerCase()]||1;
          else if(p === 2 && m[1]) qty = parseInt(m[1]);

          // Check not already added this item
          const ex = found.find(f=>f.name===item.name);
          if(ex) { ex.qty += qty; }
          else { found.push({name:item.name, price:item.price, qty, cat:item.cat}); }
          break;
        }
      }
    });
  });

  return found;
}

function orderSummary(items) {
  if(!items.length) return 'No items recognised.';
  const total = items.reduce((s,i)=>s+i.price*i.qty, 0);
  const lines = items.map(i=>`  • ${i.qty}× ${i.name} — $${(i.price*i.qty).toFixed(2)}`).join('\n');
  return `${lines}\n\n<b>Total: $${total.toFixed(2)}</b>`;
}

// ── SAVE SALE ──────────────────────────────────────────────
async function saveSale(chatId, staffName, items, note='') {
  const total = items.reduce((s,i)=>s+i.price*i.qty, 0);
  const {error} = await sb.from('sales').insert({
    staff: staffName,
    items: items,
    total,
    note,
    source: 'telegram'
  });
  if(error) throw error;
  return total;
}

// ── REPORT ──────────────────────────────────────────────────
async function getReport(period='today') {
  let from;
  const now = new Date();
  if(period==='today') {
    from = now.toISOString().slice(0,10)+'T00:00:00';
  } else if(period==='week') {
    const d = new Date(now); d.setDate(d.getDate()-7);
    from = d.toISOString();
  } else {
    from = now.toISOString().slice(0,7)+'-01T00:00:00';
  }

  const {data,error} = await sb.from('sales').select('*').gte('created_at',from).order('created_at',{ascending:false});
  if(error||!data||!data.length) return `No sales found for ${period}.`;

  const revenue = data.reduce((s,x)=>s+Number(x.total),0);
  const items = data.reduce((s,x)=>s+(x.items||[]).reduce((a,i)=>a+i.qty,0),0);

  const imap={};
  data.forEach(sale=>(sale.items||[]).forEach(i=>{
    if(!imap[i.name]) imap[i.name]={qty:0,rev:0};
    imap[i.name].qty+=i.qty; imap[i.name].rev+=i.price*i.qty;
  }));
  const top = Object.entries(imap).sort((a,b)=>b[1].rev-a[1].rev).slice(0,5);

  const smap={};
  data.forEach(x=>{ if(!smap[x.staff]) smap[x.staff]={t:0,r:0}; smap[x.staff].t++; smap[x.staff].r+=Number(x.total); });

  let msg = `<b>📊 ${period.charAt(0).toUpperCase()+period.slice(1)}'s Report — Carroll Street Café</b>\n\n`;
  msg += `💰 Revenue: <b>$${revenue.toFixed(2)}</b>\n`;
  msg += `🧾 Transactions: <b>${data.length}</b>\n`;
  msg += `🛍 Items sold: <b>${items}</b>\n`;
  msg += `📈 Avg sale: <b>$${(revenue/data.length).toFixed(2)}</b>\n\n`;
  msg += `<b>🏆 Top items:</b>\n`;
  msg += top.map(([n,v])=>`  • ${v.qty}× ${n} — $${v.rev.toFixed(2)}`).join('\n');
  msg += `\n\n<b>👩‍💼 By staff:</b>\n`;
  msg += Object.entries(smap).map(([n,v])=>`  • ${n}: ${v.t} sales · $${v.r.toFixed(2)}`).join('\n');
  return msg;
}

// ── MESSAGE HANDLER ──────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id || chatId);
  const userName = msg.from?.first_name || 'Staff';
  const text = msg.text || '';
  const lower = text.toLowerCase().trim();

  // Log chat ID to help with setup
  console.log(`MSG from chatId: ${chatId} | userId: ${userId} | name: ${userName}`);

  // Access check
  const validIds = ALLOWED_IDS.filter(id => id.length > 0);
  if(validIds.length && !validIds.includes(chatId) && !validIds.includes(userId)) {
    await tgSend(chatId, '⛔ Sorry, you are not authorised to use this bot.');
    return;
  }

  // Init session
  if(!sessions[chatId]) sessions[chatId] = {staff: userName, pendingItems: null};
  const sess = sessions[chatId];

  // ── VOICE NOTE ──
  if(msg.voice || msg.audio) {
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    await tgSend(chatId, '🎙 Transcribing your voice note…');
    const transcript = await transcribeVoice(fileId);
    if(!transcript) {
      await tgSend(chatId, '❌ Could not transcribe audio. Please try again or type your order.');
      return;
    }
    await tgSend(chatId, `📝 I heard: "<i>${transcript}</i>"\n\nParsing order…`);
    const items = parseOrder(transcript);
    if(!items.length) {
      await tgSend(chatId, `❌ Couldn't match any menu items from: "${transcript}"\n\nTry typing it instead, e.g.:\n<code>sell 2 lattes, 1 burrito</code>`);
      return;
    }
    sess.pendingItems = items;
    await tgSend(chatId, `🛒 <b>Order from voice:</b>\n${orderSummary(items)}\n\nReply <b>yes</b> to confirm or <b>edit</b> to change.`);
    return;
  }

  // ── COMMANDS ──

  // /start or help
  if(lower === '/start' || lower === 'help' || lower === '/help') {
    await tgSend(chatId, `☕ <b>Carroll Street Café POS Bot</b>\n\nCommands:\n• <code>sell [items]</code> — log a sale\n• <code>yes</code> — confirm pending order\n• <code>cancel</code> — cancel pending order\n• <code>report</code> — today's report\n• <code>report week</code> — this week\n• <code>report month</code> — this month\n• <code>menu</code> — see menu\n• <code>staff [name]</code> — set your name\n\n🎙 You can also send a <b>voice note</b> saying the order!\n\nExample: <code>sell 2 lattes, 1 avocado toast, 3 canned sodas</code>`);
    return;
  }

  // menu
  if(lower === 'menu' || lower === '/menu') {
    const cats = {};
    MENU.forEach(i=>{ if(!cats[i.cat]) cats[i.cat]=[]; cats[i.cat].push(i); });
    let m = '📋 <b>Carroll Street Café Menu</b>\n\n';
    Object.entries(cats).forEach(([cat,items])=>{
      m += `<b>${cat}</b>\n`;
      m += items.map(i=>`  ${i.name} — $${i.price.toFixed(2)}`).join('\n');
      m += '\n\n';
    });
    await tgSend(chatId, m);
    return;
  }

  // set staff name
  if(lower.startsWith('staff ') || lower.startsWith('/staff ')) {
    const name = text.replace(/^(\/?)staff\s+/i,'').trim();
    if(name) { sess.staff = name; await tgSend(chatId, `✅ Staff name set to: <b>${name}</b>`); }
    return;
  }

  // report
  if(lower.startsWith('report') || lower === '/report') {
    const parts = lower.split(' ');
    const period = parts[1] || 'today';
    const report = await getReport(period);
    await tgSend(chatId, report);
    return;
  }

  // confirm pending order
  if(lower === 'yes' || lower === 'confirm' || lower === 'ok') {
    if(!sess.pendingItems || !sess.pendingItems.length) {
      await tgSend(chatId, 'No pending order to confirm. Use <code>sell [items]</code> first.');
      return;
    }
    try {
      const total = await saveSale(chatId, sess.staff, sess.pendingItems);
      await tgSend(chatId, `✅ <b>Sale saved!</b>\n${orderSummary(sess.pendingItems)}\n\nSold by: ${sess.staff}`);
      sess.pendingItems = null;
    } catch(e) {
      await tgSend(chatId, '❌ Error saving sale: '+e.message);
    }
    return;
  }

  // cancel
  if(lower === 'cancel' || lower === '/cancel') {
    sess.pendingItems = null;
    await tgSend(chatId, '❌ Order cancelled.');
    return;
  }

  // sell command
  if(lower.startsWith('sell ') || lower.startsWith('/sell ')) {
    const orderText = text.replace(/^(\/?)sell\s+/i,'').trim();
    const items = parseOrder(orderText);
    if(!items.length) {
      await tgSend(chatId, `❌ Couldn't match any items from: "${orderText}"\n\nCheck the menu with <code>menu</code> command.`);
      return;
    }
    sess.pendingItems = items;
    await tgSend(chatId, `🛒 <b>Confirm order for ${sess.staff}?</b>\n\n${orderSummary(items)}\n\nReply <b>yes</b> to save or <b>cancel</b> to discard.`);
    return;
  }

  // Try to parse as order even without "sell" prefix
  if(lower.length > 3 && !lower.startsWith('/')) {
    const items = parseOrder(text);
    if(items.length) {
      sess.pendingItems = items;
      await tgSend(chatId, `🛒 Did you mean to sell these?\n\n${orderSummary(items)}\n\nReply <b>yes</b> to confirm or type <code>cancel</code>.`);
      return;
    }
  }

  await tgSend(chatId, `Type <b>help</b> to see all commands, or send a voice note with your order! 🎙`);
}

// ── WEBHOOK ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const upd = req.body;
    if(upd.message) await handleMessage(upd.message);
  } catch(e) {
    console.error('Webhook error:', e);
  }
});

app.get('/', (req,res) => res.send('Carroll Street Café Bot is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
