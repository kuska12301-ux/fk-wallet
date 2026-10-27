(() => {
  const q=s=>document.querySelector(s);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let session=null,usersNext=null,operationsNext=null,historyNext=null,allEntries=[],pending=null,uncertain=false;
  async function api(path,options={}) {
    let response;
    try {response=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(session?{'X-CSRF-Token':session.csrf}:{}),...(session?.sessionToken?{Authorization:'Bearer '+session.sessionToken}:{}),...options.headers},signal:AbortSignal.timeout(15000)});}catch {throw new Error('Сервер недоступен. Проверьте соединение и повторите запрос.');}
    let data;try{data=await response.json();}catch{throw new Error('На этом адресе не запущен сервер FK Wallet на Node.js.');}
    if(!response.ok) {const error=new Error(data.error||'Ошибка запроса.');error.status=response.status;throw error;}
    return data;
  }
  function displayMoney(amount){return amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1').replace('.',',');}
  async function wallet(append=false) {
    const [me,history]=await Promise.all([api('/api/me'),api('/api/transactions'+(append&&historyNext?'?before='+historyNext:''))]);
    session={...me,sessionToken:session?.sessionToken};allEntries=append?[...allEntries,...history.items]:history.items;historyNext=history.next;
    window.FKWalletState={balance:me.user.balance,items:allEntries};window.dispatchEvent(new Event('fk-wallet-updated'));
    q('#profile-name').textContent=me.user.firstName;q('#profile-status').textContent=me.user.username?'@'+me.user.username:'ID '+me.user.id;
    q('.demo-pill').textContent='Внутренний счёт';q('.asset-value p').textContent='Внутренний баланс';
    q('.status').textContent='● Сервер подключён';
    q('.notice span:last-child').textContent='Вход через Telegram выполнен. Пополнение и вывод через Crypto Pay пока не подключены.';
    q('#admin-nav').hidden=!me.isAdmin;q('#admin-content').hidden=!me.isAdmin;q('#admin-gate').hidden=me.isAdmin;
    if(!me.isAdmin)q('#admin-gate-text').textContent='Для вашего Telegram ID нет прав администратора.';
    q('#history-more').hidden=!historyNext;
  }
  async function summary() {
    const data=await api('/api/admin/summary');q('#stat-users').textContent=data.users;q('#stat-total').textContent=displayMoney(data.totalBalance);q('#stat-operations').textContent=data.operations;
  }
  async function users(append=false) {
    const search=q('#user-search').value.trim();
    const data=await api('/api/admin/users?search='+encodeURIComponent(search)+(append&&usersNext?'&before='+encodeURIComponent(usersNext):''));usersNext=data.next;
    const html=data.items.map(u=>`<button class="admin-user" type="button" data-user-id="${esc(u.id)}"><span><strong>${esc(u.firstName)}</strong><small>${u.username?'@'+esc(u.username)+' · ':''}ID ${esc(u.id)}</small></span><b>${esc(displayMoney(u.balance))}<small>USDT</small></b></button>`).join('');
    if(append)q('#admin-users').insertAdjacentHTML('beforeend',html);else q('#admin-users').innerHTML=html||'<p class="muted">Пользователей не найдено. Пользователь появится после первого входа через Telegram.</p>';
    q('#users-more').hidden=!usersNext;
    q('#admin-users').querySelectorAll('[data-user-id]').forEach(button=>button.onclick=()=>{q('#adjust-user').value=button.dataset.userId;q('#adjust-user').focus();});
  }
  async function operations(append=false) {
    const params=new URLSearchParams();const user=q('#operations-user').value.trim(),kind=q('#operations-kind').value;if(user)params.set('userId',user);if(kind)params.set('kind',kind);if(append&&operationsNext)params.set('before',operationsNext);
    const data=await api('/api/admin/operations?'+params);operationsNext=data.next;
    const rows=data.items.map(e=>`<tr><td><b>#${e.id}</b><small>${esc(new Date(e.createdAt).toLocaleString('ru-RU'))}</small><small title="${esc(e.operationId)}">${esc(e.operationId.slice(0,8))}</small></td><td>${e.username?'@'+esc(e.username):'—'}<small>ID ${esc(e.userId)}</small></td><td><span class="${['admin_credit','invoice_credit'].includes(e.kind)?'positive':'debit-text'}">${['admin_credit','invoice_credit'].includes(e.kind)?'+':''}${esc(displayMoney(e.amount))}</span><small>${{admin_credit:'Начисление',admin_debit:'Снятие',invoice_credit:'Входящая оплата',invoice_debit:'Оплата счёта'}[e.kind]}</small></td><td>${esc(displayMoney(e.balanceAfter))}<small>USDT после операции</small></td><td>${esc(e.reason)}<small>Автор: ${esc(e.actorId)}</small></td></tr>`).join('');
    if(append)q('#admin-operations tbody').insertAdjacentHTML('beforeend',rows);else q('#admin-operations').innerHTML=data.items.length?'<table><thead><tr><th>Операция</th><th>Пользователь</th><th>Сумма · USDT</th><th>Баланс после</th><th>Причина / автор</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="muted">Операций пока нет.</p>';
    q('#operations-more').hidden=!operationsNext;
  }
  async function refresh(){q('#admin-error').textContent='';await Promise.all([summary(),users(),operations()]);}
  const run=fn=>async event=>{event?.preventDefault();try{await fn();}catch(error){q('#admin-error').textContent=error.message;}};
  q('#user-search-form').onsubmit=run(()=>users());q('#operations-filter').onsubmit=run(()=>operations());q('#refresh-admin').onclick=run(refresh);q('#users-more').onclick=run(()=>users(true));q('#operations-more').onclick=run(()=>operations(true));
  q('#adjust-form').onsubmit=event=>{
    event.preventDefault();if(!session?.isAdmin)return;
    const body={userId:q('#adjust-user').value.trim(),direction:q('#adjust-direction').value,amount:q('#adjust-amount').value.trim(),reason:q('#adjust-reason').value.trim()};
    if(!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(body.amount)||Number(body.amount)<=0||Number(body.amount)>1000000){q('#adjust-status').textContent='Введите сумму от 0.000001 до 1 000 000 USDT.';return;}
    pending={body,key:crypto.randomUUID()};uncertain=false;q('#review-cancel').disabled=false;q('#review-confirm').textContent='Подтвердить';
    q('#review-details').textContent=(body.direction==='credit'?'Начислить ':'Снять ')+body.amount+' USDT · Telegram ID '+body.userId;
    q('#review-reason').textContent='Причина: '+body.reason;q('#review-error').textContent='';q('#adjust-review').showModal();
  };
  q('#review-cancel').onclick=()=>{if(!uncertain){pending=null;q('#adjust-review').close();}};
  q('#adjust-review').addEventListener('cancel',event=>{if(uncertain)event.preventDefault();});
  q('#review-confirm').onclick=async()=>{
    if(!pending)return;q('#review-confirm').disabled=true;q('#review-cancel').disabled=true;uncertain=true;q('#review-error').textContent='';
    try{
      const data=await api('/api/admin/adjustments',{method:'POST',headers:{'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});
      pending=null;uncertain=false;q('#adjust-review').close();q('#adjust-status').textContent='Операция сохранена. Номер: '+data.operationId;
      await Promise.all([wallet(),refresh()]);
    }catch(error){
      if(error.status){uncertain=false;q('#review-cancel').disabled=false;}
      q('#review-error').textContent=error.message+(uncertain?' Результат неизвестен. Повторите запрос этой кнопкой: повторное списание исключено.':'');q('#review-confirm').textContent=uncertain?'Проверить / повторить':'Повторить';
    }finally{q('#review-confirm').disabled=false;}
  };
  window.FKClient=Object.freeze({request:api,refreshWallet:wallet,user:()=>session?.user||null});
  const more=document.createElement('button');more.id='history-more';more.className='load-more';more.textContent='Загрузить ещё';more.hidden=true;q('#transactions').after(more);more.onclick=run(()=>wallet(true));
  async function start(){
    try{
      const telegram=window.Telegram?.WebApp;
      if(telegram?.initData){telegram.ready();telegram.expand();session=await api('/api/auth/telegram',{method:'POST',body:JSON.stringify({initData:telegram.initData})});}
      await wallet();window.dispatchEvent(new Event('fk-session-ready'));if(session.isAdmin)await refresh();
    }catch(error){
      window.dispatchEvent(new CustomEvent('fk-session-failed',{detail:error.message}));q('#admin-gate-text').textContent=error.message+' Администраторы задаются в ADMIN_TELEGRAM_IDS на сервере.';
      if(window.Telegram?.WebApp?.initData)q('.notice span:last-child').textContent=error.message;
    }
  }
  start();
})();
