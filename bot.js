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
  if(!sessions[chatId]) sessions[chatId] = {staff: userName, cart: [], discount: null, pendingItems: null};
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

function discountKeyboard() {
  return [
    [{text:'5%',  callback_data:'disc:pct:5'},  {text:'10%', callback_data:'disc:pct:10'},
     {text:'15%', callback_data:'disc:pct:15'}, {text:'20%', callback_data:'disc:pct:20'}],
    [{text:'25%', callback_data:'disc:pct:25'}, {text:'30%', callback_data:'disc:pct:30'},
     {text:'50%', callback_data:'disc:pct:50'}, {text:'Student/Staff', callback_data:'disc:pct:15'}],
    [{text:'−$1.00', callback_data:'disc:amt:1'},  {text:'−$2.00', callback_data:'disc:amt:2'},
     {text:'−$5.00', callback_data:'disc:amt:5'},  {text:'−$10.00',callback_data:'disc:amt:10'}],
    [{text:'⬅️ Back to Cart', callback_data:'v'}],
    [{text:'❌ Cancel Order', callback_data:'x'}],
  ];
}

function cartKeyboard(cart, discount) {
  const rows = [];
  cart.forEach((item, idx) => {
    rows.push([
      {text:`${item.qty}×  ${item.name}  $${(item.price*item.qty).toFixed(2)}`, callback_data:'noop'},
      {text:'−', callback_data:`d:${idx}`},
      {text:'+', callback_data:`p:${idx}`},
    ]);
  });
  rows.push([
    {text:'➕ Add More',      callback_data:'cats'},
    {text: discount ? '🏷 Edit Discount' : '🏷 Add Discount', callback_data:'disc'},
  ]);
  if(discount) {
    rows.push([{text:'✖ Remove Discount', callback_data:'disc:rm'}]);
  }
  rows.push([
    {text:'✅ Confirm Sale', callback_data:'confirm'},
    {text:'❌ Cancel',       callback_data:'x'},
  ]);
  return rows;
}

function calcDiscount(subtotal, discount) {
  if(!discount) return 0;
  if(discount.type==='pct') return parseFloat((subtotal * discount.value / 100).toFixed(2));
  if(discount.type==='amt') return Math.min(discount.value, subtotal);
  return 0;
}

function cartText(cart, staffName, discount) {
  if(!cart.length) return '🛒 Cart is empty.';
  const subtotal = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  const discAmt  = calcDiscount(subtotal, discount);
  const total    = subtotal - discAmt;
  const lines    = cart.map(i=>`  • ${i.qty}×  ${i.name}${i.label?' ('+i.label+')':''} — $${(i.price*i.qty).toFixed(2)}`).join('\n');
  let txt = `🛒 <b>Order — ${staffName}</b>\n\n${lines}\n\nSubtotal: $${subtotal.toFixed(2)}`;
  if(discount) {
    const label = discount.type==='pct' ? `${discount.value}%` : `$${discount.value.toFixed(2)}`;
    txt += `\n🏷 Discount (${label}): -$${discAmt.toFixed(2)}`;
  }
  txt += `\n<b>Total: $${total.toFixed(2)}</b>\n\nUse − / + to adjust quantities.`;
  return txt;
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
    await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff, sess.discount), cartKeyboard(sess.cart, sess.discount));
    return;
  }

  // Increment qty
  if(data.startsWith('p:')) {
    const idx = parseInt(data.slice(2));
    if(sess.cart[idx]) sess.cart[idx].qty++;
    await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff, sess.discount), cartKeyboard(sess.cart, sess.discount));
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
      await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff, sess.discount), cartKeyboard(sess.cart, sess.discount));
    }
    return;
  }

  // Show discount options
  if(data === 'disc') {
    const subtotal = sess.cart.reduce((s,i)=>s+i.price*i.qty, 0);
    await tgEdit(chatId, msgId,
      `🏷 <b>Apply Discount</b>\n\nSubtotal: $${subtotal.toFixed(2)}\n\nSelect a percentage or fixed amount off:`,
      discountKeyboard()
    );
    return;
  }

  // Apply / remove discount
  if(data.startsWith('disc:')) {
    const parts = data.split(':');
    if(parts[1]==='rm') {
      sess.discount = null;
    } else {
      const type  = parts[1]; // 'pct' or 'amt'
      const value = parseFloat(parts[2]);
      sess.discount = {type, value};
    }
    await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff, sess.discount), cartKeyboard(sess.cart, sess.discount));
    return;
  }

  // View cart
  if(data === 'v') {
    if(!sess.cart.length) {
      await tgEdit(chatId, msgId, '🛒 Cart is empty.\n\nSelect a category:', categoriesKeyboard());
    } else {
      await tgEdit(chatId, msgId, cartText(sess.cart, sess.staff, sess.discount), cartKeyboard(sess.cart, sess.discount));
    }
    return;
  }

  // Confirm sale
  if(data === 'confirm') {
    if(!sess.cart.length) return;
    try {
      const subtotal  = sess.cart.reduce((s,i)=>s+i.price*i.qty, 0);
      const discAmt   = calcDiscount(subtotal, sess.discount);
      const total     = subtotal - discAmt;
      const discLabel = sess.discount
        ? (sess.discount.type==='pct' ? `${sess.discount.value}% off` : `$${sess.discount.value.toFixed(2)} off`)
        : '';
      const {error} = await sb.from('sales').insert({
        staff: sess.staff,
        items: sess.cart.map(i=>({name:i.name+(i.label?' ('+i.label+')':''), price:i.price, qty:i.qty})),
        total, note: discLabel ? `Discount: ${discLabel}` : '', source:'telegram'
      });
      if(error) throw error;
      const summary  = sess.cart.map(i=>`  • ${i.qty}× ${i.name}${i.label?' ('+i.label+')':''} — $${(i.price*i.qty).toFixed(2)}`).join('\n');
      const discLine = discAmt>0 ? `\n🏷 Discount (${discLabel}): -$${discAmt.toFixed(2)}` : '';
      sess.cart = []; sess.discount = null;
      await tgEdit(chatId, msgId,
        `✅ <b>Sale saved!</b>\n\n${summary}\n\nSubtotal: $${subtotal.toFixed(2)}${discLine}\n<b>Total: $${total.toFixed(2)}</b>\nSold by: ${sess.staff}`,
        [[{text:'🆕 New Order', callback_data:'cats'}]]
      );
    } catch(e) {
      await tgEdit(chatId, msgId, '❌ Error: '+e.message, cartKeyboard(sess.cart, sess.discount));
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

// ── REPORT ENGINE ─────────────────────────────────────────────
function bar(value, max, len=10) {
  const filled = Math.round((value/max)*len);
  return '█'.repeat(filled)+'░'.repeat(len-filled);
}

function pct(part, total) {
  return total ? ((part/total)*100).toFixed(1)+'%' : '0%';
}

function formatHour(h) {
  if(h===0)  return '12 AM';
  if(h<12)   return h+' AM';
  if(h===12) return '12 PM';
  return (h-12)+' PM';
}

// Category lookup from item name
function getCategory(itemName) {
  const found = MENU.find(m=>itemName.toLowerCase().includes(m.name.toLowerCase()));
  return found ? found.cat : 'Other';
}

async function sendReport(chatId, period='today') {
  const now = new Date();
  let from, label;
  if(period==='today') {
    from  = now.toISOString().slice(0,10)+'T00:00:00';
    label = 'Today · '+now.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  } else if(period==='week') {
    const d=new Date(now); d.setDate(d.getDate()-7);
    from=d.toISOString();
    label='Last 7 Days';
  } else {
    from=now.toISOString().slice(0,7)+'-01T00:00:00';
    label=now.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  }

  const {data,error} = await sb.from('sales').select('*').gte('created_at',from).order('created_at',{ascending:true});
  if(error||!data||!data.length) {
    await tgSend(chatId, `📊 No sales found for ${period} yet.`);
    return;
  }

  const sales   = data.filter(x=>x.source!=='refund');
  const refunds = data.filter(x=>x.source==='refund');
  if(!sales.length) { await tgSend(chatId, '📊 No completed sales yet.'); return; }

  // ── Core metrics ──
  const gross    = sales.reduce((s,x)=>s+Number(x.total),0);
  const refAmt   = Math.abs(refunds.reduce((s,x)=>s+Number(x.total),0));
  const net      = gross-refAmt;
  const avgTx    = gross/sales.length;
  const allItems = sales.flatMap(x=>x.items||[]);
  const totalQty = allItems.reduce((s,i)=>s+i.qty,0);

  // ── Discount intelligence ──
  const discountedSales = sales.filter(x=>x.note&&x.note.startsWith('Discount:'));
  const discountTotal   = discountedSales.reduce((s,x)=>{
    const orig = (x.items||[]).reduce((a,i)=>a+i.price*i.qty,0);
    return s+(orig-Number(x.total));
  },0);

  // ── Hourly analysis ──
  const hourly = {};
  sales.forEach(x=>{
    const h = new Date(x.created_at).getHours();
    if(!hourly[h]) hourly[h]={rev:0,cnt:0};
    hourly[h].rev+=Number(x.total); hourly[h].cnt++;
  });
  const hourKeys    = Object.keys(hourly).map(Number).sort((a,b)=>a-b);
  const maxHourRev  = Math.max(...Object.values(hourly).map(h=>h.rev));
  const peakHour    = hourKeys.reduce((a,b)=>hourly[a].rev>hourly[b].rev?a:b);
  const quietHour   = hourKeys.reduce((a,b)=>hourly[a].rev<hourly[b].rev?a:b);
  const avgHourRev  = gross/hourKeys.length;
  const rushHours   = hourKeys.filter(h=>hourly[h].rev>=avgHourRev*1.2);
  const slowHours   = hourKeys.filter(h=>hourly[h].rev<=avgHourRev*0.5);
  const morningRev  = hourKeys.filter(h=>h<12).reduce((s,h)=>s+hourly[h].rev,0);
  const afternoonRev= hourKeys.filter(h=>h>=12&&h<17).reduce((s,h)=>s+hourly[h].rev,0);
  const eveningRev  = hourKeys.filter(h=>h>=17).reduce((s,h)=>s+hourly[h].rev,0);

  // ── Item analysis ──
  const imap={};
  allItems.forEach(i=>{
    const key=i.name.replace(/\s*\(½.*?\)/,'').trim();
    if(!imap[key]) imap[key]={qty:0,rev:0,cat:getCategory(key)};
    imap[key].qty+=i.qty; imap[key].rev+=i.price*i.qty;
  });
  const iEntries  = Object.entries(imap).filter(([,v])=>!v.rev<0);
  const byRev     = [...iEntries].sort((a,b)=>b[1].rev-a[1].rev);
  const byQty     = [...iEntries].sort((a,b)=>b[1].qty-a[1].qty);
  const top5      = byRev.slice(0,5);
  const slow3     = byRev.slice(-3).reverse();
  const topItem   = byRev[0];
  const maxItemRev= topItem ? topItem[1].rev : 1;

  // ── Category analysis ──
  const catmap={};
  allItems.forEach(i=>{
    const cat=getCategory(i.name);
    if(!catmap[cat]) catmap[cat]={rev:0,qty:0};
    catmap[cat].rev+=i.price*i.qty; catmap[cat].qty+=i.qty;
  });
  const catEntries=Object.entries(catmap).sort((a,b)=>b[1].rev-a[1].rev);

  // ── Staff analysis ──
  const smap={};
  sales.forEach(x=>{
    if(!smap[x.staff]) smap[x.staff]={cnt:0,rev:0};
    smap[x.staff].cnt++; smap[x.staff].rev+=Number(x.total);
  });
  const staffEntries=Object.entries(smap).sort((a,b)=>b[1].rev-a[1].rev);
  const topStaff=staffEntries[0];

  // ── MESSAGE 1: Summary + Time ──────────────────────────────
  let m1=`📊 <b>Carroll Street Café</b>\n<b>${label}</b>\n${'─'.repeat(28)}\n\n`;
  m1+=`💰 Gross Revenue:  <b>$${gross.toFixed(2)}</b>\n`;
  if(refAmt>0) m1+=`↩ Refunds:         <b>-$${refAmt.toFixed(2)}</b>\n`;
  m1+=`💵 Net Revenue:    <b>$${net.toFixed(2)}</b>\n`;
  if(discountTotal>0) m1+=`🏷 Discounts Given: <b>$${discountTotal.toFixed(2)}</b> (${pct(discountTotal,gross)} of gross)\n`;
  m1+=`\n🧾 Transactions:   <b>${sales.length}</b>\n`;
  m1+=`🛍 Items Sold:      <b>${totalQty}</b>\n`;
  m1+=`💳 Avg Transaction: <b>$${avgTx.toFixed(2)}</b>\n`;
  m1+=`🏆 Largest Sale:    <b>$${Math.max(...sales.map(x=>Number(x.total))).toFixed(2)}</b>\n`;
  m1+=`\n⏰ <b>Sales by Time of Day</b>\n`;
  if(morningRev>0)   m1+=`  🌅 Morning (before noon): $${morningRev.toFixed(2)} — ${pct(morningRev,gross)}\n`;
  if(afternoonRev>0) m1+=`  ☀️ Afternoon (12–5 PM):   $${afternoonRev.toFixed(2)} — ${pct(afternoonRev,gross)}\n`;
  if(eveningRev>0)   m1+=`  🌙 Evening (after 5 PM):  $${eveningRev.toFixed(2)} — ${pct(eveningRev,gross)}\n`;
  m1+=`\n🔥 Peak Hour:    <b>${formatHour(peakHour)}</b> — $${hourly[peakHour].rev.toFixed(2)} (${hourly[peakHour].cnt} orders)\n`;
  m1+=`😴 Quietest Hour: <b>${formatHour(quietHour)}</b> — $${hourly[quietHour].rev.toFixed(2)} (${hourly[quietHour].cnt} orders)\n`;
  if(rushHours.length) m1+=`\n📈 Rush periods: ${rushHours.map(formatHour).join(', ')}\n`;
  if(slowHours.length) m1+=`📉 Slow periods: ${slowHours.map(formatHour).join(', ')}\n`;

  // Hourly bar chart (only for today)
  if(period==='today'&&hourKeys.length>1) {
    m1+=`\n<b>Hourly Revenue:</b>\n<pre>`;
    hourKeys.forEach(h=>{
      const label=formatHour(h).padStart(5);
      const b=bar(hourly[h].rev,maxHourRev,8);
      m1+=`${label} ${b} $${hourly[h].rev.toFixed(0)}\n`;
    });
    m1+=`</pre>`;
  }

  await tgSend(chatId, m1);

  // ── MESSAGE 2: Item & Category Intelligence ─────────────────
  let m2=`🏆 <b>Menu Performance</b>\n${'─'.repeat(28)}\n\n`;
  m2+=`<b>Top 5 by Revenue:</b>\n<pre>`;
  top5.forEach(([name,v],i)=>{
    const b=bar(v.rev,maxItemRev,7);
    m2+=`${(i+1)}. ${name.slice(0,18).padEnd(18)} ${b}\n   $${v.rev.toFixed(2)} · ${v.qty}× · ${pct(v.rev,gross)}\n`;
  });
  m2+=`</pre>`;

  m2+=`\n<b>Top 5 by Volume (units sold):</b>\n`;
  byQty.slice(0,5).forEach(([name,v],i)=>{
    m2+=`  ${i+1}. ${name} — ${v.qty} sold\n`;
  });

  if(slow3.length) {
    m2+=`\n<b>📉 Slow Movers Today:</b>\n`;
    slow3.forEach(([name,v])=>{ m2+=`  • ${name} — only ${v.qty} sold ($${v.rev.toFixed(2)})\n`; });
  }

  // Items not ordered (from known menu)
  const orderedNames = new Set(Object.keys(imap).map(n=>n.toLowerCase()));
  const notOrdered   = MENU.filter(m=>!orderedNames.has(m.name.toLowerCase())).slice(0,5);
  if(notOrdered.length) {
    m2+=`\n<b>😶 Not Ordered Today:</b>\n`;
    notOrdered.forEach(m=>{ m2+=`  • ${m.name}\n`; });
  }

  m2+=`\n<b>📂 Revenue by Category:</b>\n<pre>`;
  catEntries.forEach(([cat,v])=>{
    const b=bar(v.rev,catEntries[0][1].rev,8);
    m2+=`${cat.slice(0,12).padEnd(12)} ${b} ${pct(v.rev,gross)}\n`;
  });
  m2+=`</pre>`;

  await tgSend(chatId, m2);

  // ── MESSAGE 3: Staff + Smart Insights ──────────────────────
  let m3=`👩‍💼 <b>Staff Performance</b>\n${'─'.repeat(28)}\n\n`;
  staffEntries.forEach(([name,v])=>{
    const avg=(v.rev/v.cnt).toFixed(2);
    m3+=`<b>${name}</b>\n  ${v.cnt} sales · $${v.rev.toFixed(2)} revenue · avg $${avg}\n`;
  });
  if(staffEntries.length>1) {
    const topAvgStaff=staffEntries.reduce((a,b)=>(a[1].rev/a[1].cnt)>(b[1].rev/b[1].cnt)?a:b);
    m3+=`\n⭐ Highest avg sale: <b>${topAvgStaff[0]}</b> at $${(topAvgStaff[1].rev/topAvgStaff[1].cnt).toFixed(2)}\n`;
  }
  if(refunds.length) {
    m3+=`\n↩ <b>Refunds Today:</b> ${refunds.length} · -$${refAmt.toFixed(2)}\n`;
  }

  // ── Smart Insights ──
  m3+=`\n💡 <b>Smart Insights</b>\n${'─'.repeat(28)}\n`;
  const insights=[];

  if(topItem) insights.push(`"${topItem[0]}" is your #1 earner at $${topItem[1].rev.toFixed(2)} (${pct(topItem[1].rev,gross)} of revenue) — keep it stocked.`);

  const topCat=catEntries[0];
  if(topCat) insights.push(`<b>${topCat[0]}</b> is your strongest category — ${pct(topCat[1].rev,gross)} of today's revenue.`);

  if(morningRev>afternoonRev&&morningRev>eveningRev) insights.push(`You're a morning-heavy business. ${pct(morningRev,gross)} of revenue before noon — ensure full staff for opening.`);
  else if(afternoonRev>morningRev) insights.push(`Afternoon is your strongest window — ${pct(afternoonRev,gross)} of daily revenue hits 12–5 PM.`);

  if(slowHours.length>=2) insights.push(`${slowHours.map(formatHour).join(' & ')} are consistently slow. Consider prep tasks, cleaning or staff breaks then.`);

  if(discountTotal>gross*0.1) insights.push(`⚠️ Discounts are eating ${pct(discountTotal,gross)} of gross revenue. Review discount policy.`);
  else if(discountTotal>0) insights.push(`Discounts were well-controlled at ${pct(discountTotal,gross)} of gross.`);

  if(avgTx>12) insights.push(`Strong average transaction of $${avgTx.toFixed(2)} — customers are buying multiple items.`);
  else if(avgTx<7) insights.push(`Low avg transaction ($${avgTx.toFixed(2)}). Consider upsell prompts — "Add a muffin?" etc.`);

  if(notOrdered.length>5) insights.push(`${notOrdered.length} menu items went unordered today. Review pricing or remove slow items.`);

  if(sales.length<10) insights.push(`Only ${sales.length} transactions today — is this a short day or slow period?`);

  const highestSale=Math.max(...sales.map(x=>Number(x.total)));
  if(highestSale>20) insights.push(`Largest single order was $${highestSale.toFixed(2)} — group orders happening.`);

  insights.forEach((ins,i)=>{ m3+=`\n${i+1}. ${ins}`; });

  m3+=`\n\n─────────────────────────\nType <code>report week</code> or <code>report month</code> for broader trends.`;

  await tgSend(chatId, m3);
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
    sess.cart = []; sess.discount = null;
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
    await sendReport(chatId, period);
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
