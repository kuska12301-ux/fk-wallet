const $ = selector => document.querySelector(selector);
let hidden = false;
// No client-side ledger: balances and operations must come from an authenticated server.
const emptyState = '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">↗</span><h3>Операций пока нет</h3><p>Здесь появятся ваши пополнения, переводы и выводы.</p></div>';
function render() {
  const wallet=window.FKWalletState||{balance:'0.000000',items:[]};
  const parts=wallet.balance.split('.');
  const fraction=(parts[1]||'').replace(/0+$/,'').padEnd(2,'0');
  const formatted=Number(parts[0]).toLocaleString('ru-RU')+','+fraction;
  $('#balance').classList.toggle('amount-long',formatted.length>11);
  $('#balance').innerHTML=hidden?'••••••':Number(parts[0]).toLocaleString('ru-RU')+'<span>,'+fraction+' <small>USDT</small></span>';
  $('#asset-balance').textContent=hidden?'••••••':formatted+' USDT';
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const row=entry=>'<div class="row"><div class="row-icon">'+(['admin_credit','invoice_credit','crypto_deposit','crypto_refund'].includes(entry.kind)?'↓':'↑')+'</div><div><strong>'+({admin_credit:'Начисление администратором',admin_debit:'Снятие администратором',invoice_credit:'Входящая оплата',invoice_debit:'Оплата счёта',crypto_deposit:'Пополнение CryptoBot',crypto_withdraw:'Вывод CryptoBot',crypto_refund:'Возврат вывода'}[entry.kind]||'Операция')+'</strong><p>'+esc(new Date(entry.createdAt).toLocaleString('ru-RU'))+' · '+esc(entry.reason)+'</p></div><div class="row-amount"><strong>'+esc(entry.amount)+' USDT</strong><p>Запись в журнале</p></div></div>';
  $('#recent').innerHTML=wallet.items.slice(0,3).map(row).join('')||emptyState;
  const filter=document.querySelector('[data-filter].selected')?.dataset.filter||'all';
  $('#transactions').innerHTML=wallet.items.filter(entry=>filter==='all'||filter==='deposit'&&['admin_credit','invoice_credit','crypto_deposit','crypto_refund'].includes(entry.kind)||filter==='withdraw'&&['admin_debit','invoice_debit','crypto_withdraw'].includes(entry.kind)).map(row).join('')||emptyState;
}
window.addEventListener('fk-wallet-updated',render);

function go(id) {
  document.querySelectorAll('.page').forEach(page => page.hidden = page.id !== id);
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === id));
  $('#crumb').textContent = {wallet:'Кошелёк', history:'Операции', api:'Для разработчиков', admin:'Админка', checkout:'Оплата счёта'}[id];
  if (!(id==='checkout'&&location.hash.startsWith('#pay=')) && location.hash !== '#' + id) location.hash = id;
}
document.querySelectorAll('[data-page],[data-go]').forEach(button => button.onclick = () => go(button.dataset.page || button.dataset.go));
window.onhashchange = () => { const id=location.hash.slice(1); if(id.startsWith('pay='))go('checkout');else if(['wallet','history','api','admin','checkout'].includes(id)) go(id); };
$('#visibility').onclick = () => { hidden = !hidden; $('#visibility').setAttribute('aria-label', hidden ? 'Показать баланс' : 'Скрыть баланс'); render(); };
document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => {
  const mode = button.dataset.action;
  $('#modal-title').textContent = {deposit:'Пополнить кошелёк', withdraw:'Вывести на CryptoBot', send:'Перевести USDT'}[mode];
  $('#modal-description').textContent = 'Сервис платежей ещё не подключён.';
  $('#recipient-label').hidden = mode === 'deposit';
  $('#recipient').placeholder = mode === 'send' ? 'username' : 'Telegram ID';
  $('#recipient').inputMode = mode === 'send' ? 'text' : 'numeric';
  $('#recipient-prefix').hidden = mode !== 'send';
  $('#recipient-title').textContent = mode === 'send' ? 'Telegram username' : 'Получатель в CryptoBot';
  $('#recipient-hint').textContent = mode === 'send' ? 'Перевод по @username будет доступен после подключения сервера.' : 'Вывод будет доступен после подключения Crypto Pay.';
  $('#available').textContent = (window.FKWalletState?.balance||'0.000000')+' USDT';
  $('#modal-symbol').textContent = {send:'↗',withdraw:'↑',deposit:'↓'}[mode];
  $('#error').textContent = '';
  $('#modal').showModal();
});
$('#close').onclick = () => $('#modal').close();
$('#operation').onsubmit = event => { event.preventDefault(); $('#error').textContent = 'Платежи не подключены. Операция недоступна.'; };
document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('selected', item === button));
  render();
});

render();
go(location.hash.startsWith('#pay=')?'checkout':['wallet','history','api','admin'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'wallet');
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{"wallet":"<rect x=\"3\" y=\"6\" width=\"18\" height=\"15\" rx=\"3\"/><path d=\"M17 14h4M3 9V6a2 2 0 0 1 2-2h12\"/>","history":"<path d=\"M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2\"/>","api":"<path d=\"m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18\"/>","deposit":"<path d=\"M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4\"/>","withdraw":"<path d=\"M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4\"/>","send":"<path d=\"m21 3-7 18-4-7-7-4 18-7ZM10 14 21 3\"/>"}[name]}</svg>`;document.querySelectorAll("[data-page]").forEach(b=>{b.innerHTML=(b.dataset.page==='admin'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/></svg>':icon(b.dataset.page))+b.querySelector("span").outerHTML});document.querySelectorAll("[data-action]").forEach(b=>{b.innerHTML=icon(b.dataset.action)+`<span>${{deposit:"Пополнить",withdraw:"Вывести",send:"Перевести"}[b.dataset.action]}</span>`});
