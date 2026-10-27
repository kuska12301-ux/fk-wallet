(() => {
  const q=selector=>document.querySelector(selector),client=window.FKClient;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statuses={active:'Ожидает оплаты',paid:'Оплачен',expired:'Истёк',cancelled:'Отменён',pending:'Ожидает доставки',delivering:'Отправляется',delivered:'Доставлен',failed:'Ошибка',cancelled:'Отменён'};
  let apps=[],selected=null,invoiceNext=null,eventNext=null,invoicePending=null,checkout=null,payPending=null,confirmation=null,paying=false;
  const base=id=>'/api/developer/apps/'+id;
  const wrap=action=>async event=>{event?.preventDefault();q('#dev-error').textContent='';try{await action(event);}catch(error){q('#dev-error').textContent=error.message;}};
  function showSecrets(data){
    const area=q('#dev-secrets-content');area.replaceChildren();
    for(const [key,label]of [['apiKey','API-ключ'],['webhookSecret','Секрет подписи webhook']])if(data[key]){
      const field=document.createElement('label');field.textContent=label;const input=document.createElement('textarea');input.readOnly=true;input.rows=3;input.spellcheck=false;input.value=data[key];field.append(input);
      const copy=document.createElement('button');copy.type='button';copy.className='text-action';copy.textContent='Скопировать';copy.onclick=async()=>{try{await navigator.clipboard.writeText(input.value);copy.textContent='Скопировано';}catch{input.select();copy.textContent='Выделено — скопируйте вручную';}};field.append(copy);area.append(field);
    }
    q('#dev-secrets').showModal();
  }
  function clearSecrets(){q('#dev-secrets-content').replaceChildren();}
  q('#dev-secrets-close').onclick=()=>q('#dev-secrets').close();q('#dev-secrets').addEventListener('close',clearSecrets);
  function confirm(title,text,action){confirmation=action;q('#dev-confirm-title').textContent=title;q('#dev-confirm-text').textContent=text;q('#dev-confirm').showModal();}
  q('#dev-confirm-cancel').onclick=()=>{confirmation=null;q('#dev-confirm').close();};
  q('#dev-confirm-yes').onclick=async()=>{if(!confirmation)return;q('#dev-confirm-yes').disabled=true;try{await confirmation();confirmation=null;q('#dev-confirm').close();}catch(error){q('#dev-confirm-text').textContent=error.message;}finally{q('#dev-confirm-yes').disabled=false;}};
  async function loadApps(wanted=selected?.id){
    const data=await client.request('/api/developer/apps');apps=data.items;
    q('#dev-content').hidden=!data.configured;q('#dev-gate').hidden=data.configured;
    if(!data.configured)q('#dev-gate-text').textContent='Администратору нужно задать APP_ENCRYPTION_KEY в .env и перезапустить Node.js. Команда генерации есть в инструкции.';
    q('#dev-select').innerHTML='<option value="">Выберите приложение</option>'+apps.map(app=>`<option value="${esc(app.id)}">${esc(app.name)}</option>`).join('');
    const pick=apps.find(app=>app.id===wanted)||apps[0];q('#dev-select').value=pick?.id||'';await choose(pick?.id);
  }
  async function choose(id){
    selected=apps.find(app=>app.id===id)||null;invoiceNext=null;eventNext=null;invoicePending=null;
    q('#dev-selected').hidden=!selected;
    if(!selected){q('#dev-summary').textContent='Приложений пока нет.';return;}
    q('#dev-summary').innerHTML=`<p>ID: <code>${esc(selected.id)}</code></p><p>Ключ: <code>${esc(selected.keyPrefix)}…</code> · ${selected.keyActive?'активен':'отозван'}</p><p>Расчёты: внутренний кошелёк владельца.</p>`;
    q('#dev-edit-name').value=selected.name;q('#dev-edit-hook').value=selected.webhookUrl||'';
    q('#dev-code').textContent=`import { FKPay } from './sdk/fk-pay.mjs';\n\nconst pay = new FKPay({\n  baseUrl: '${location.origin}',\n  apiKey: process.env.FK_PAY_API_KEY\n});\n\nconst invoice = await pay.createInvoice({\n  amount: '10.000000',\n  description: 'Заказ №123',\n  payload: 'order-123'\n}, crypto.randomUUID());\n\n// Отправьте покупателю эту ссылку:\nconsole.log(invoice.telegramUrl\n  || invoice.paymentUrl);`;
    await Promise.all([loadInvoices(),loadEvents()]);
  }
  q('#dev-select').onchange=wrap(()=>choose(q('#dev-select').value));
  q('#dev-create').onsubmit=wrap(async()=>{
    const button=q('#dev-create button');button.disabled=true;
    try{const data=await client.request('/api/developer/apps',{method:'POST',body:JSON.stringify({name:q('#dev-name').value.trim(),webhookUrl:q('#dev-hook').value.trim()||null})});await loadApps(data.id);q('#dev-create').reset();showSecrets(data);}
    catch(error){await loadApps().catch(()=>{});throw error;}finally{button.disabled=false;}
  });
  q('#dev-settings').onsubmit=wrap(()=>{
    const id=selected.id,body={name:q('#dev-edit-name').value.trim(),webhookUrl:q('#dev-edit-hook').value.trim()||null};
    confirm('Сохранить настройки?','При смене webhook URL недоставленные события будут отменены. Их можно поставить в очередь повторно.',async()=>{await client.request(base(id),{method:'PATCH',body:JSON.stringify(body)});await loadApps(id);q('#dev-status').textContent='Настройки сохранены.';});
  });
  q('#dev-rotate').onclick=()=>{if(!selected)return;const id=selected.id;confirm('Перевыпустить API-ключ?','Старый ключ сразу перестанет работать. Новый ключ нужно установить на сервере вашего проекта.',async()=>{const data=await client.request(base(id)+'/rotate-key',{method:'POST'});await loadApps(id);q('#dev-confirm').close();showSecrets(data);});};
  q('#dev-revoke').onclick=()=>{if(!selected)return;const id=selected.id;confirm('Отозвать API-ключ?','Интеграция потеряет доступ к API до перевыпуска ключа. Ранее созданные счета останутся доступны для оплаты.',async()=>{await client.request(base(id)+'/revoke-key',{method:'POST'});await loadApps(id);});};
  q('#dev-invoice-form').onsubmit=wrap(async()=>{
    if(!selected)return;const id=selected.id,body={amount:q('#dev-amount').value.trim(),asset:'USDT',description:q('#dev-description').value.trim(),payload:q('#dev-payload').value,expiresIn:Number(q('#dev-ttl').value)};
    const fingerprint=JSON.stringify([id,body]);if(invoicePending?.fingerprint!==fingerprint)invoicePending={fingerprint,key:crypto.randomUUID()};const key=invoicePending.key;
    const button=q('#dev-invoice-form button');button.disabled=true;
    try{const data=await client.request(base(id)+'/invoices',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)});invoicePending=null;
      q('#dev-invoice-result').innerHTML=`Счёт создан. <a href="${esc(data.telegramUrl||data.paymentUrl)}" target="_blank" rel="noopener">Ссылка для покупателя ↗</a><br><small>${esc(data.id)}</small>`;await loadInvoices();
    }finally{button.disabled=false;}
  });
  async function loadInvoices(append=false){
    if(!selected)return;const id=selected.id,data=await client.request(base(id)+'/invoices'+(append&&invoiceNext?'?before='+invoiceNext:''));if(selected?.id!==id)return;invoiceNext=data.next;
    const rows=data.items.map(invoice=>`<tr><td>${esc(invoice.amount)} USDT<small>${esc(invoice.description)}</small><small>${esc(invoice.id)}</small></td><td>${esc(statuses[invoice.status])}<small>${esc(new Date(invoice.createdAt).toLocaleString('ru-RU'))}</small></td><td><a href="#pay=${esc(invoice.id)}">Открыть счёт ↗</a>${invoice.status==='active'?`<button class="text-action" data-cancel="${esc(invoice.id)}">Отменить</button>`:''}</td></tr>`).join('');
    if(append)q('#dev-invoices tbody').insertAdjacentHTML('beforeend',rows);else q('#dev-invoices').innerHTML=rows?'<table class="dev-invoice-table"><thead><tr><th>Счёт</th><th>Статус</th><th>Действия</th></tr></thead><tbody>'+rows+'</tbody></table>':'<p class="muted">Создайте первый счёт через форму или API.</p>';
    q('#dev-invoices-more').hidden=!invoiceNext;
    q('#dev-invoices').querySelectorAll('[data-cancel]').forEach(button=>button.onclick=()=>confirm('Отменить счёт?','Покупатель больше не сможет оплатить этот счёт.',async()=>{await client.request(base(id)+'/invoices/'+button.dataset.cancel+'/cancel',{method:'POST'});await loadInvoices();}));
  }
  async function loadEvents(append=false){
    if(!selected)return;const id=selected.id,data=await client.request(base(id)+'/events'+(append&&eventNext?'?before='+eventNext:''));if(selected?.id!==id)return;eventNext=data.next;
    const rows=data.items.map(event=>`<div class="dev-event"><div><strong>${esc(statuses[event.state])} · invoice.paid</strong><small>${esc(event.id)}</small><small>Попыток: ${event.attempts}${event.lastError?' · '+esc(event.lastError):''}</small></div>${['failed','cancelled'].includes(event.state)?`<button class="text-action" data-retry="${esc(event.id)}">Повторить</button>`:''}</div>`).join('');
    if(append)q('#dev-events').insertAdjacentHTML('beforeend',rows);else q('#dev-events').innerHTML=rows||'<p class="muted">События появятся после оплаты счетов, созданных при настроенном webhook URL.</p>';
    q('#dev-events-more').hidden=!eventNext;
    q('#dev-events').querySelectorAll('[data-retry]').forEach(button=>button.onclick=wrap(async()=>{await client.request(base(id)+'/events/'+button.dataset.retry+'/retry',{method:'POST'});await loadEvents();}));
  }
  q('#dev-refresh-invoices').onclick=wrap(()=>loadInvoices());q('#dev-refresh-events').onclick=wrap(()=>loadEvents());q('#dev-invoices-more').onclick=wrap(()=>loadInvoices(true));q('#dev-events-more').onclick=wrap(()=>loadEvents(true));
  function invoiceId(){const match=/^#pay=([a-f0-9-]{36})$/.exec(location.hash);return match?.[1]||null;}
  async function loadCheckout(){
    const id=invoiceId();if(!id)return;checkout=null;q('#checkout-form').hidden=true;q('#checkout-result').textContent='';
    try{
      const invoice=await client.request('/api/invoices/'+id);if(invoiceId()!==id)return;checkout=invoice;
      q('#checkout-details').innerHTML=`<span class="badge">${esc(statuses[invoice.status])}</span><p class="checkout-merchant">${esc(invoice.appName)}</p><div class="checkout-amount">${esc(invoice.amount)} <small>USDT</small></div><p>${esc(invoice.description)}</p><p class="muted">Действует до ${esc(new Date(invoice.expiresAt).toLocaleString('ru-RU'))}</p><p class="muted">Счёт ${esc(invoice.id)}</p>`;
      const user=client.user();q('#checkout-auth').textContent=user?'Ваш внутренний баланс: '+user.balance+' USDT':'Для оплаты откройте FK Wallet через Telegram и перейдите к этому счёту. Вход обязателен.';
      if(invoice.status==='paid'){q('#checkout-result').textContent='Счёт оплачен.';return;}
      if(invoice.status==='active'&&user){q('#checkout-form').hidden=false;q('#checkout-pay').disabled=paying;q('#checkout-pay').textContent='Оплатить '+invoice.amount+' USDT';q('#checkout-consent').checked=false;}
    }catch(error){q('#checkout-details').textContent=error.message;}
  }
  q('#checkout-form').onsubmit=async event=>{
    event.preventDefault();if(!checkout||paying||!q('#checkout-consent').checked)return;
    const invoice=checkout;if(payPending?.id!==invoice.id)payPending={id:invoice.id,key:crypto.randomUUID()};paying=true;q('#checkout-pay').disabled=true;q('#checkout-result').textContent='Отправляем оплату…';
    try{
      await client.request('/api/invoices/'+invoice.id+'/pay',{method:'POST',headers:{'Idempotency-Key':payPending.key},body:JSON.stringify({amount:invoice.amount})});
      payPending=null;await client.refreshWallet();await loadCheckout();q('#checkout-result').textContent='Оплата прошла. Средства зачислены владельцу приложения.';
    }catch(error){q('#checkout-result').textContent=error.message+' Если соединение оборвалось, повторите оплату: повторного списания не будет.';}
    finally{paying=false;q('#checkout-pay').disabled=false;}
  };
  window.addEventListener('fk-session-ready',()=>{loadApps().catch(error=>q('#dev-error').textContent=error.message);loadCheckout();});
  window.addEventListener('fk-session-failed',event=>q('#dev-gate-text').textContent=event.detail);
  window.addEventListener('hashchange',loadCheckout);
  const startParam=window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if(/^pay_[a-f0-9-]{36}$/.test(startParam||'')&&!invoiceId())location.hash='pay='+startParam.slice(4);
  if(client?.user())loadApps().catch(error=>q('#dev-error').textContent=error.message);
  loadCheckout();
})();
