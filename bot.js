/**
 * Carroll Street Café — Telegram POS Bot
 * Interactive button ordering + text command fallback
 *
 * ENV VARS:
 *   BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, ALLOWED_CHAT_IDS, GROQ_API_KEY, PORT
 */

const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const BOT_TOKEN   = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const ALLOWED_IDS = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim());

const sb  = createClient(SUPABASE_URL, SUPABASE_KEY);
const TG  = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── MENU ─────────────────────────────────────────────────────
const MENU = [
  {name:'Coffee',            price:2.75, cat:'☕ Hot Drinks'},
  {name:'Americano',         price:3.25, cat:'☕ Hot Drinks'},
  {name:'Latte (Small)',     price:4.50, cat:'☕ Hot Drinks'},
  {name:'Latte (Large)',     price:5.50, cat:'☕ Hot Drinks'},
  {name:'Cappuccino',        price:4.50, cat:'☕ Hot Drinks'},
  {name:'Matcha Latte',      price:5.25, cat:'☕ Hot Drinks'},
  {name:'Hot Chocolate',     price:3.75, cat:'☕ Hot Drinks'},
  {name:'Iced Coffee',       price:3.50, cat:'🧊 Iced Drinks'},
  {name:'Iced Latte',        price:4.75, cat:'🧊 Iced Drinks'},
  {name:'Iced Matcha',       price:5.50, cat:'🧊 Iced Drinks'},
  {name:'Ginger Tea',        price:3.25, cat:'🍵 Herbal Teas'},
  {name:'Chamomile Tea',     price:3.25, cat:'🍵 Herbal Teas'},
  {name:'Peppermint Tea',    price:3.25, cat:'🍵 Herbal Teas'},
  {name:'Hibiscus Tea',      price:3.25, cat:'🍵 Herbal Teas'},
  {name:'ACB Juice',         price:9.00, cat:'🥤 Juices'},
  {name:'APL Green Juice',   price:9.00, cat:'🥤 Juices'},
  {name:'Berry Smoothie',    price:7.50, cat:'🥤 Smoothies'},
  {name:'Pineapple Mango',   price:7.50, cat:'🥤 Smoothies'},
  {name:'Choc Banana',       price:7.50, cat:'🥤 Smoothies'},
  {name:'Canned Soda',       price:2.50, cat:'🥤 Drinks'},
  {name:'Avocado Toast',     price:7.50, cat:'🍽 Food'},
  {name:'Parfait',           price:6.50, cat:'🍽 Food'},
  {name:'Blueberry Muffin',  price:3.00, cat:'🍽 Food'},
  {name:'Corn Muffin',       price:3.00, cat:'🍽 Food'},
  {name:'Plain Bagel',       price:1.50, cat:'🍽 Food'},
  {name:'Bagel & Cream Cheese', price:2.00, cat:'🍽 Food'},
  {name:'Vegan Tuna Wrap',   price:9.50, cat:'🌯 Wraps & Bowls'},
  {name:'Veggie Wrap',       price:8.50, cat:'🌯 Wraps & Bowls'},
  {name:'Falafel Wrap',      price:8.50, cat:'🌯 Wraps & Bowls'},
  {name:'Chicken Sandwich',  price:10.50,cat:'🌯 Wraps & Bowls'},
  {name:'Burrito',           price:10.50,cat:'🌯 Wraps & Bowls'},
  {name:'Rice Bowl',         price:10.00,cat:'🌯 Wraps & Bowls'},
  {name:'Salad Bowl',        price:10.00,cat:'🌯 Wraps & Bowls'},
];

const CATS = [...new Set(MENU.map(i=>i.cat))];

// ── SESSIONS ──────────────────────────────────────────────────
const sessions = {};
function getSession(chatId, userName) {
  if(!sessions[chatId]) sessions[chatId] = {staff: userName, cart: [], pendingItems: null};
  return sessions[chatId];
}

// ── TELEGRAM HELPERS ──────────────────────────────────────────
async function tgSend(chatId, text, opts={}) {
  await fetch(`${TG}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id:chatId, text, parse_mode:'HTML', ...opts})
  });
}

async function tgSendKeyboard(chatId, text, keyboard) {
  const r = await fetch(`${TG}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id:chatId, text, parse_mode:'HTML', reply_markup:{inline_keyboard:keyboard}})
  });
  const d = await r.json();
  return d.result?.message_id;
}

async function tgEdit(chatId, msgId, text, keyboard=null) {
  const body = {chat_id:chatId, message_id:msgId, text, parse_mode:'HTML'};
  if(keyboard) body.reply_markup = {inline_keyboard:keyboard};
  await fetch(`${TG}/editMessageText`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
}

async function tgAnswer(cbId, text='') {
  await fetch(`${TG}/answerCallbackQuery`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({callback_query_id:cbId, text, show_alert:false})
  });
}

async function tgFile(fileId) {
  const r = await fetch(`${TG}/getFile?file_id=${fileId}`);
  const d = await r.json();
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`;
}

// ── VOICE TRANSCRIPTION (Groq Whisper — free) ─────────────────
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
      method:'POST', headers:{'Authorization':`Bearer ${GROQ_KEY}`, ...form.getHeaders()}, body:form
    });
    const data = await resp.json();
    return data.text || '';
  } catch(e) { console.error('Transcription error:', e); return ''; }
}

// ── KEYBOARD BUILDERS ─────────────────────────────────────────
function categoriesKeyboard() {
  const rows = [];
  for(let i=0; i<CATS.length; i+=2) {
    rows.push(CATS.slice(i,i+2).map(cat=>({text:cat, callback_data:'c:'+CATS.indexOf(cat)})));
  }
  rows.push([{text:'❌ Cancel', callback_data:'x'}]);
  return rows;
}

function itemsKeyboard(catIdx) {
  const cat = CATS[catIdx];
  const items = MENU.filter(i=>i.cat===cat);
  const rows = [];
  for(let i=0; i<items.length; i+=2) {
    rows.push(items.slice(i,i+2).map(item=>{
      const idx = MENU.indexOf(item);
      return {text:`${item.name}  $${item.price.toFixed(2)}`, callback_data:`i:${idx}`};
    }));
  }
  rows.push([
    {text:'⬅️ Categories', callback_data:'cats'},
    {text:'🛒 View Cart',   callback_data:'v'}
  ]);
  rows.push([{text:'❌ Cancel', callback_data:'x'}]);
  return rows;
}

function itemOptionsKeyboard(itemIdx) {
  const item = MENU[itemIdx];
  const half = (item.price / 2).toFixed(2);
  return [
    [{text:`✅ Full Price  $${item.price.toFixed(2)}`, callback_data:`a:${itemIdx}:${item.price}:full`}],
    [{text:`½ Half Price  $${half}`,                  callback_data:`a:${itemIdx}:${half}:half`}],
    [
      {text:'⬅️ Back',    callback_data:`c:${CATS.indexOf(item.cat)}`},
      {text:'🛒 Cart',    callback_data:'v'}
    ],
  ];
}

function cartKeyboard(cart) {
  const rows = [];
  cart.forEach((item, idx) => {
    rows.push([
      {text:`${item.qty}×  ${item.name}  $${(item.price*item.qty).toFixed(2)}`, callback_data:'noop'},
      {text:'−', callback_data:`d:${idx}`},
      {text:'+', callback_data:`p:${idx}`},
    ]);
  });
  rows.push([
    {text:'➕ Add More',    callback_data:'cats'},
    {text:'✅ Confirm Sale', callback_data:'confirm'},
  ]);
  rows.push([{text:'❌ Cancel Order', callback_data:'x'}]);
  return rows;
}

function cartText(cart, staffName) {
  if(!cart.length) return '🛒 Cart is empty.';
  const total = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const lines = cart.map(i=>`  • ${i.qty}×  ${i.name}${i.label?' ('+i.label+')':''} — $${(i.price*i.qty).toFixed(2)}`).join('\n');
  return `🛒 <b>Order — ${staffName}</b>\n\n${lines}\n\n<b>Total: $${total.toFixed(2)}</b>\n\nUse − / + to adjust quantities.`;
}

// ── CALLBACK HANDLER ──────────────────────────────────────────
async function handleCallback(cb) {
  const chatId  = String(cb.message.chat.id);
  const msgId   = cb.message.message_id;
  const data    = cb.data;
  const cbId    = cb.id;
  const userName = cb.from?.first_name || 'Staff';

  const validIds = ALLOWED_IDS.filter(id=>id.length>0);
  if(validIds.length && !validIds.includes(chatId)) {
    await tgAnswer(cbId, '⛔ Not authorised');
    return;
  }

  await tgAnswer(cbId);
  const sess = getSession(chatId, userName);

  if(data === 'noop') return;

  // Show categories
  if(data === 'cats') {
    await tgEdit(chatId, msgId, '☕ <b>Carroll Street Café</b>\n\nSelect a category:', categoriesKeyboard());
    return;
  }

  // Category selected → show items
  if(data.startsWith('c:')) {
    const catIdx = parseInt(data.slice(2));
    const cat = CATS[catIdx];
    await tgEdit(chatId, msgId, `<b>${cat}</b>\n\nTap an item to select it:`, itemsKeyboard(catIdx));
    return;
  }

  // Item selected → show price options
  if(data.startsWith('i:')) {
    const idx = parseInt(data.slice(2));
    const item = MENU[idx];
    await tgEdit(chatId, msgId,
      `<b>${item.name}</b>  ·  ${item.cat}\n\nFull price or half price?`,
      itemOptionsKeyboard(idx)
    );
    return;
  }

  // Add item to cart
  if(data.startsWith('a:')) {
    const parts = data.split(':');
    const idx   = parseInt(parts[1]);
    const price = parseFloat(parts[2]);
    const label = parts[3]; // 'full' or 'half'
    const item  = MENU[idx];
    const name  = item.name;
    const key   = name+':'+price.toFixed(2);
    const ex    = sess.cart.find(c=>c.key===key);
    if(ex) ex.qty++;
    else sess.cart.push({key, name, price, qty:1, label: label==='half'?'½ price':''});
    await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff), cartKeyboard(sess.cart));
    return;
  }

  // Increment qty
  if(data.startsWith('p:')) {
    const idx = parseInt(data.slice(2));
    if(sess.cart[idx]) sess.cart[idx].qty++;
    await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff), cartKeyboard(sess.cart));
    return;
  }

  // Decrement qty
  if(data.startsWith('d:')) {
    const idx = parseInt(data.slice(2));
    if(sess.cart[idx]) {
      sess.cart[idx].qty--;
      if(sess.cart[idx].qty <= 0) sess.cart.splice(idx, 1);
    }
    if(!sess.cart.length) {
      await tgEdit(chatId, msgId, '🛒 Cart is empty.\n\nSelect a category:', categoriesKeyboard());
    } else {
      await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff), cartKeyboard(sess.cart));
    }
    return;
  }

  // View cart
  if(data === 'v') {
    if(!sess.cart.length) {
      await tgEdit(chatId, msgId, '🛒 Cart is empty.\n\nSelect a category:', categoriesKeyboard());
    } else {
      await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff), cartKeyboard(sess.cart));
    }
    return;
  }

  // Confirm sale
  if(data === 'confirm') {
    if(!sess.cart.length) return;
    try {
      const total = sess.cart.reduce((s,i)=>s+i.price*i.qty, 0);
      const {error} = await sb.from('sales').insert({
        staff: sess.staff,
        items: sess.cart.map(i=>({name:i.name+(i.label?' ('+i.label+')':''), price:i.price, qty:i.qty})),
        total, note:'', source:'telegram'
      });
      if(error) throw error;
      const summary = sess.cart.map(i=>`  • ${i.qty}× ${i.name}${i.label?' ('+i.label+')':''} — $${(i.price*i.qty).toFixed(2)}`).join('\n');
      sess.cart = [];
      await tgEdit(chatId, msgId,
        `✅ <b>Sale saved!</b>\n\n${summary}\n\n<b>Total: $${total.toFixed(2)}</b>\nSold by: ${sess.staff}`,
        [[{text:'🆕 New Order', callback_data:'cats'}]]
      );
    } catch(e) {
      await tgEdit(chatId, msgId, '❌ Error: '+e.message, cartKeyboard(sess.cart));
    }
    return;
  }

  // Cancel
  if(data === 'x') {
    sess.cart = [];
    await tgEdit(chatId, msgId, '❌ Order cancelled.',
      [[{text:'🆕 New Order', callback_data:'cats'}]]
    );
    return;
  }
}

// ── REPORT ───────────────────────────────────────────────────
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

  const sales   = data.filter(x=>x.source!=='refund');
  const refunds = data.filter(x=>x.source==='refund');
  const gross   = sales.reduce((s,x)=>s+Number(x.total),0);
  const refAmt  = Math.abs(refunds.reduce((s,x)=>s+Number(x.total),0));
  const net     = gross - refAmt;
  const items   = sales.reduce((s,x)=>s+(x.items||[]).reduce((a,i)=>a+i.qty,0),0);

  const imap={};
  sales.forEach(sale=>(sale.items||[]).forEach(i=>{
    if(!imap[i.name]) imap[i.name]={qty:0,rev:0};
    imap[i.name].qty+=i.qty; imap[i.name].rev+=i.price*i.qty;
  }));
  const top = Object.entries(imap).sort((a,b)=>b[1].rev-a[1].rev).slice(0,5);

  const smap={};
  sales.forEach(x=>{ if(!smap[x.staff]) smap[x.staff]={t:0,r:0}; smap[x.staff].t++; smap[x.staff].r+=Number(x.total); });

  let msg = `<b>📊 ${period.charAt(0).toUpperCase()+period.slice(1)} — Carroll Street Café</b>\n\n`;
  msg += `💰 Gross: <b>$${gross.toFixed(2)}</b>\n`;
  if(refAmt>0) msg += `↩ Refunds: <b>-$${refAmt.toFixed(2)}</b>\n`;
  msg += `💵 Net: <b>$${net.toFixed(2)}</b>\n`;
  msg += `🧾 Sales: <b>${sales.length}</b>  |  Items: <b>${items}</b>\n`;
  msg += `📈 Avg: <b>$${sales.length?(gross/sales.length).toFixed(2):'0.00'}</b>\n\n`;
  msg += `<b>🏆 Top items:</b>\n`;
  msg += top.map(([n,v])=>`  • ${v.qty}× ${n} — $${v.rev.toFixed(2)}`).join('\n');
  msg += `\n\n<b>👩‍💼 By staff:</b>\n`;
  msg += Object.entries(smap).map(([n,v])=>`  • ${n}: ${v.t} sales · $${v.r.toFixed(2)}`).join('\n');
  return msg;
}

// ── MESSAGE HANDLER ───────────────────────────────────────────
async function handleMessage(msg) {
  const chatId   = String(msg.chat.id);
  const userId   = String(msg.from?.id || chatId);
  const userName = msg.from?.first_name || 'Staff';
  const text     = msg.text || '';
  const lower    = text.toLowerCase().trim();

  console.log(`MSG from chatId: ${chatId} | userId: ${userId} | name: ${userName}`);

  const validIds = ALLOWED_IDS.filter(id=>id.length>0);
  if(validIds.length && !validIds.includes(chatId) && !validIds.includes(userId)) {
    await tgSend(chatId, '⛔ Sorry, you are not authorised to use this bot.');
    return;
  }

  const sess = getSession(chatId, userName);

  // ── VOICE NOTE ──
  if(msg.voice || msg.audio) {
    if(!GROQ_KEY) {
      await tgSend(chatId, '🎙 Voice ordering coming soon! Please type your order using the /sell button.');
      return;
    }
    const fileId = msg.voice?.file_id || msg.audio?.file_id;
    await tgSend(chatId, '🎙 Transcribing…');
    const transcript = await transcribeVoice(fileId);
    if(!transcript) {
      await tgSend(chatId, '❌ Could not transcribe. Please use the /sell button to order.');
      return;
    }
    await tgSend(chatId, `📝 I heard: "<i>${transcript}</i>"\n\nUse /sell to order with buttons.`);
    return;
  }

  // ── /start or help ──
  if(lower==='start'||lower==='/start'||lower==='help'||lower==='/help') {
    const msgId = await tgSendKeyboard(chatId,
      `☕ <b>Carroll Street Café POS</b>\n\nWelcome, ${userName}!\n\nTap <b>New Order</b> to start, or use commands:\n• <code>report</code> / <code>report week</code> / <code>report month</code>\n• <code>refund 4.50 wrong order</code>\n• <code>staff [your name]</code>`,
      [[{text:'🛒 New Order', callback_data:'cats'}]]
    );
    return;
  }

  // ── sell (no args) → show button menu ──
  if(lower==='sell'||lower==='/sell'||lower==='order'||lower==='/order') {
    sess.cart = [];
    await tgSendKeyboard(chatId, '☕ <b>Carroll Street Café</b>\n\nSelect a category:', categoriesKeyboard());
    return;
  }

  // ── staff name ──
  if(lower.startsWith('staff ')||lower.startsWith('/staff ')) {
    const name = text.replace(/^(\/?)staff\s+/i,'').trim();
    if(name) { sess.staff=name; await tgSend(chatId, `✅ Name set to: <b>${name}</b>`); }
    return;
  }

  // ── report ──
  if(lower.startsWith('report')||lower==='/report') {
    const period = lower.split(' ')[1] || 'today';
    await tgSend(chatId, await getReport(period));
    return;
  }

  // ── refund ──
  if(lower.startsWith('refund ')||lower.startsWith('/refund ')) {
    const parts = text.replace(/^(\/?)refund\s+/i,'').trim().split(' ');
    const amount = parseFloat(parts[0]);
    if(!amount||amount<=0) {
      await tgSend(chatId, '❌ Usage: <code>refund [amount] [reason]</code>\nExample: <code>refund 4.50 wrong order</code>');
      return;
    }
    const reason = parts.slice(1).join(' ') || 'No reason given';
    const {error} = await sb.from('sales').insert({
      staff:sess.staff, items:[{name:'REFUND',price:-amount,qty:1}],
      total:-amount, note:'Refund: '+reason, source:'refund'
    });
    if(error) { await tgSend(chatId, '❌ Error: '+error.message); return; }
    await tgSend(chatId, `↩ <b>Refund processed</b>\n\nAmount: <b>-$${amount.toFixed(2)}</b>\nReason: ${reason}\nBy: ${sess.staff}`);
    return;
  }

  // ── default → show order button ──
  await tgSendKeyboard(chatId,
    `Tap below to start an order, or type <code>help</code> for all commands.`,
    [[{text:'🛒 New Order', callback_data:'cats'}]]
  );
}

// ── WEBHOOK ───────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const upd = req.body;
    if(upd.message)         await handleMessage(upd.message);
    if(upd.callback_query)  await handleCallback(upd.callback_query);
  } catch(e) {
    console.error('Webhook error:', e);
  }
});

app.get('/', (req,res) => res.send('Carroll Street Café Bot is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
