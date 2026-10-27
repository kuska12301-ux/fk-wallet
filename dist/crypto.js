(() => {
  const q = s => document.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let ready = false, mode = 'deposit', request = null, busy = false, refreshing = false;
  const form = q('#operation'), submit = form.querySelector('button[type=submit]');
  const details = form.querySelector('p.muted');
  const confirmLabel = document.createElement('label');
  confirmLabel.className = 'check-label'; confirmLabel.hidden = true;
  confirmLabel.innerHTML = '<input id="crypto-consent" type="checkbox"><span>Подтверждаю вывод на мой аккаунт CryptoBot. Сумма будет списана с внутреннего баланса.</span>';
  submit.before(confirmLabel);
  const result = document.createElement('div'); result.id = 'crypto-result'; result.setAttribute('role','status'); form.after(result);
  const panel = document.createElement('article');panel.className='api-card';panel.style.marginTop='24px';
  panel.innerHTML='<div class="section-head"><h2>Пополнения и выводы CryptoBot</h2><button id="crypto-refresh" type="button">Обновить</button></div><div id="crypto-jobs"><p class="muted">Войдите через Telegram.</p></div>';
  q('#transactions').after(panel);
  const labels = {creating:'Готовим оплату',active:'Ожидает оплаты',pending:'Вывод обрабатывается',paid:'Зачислено',completed:'Выведено',failed:'Отклонено',expired:'Срок счёта истёк'};
  function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='t.me'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
  function link(url){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.className='primary';a.textContent='Оплатить в CryptoBot';a.onclick=event=>{if(window.Telegram?.WebApp?.openTelegramLink){event.preventDefault();window.Telegram.WebApp.openTelegramLink(url);}};return a;}
  function show(job){
    result.replaceChildren();const p=document.createElement('p');p.textContent=labels[job.status]+' · '+job.amount+' USDT'+(job.creditedAmount?' · на баланс '+job.creditedAmount+' USDT':'');result.append(p);
    const url=safeUrl(job.paymentUrl);if(job.status==='active'&&url)result.append(link(url));
    if(job.error){const error=document.createElement('p');error.textContent=job.error;result.append(error);}
  }
  async function refresh(){
    if(!ready||refreshing)return;refreshing=true;
    try{
      const data=await window.FKClient.request('/api/crypto/operations');
      ready=data.configured;
      q('#crypto-jobs').innerHTML=data.items.map(job=>'<div class="row"><div><strong>'+esc(job.kind==='deposit'?'Пополнение':'Вывод')+' · '+esc(job.amount)+' USDT</strong><p>'+esc(labels[job.status])+(job.creditedAmount?' · зачислено '+esc(job.creditedAmount)+' USDT':'')+'</p><small>'+esc(new Date(job.createdAt).toLocaleString('ru-RU'))+'</small>'+(job.error?'<p>'+esc(job.error)+'</p>':'')+'</div></div>').join('')||'<p class="muted">Операций пока нет.</p>';
      if(request?.id){const job=data.items.find(item=>item.id===request.id);if(job)show(job);}
      await window.FKClient.refreshWallet();
    }catch(error){q('#crypto-jobs').textContent=error.message;}finally{refreshing=false;}
  }
  document.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>{
    mode=button.dataset.action;request=null;result.replaceChildren();form.reset();q('#error').textContent='';
    q('#modal-title').textContent={deposit:'Пополнить через CryptoBot',withdraw:'Вывести на CryptoBot',send:'Перевести USDT'}[mode];
    q('#modal-description').textContent=mode==='deposit'?'Введите сумму и оплатите счёт в CryptoBot. Зачисление — автоматически.':mode==='withdraw'?'Вывод на ваш аккаунт CryptoBot. Обычно занимает до минуты.':'Переводы по username пока не подключены.';
    q('#modal-symbol').textContent=mode==='deposit'?'↓':'↑';q('#recipient-label').hidden=true;
    q('#sum').disabled=!ready||mode==='send';q('#sum').min='1';q('#sum').max='25000';q('#sum').step='0.000001';
    q('#available').textContent=(window.FKWalletState?.balance||'0.000000')+' USDT';
    confirmLabel.hidden=mode!=='withdraw';q('#crypto-consent').required=mode==='withdraw';
    details.textContent=mode==='deposit'?'От 1 до 25 000 USDT. На баланс поступит сумма за вычетом комиссии Crypto Pay. Статус обновляется автоматически.':mode==='withdraw'?'От 1 до 25 000 USDT. Получатель — ваш Telegram ID. Перед выводом откройте @CryptoBot. При отказе резерв возвращается автоматически.':'Переводы между пользователями пока недоступны.';
    submit.disabled=!ready||mode==='send';submit.textContent=!ready?'Crypto Pay недоступен':mode==='deposit'?'Перейти к оплате':'Подтвердить вывод';
    q('#modal').showModal();if(!q('#sum').disabled)q('#sum').focus();
  });
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!ready||mode==='send')return;
    const amount=q('#sum').value.trim();
    if(!/^(0|[1-9]\d{0,4})(\.\d{1,6})?$/.test(amount)||Number(amount)<1||Number(amount)>25000){q('#error').textContent='Введите сумму от 1 до 25 000 USDT, до 6 знаков после точки.';return;}
    if(mode==='withdraw'&&!q('#crypto-consent').checked)return;
    if(!request)request={key:crypto.randomUUID(),amount,mode};
    // Unknown network outcome: retry exactly the same request, never a new debit.
    busy=true;submit.disabled=true;q('#sum').disabled=true;q('#error').textContent='';
    try{
      const job=await window.FKClient.request('/api/crypto/'+(request.mode==='deposit'?'deposits':'withdrawals'),{method:'POST',headers:{'Idempotency-Key':request.key},body:JSON.stringify({amount:request.amount,confirm:request.mode==='withdraw'})});
      request.id=job.id;show(job);submit.hidden=true;await refresh();
    }catch(error){q('#error').textContent=error.message+' Повтор использует тот же номер операции.';submit.textContent='Проверить / повторить';submit.disabled=false;}
    finally{busy=false;}
  };
  q('#modal').addEventListener('close',()=>{submit.hidden=false;});
  q('#crypto-refresh').onclick=()=>refresh();
  window.addEventListener('fk-session-ready',async()=>{
    try{const status=await window.FKClient.request('/api/crypto/operations');ready=status.configured;if(ready){q('.notice span:last-child').textContent='CryptoBot подключён';await refresh();}}catch{}
  });
  setInterval(()=>{if(!document.hidden)refresh();},15000);
  window.addEventListener('focus',()=>refresh());
})();
