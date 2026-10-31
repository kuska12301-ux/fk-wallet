import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createWalletServer} from './app.mjs';
import {WalletStore} from './store.mjs';
import {MerchantService} from './merchant.mjs';
import {WebhookWorker,publicAddress,webhookUrl,deliverWebhook,verifyWebhook,decryptSecret} from './webhooks.mjs';
import {FKPay,verifyFKWebhook} from '../sdk/fk-pay.mjs';

const botToken='999999:'+'b'.repeat(35);
function signed(id){const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'User '+id,username:'user_'+id})});const secret=createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',createHmac('sha256',secret).update([...p.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return p.toString();}

test('Webhook targets reject internal, mapped, metadata, special and non-HTTPS addresses',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  for(const url of ['http://example.com','https://localhost/hook','https://127.1/hook','https://2130706433/hook','https://[::ffff:127.0.0.1]/','https://a:b@example.com/','https://example.com:444/'])assert.throws(()=>webhookUrl(url));
});
test('Webhook HTTP delivery pins validated DNS addresses and does not follow redirects',async()=>{
  let calls=0,status=302;
  const stub=mock.method(https,'request',(url,options,callback)=>{
    calls++;assert.equal(url.hostname,'8.8.8.8');assert.equal(options.method,'POST');assert.equal(options.agent,false);
    options.lookup('8.8.8.8',{all:true},(error,addresses)=>{assert.equal(error,null);assert.equal(addresses[0].address,'8.8.8.8');});
    const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={location:'http://127.0.0.1/internal'};callback(res);res.emit('end');req.emit('close');});req.destroy=error=>{req.emit('error',error);req.emit('close');};return req;
  });
  try{await assert.rejects(deliverWebhook('https://8.8.8.8/hook','{}',{}),/HTTP 302/);assert.equal(calls,1);status=204;await deliverWebhook('https://8.8.8.8/hook','{}',{});assert.equal(calls,2);}finally{stub.mock.restore();}
});
test('Merchant API, payment ledger, key isolation, durable outbox and retry signatures',async t=>{
  const temp=mkdtempSync(join(tmpdir(),'fk-pay-test-'));
  const config={botToken,adminIds:new Set(['111']),dbPath:join(temp,'wallet.sqlite'),origin:'http://127.0.0.1',secure:false,authMaxAge:300,sessionTtl:3600,encryptionKey:randomBytes(32),botUsername:'fk_test_bot'};
  const {app,store,merchant,worker}=createWalletServer(config);await worker.stop();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));config.origin='http://127.0.0.1:'+app.address().port;
  t.after(async()=>{if(app.listening)await new Promise(resolve=>app.close(resolve));rmSync(temp,{recursive:true,force:true});});
  async function request(path,actor=null,{method='GET',body,key,apiKey,headers={}}={}){
    const r=await fetch(config.origin+path,{method,headers:{...(actor?{Origin:config.origin,Authorization:'Bearer '+actor.sessionToken,'X-CSRF-Token':actor.csrf}:{}),...(apiKey?{Authorization:'Bearer '+apiKey}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};
  }
  async function login(id){const r=await request('/api/auth/telegram',null,{method:'POST',headers:{Origin:config.origin},body:{initData:signed(id)}});assert.equal(r.status,200);return r.data;}
  const owner=await login(111),payer=await login(222),other=await login(333),payer2=await login(444);
  for(const userId of ['222','444'])assert.equal((await request('/api/admin/adjustments',owner,{method:'POST',key:randomUUID(),body:{userId,direction:'credit',amount:'20',reason:'Fixture funds in temporary test DB'}})).status,200);
  const created=await request('/api/developer/apps',owner,{method:'POST',body:{name:'Shop',webhookUrl:'https://8.8.8.8/hook'}});assert.equal(created.status,201);
  const shop=created.data;assert.match(shop.apiKey,/^fkw_/);assert.match(shop.webhookSecret,/^fkw_wh_/);
  const stored=store.db.prepare('SELECT * FROM merchant_apps WHERE id=?').get(shop.id);assert.notEqual(stored.token_hash,shop.apiKey);assert.ok(!stored.webhook_secret.includes(shop.webhookSecret));assert.equal(decryptSecret(stored.webhook_secret,config.encryptionKey),shop.webhookSecret);
  const list=await request('/api/developer/apps',owner);assert.equal(list.data.items.length,1);assert.equal(JSON.stringify(list).includes(shop.apiKey),false);assert.equal(JSON.stringify(list).includes(shop.webhookSecret),false);
  assert.equal((await request('/api/developer/apps/'+shop.id+'/rotate-key',other,{method:'POST'})).status,404);
  const shop2=(await request('/api/developer/apps',other,{method:'POST',body:{name:'Other shop'}})).data;
  const sdk=new FKPay({baseUrl:config.origin,apiKey:shop.apiKey});const key=randomUUID(),body={amount:'7.123456',payload:'order-123',description:'Order №123'};
  const first=await sdk.createInvoice(body,key),again=await sdk.createInvoice(body,key);assert.equal(first.id,again.id);assert.ok(first.telegramUrl.includes('startapp=pay_'));assert.equal(first.status,'active');
  await assert.rejects(sdk.createInvoice({...body,amount:'8'},key),error=>error.status===409);
  assert.equal((await request('/v1/invoices/'+first.id,null,{apiKey:shop2.apiKey})).status,404);
  assert.equal((await request('/v1/invoices/'+first.id,null,{apiKey:'fkw_'+'a'.repeat(64)})).status,401);
  const publicInvoice=(await request('/api/invoices/'+first.id)).data;assert.equal(publicInvoice.payload,undefined);assert.equal(publicInvoice.payerId,undefined);assert.equal(publicInvoice.amount,'7.123456');
  const payKey=randomUUID(),pay=actor=>request('/api/invoices/'+first.id+'/pay',actor,{method:'POST',key:payKey,body:{amount:first.amount}});
  assert.equal((await pay(null)).status,403);assert.equal((await pay(owner)).status,409);
  const concurrent=await Promise.all([pay(payer),pay(payer)]);assert.ok(concurrent.every(r=>r.status===200));assert.equal(concurrent.filter(r=>r.data.replayed).length,1);
  assert.equal(store.user('222').balance,'12.876544');assert.equal(store.user('111').balance,'7.123456');assert.equal(store.summary().totalBalance,'40.000000');
  assert.equal((await pay(payer2)).status,409);assert.equal((await request('/api/invoices/'+first.id+'/pay',payer,{method:'POST',key:randomUUID(),body:{amount:first.amount}})).data.replayed,true);
  const paid=await sdk.getInvoice(first.id);assert.equal(paid.status,'paid');assert.equal(paid.payerId,'222');assert.equal(paid.payload,'order-123');assert.equal((await sdk.getBalance()).available,'7.123456');
  const pair=store.db.prepare('SELECT * FROM entries WHERE operation_id=? ORDER BY amount').all(paid.operationId);assert.equal(pair.length,2);assert.equal(pair[0].amount+pair[1].amount,0);assert.ok(pair.every(e=>e.actor_id==='222'));
  const payoutKey=randomUUID(),payoutBody={recipient:'@user_222',amount:'2.000001',description:'Cashback',payload:'reward-123'};
  const payout=await sdk.createPayout(payoutBody,payoutKey),payoutReplay=await sdk.createPayout(payoutBody,payoutKey);
  assert.equal(payout.id,payoutReplay.id);assert.equal(payout.status,'completed');assert.equal(payout.recipient.username,'user_222');assert.equal((await sdk.getPayout(payout.id)).operationId,payout.operationId);
  assert.equal((await sdk.listPayouts()).items.length,1);assert.equal(store.user('111').balance,'5.123455');assert.equal(store.user('222').balance,'14.876545');assert.equal(store.summary().totalBalance,'40.000000');
  await assert.rejects(sdk.createPayout({...payoutBody,amount:'3'},payoutKey),error=>error.status===409);
  assert.equal((await request('/v1/payouts/'+payout.id,null,{apiKey:shop2.apiKey})).status,404);
  const payoutPair=store.db.prepare('SELECT * FROM entries WHERE operation_id=? ORDER BY amount').all(payout.operationId);assert.deepEqual(payoutPair.map(e=>e.kind),['payout_debit','payout_credit']);assert.equal(payoutPair[0].amount+payoutPair[1].amount,0);
  await assert.rejects(sdk.createPayout({recipient:'@missing_user',amount:'1'},randomUUID()),error=>error.status===404);
  await assert.rejects(sdk.createPayout({recipient:'@user_222',amount:'99'},randomUUID()),error=>error.status===409);
  await assert.rejects(sdk.cancelInvoice(first.id),error=>error.status===409);
  assert.throws(()=>store.db.prepare("UPDATE invoices SET status='active' WHERE id=?").run(first.id),/cannot be edited/);
  const cancelled=await sdk.createInvoice({amount:'1'},randomUUID());await sdk.cancelInvoice(cancelled.id);assert.equal((await request('/api/invoices/'+cancelled.id+'/pay',payer,{method:'POST',key:randomUUID(),body:{amount:'1'}})).status,409);
  const tooMuch=await sdk.createInvoice({amount:'99'},randomUUID());assert.equal((await request('/api/invoices/'+tooMuch.id+'/pay',payer,{method:'POST',key:randomUUID(),body:{amount:'99'}})).status,409);
  const expired=await sdk.createInvoice({amount:'1',expiresIn:60},randomUUID());const dateNow=Date.now;try{Date.now=()=>dateNow()+61000;assert.equal(merchant.invoice(merchant.findInvoice(expired.id)).status,'expired');assert.throws(()=>merchant.payInvoice('222',expired.id,{amount:'1'},randomUUID()),/истёк/);}finally{Date.now=dateNow;}
  const rotation=await request('/api/developer/apps/'+shop.id+'/rotate-key',owner,{method:'POST'});assert.equal(rotation.status,200);await assert.rejects(sdk.getBalance(),error=>error.status===401);sdk.apiKey=rotation.data.apiKey;assert.equal((await sdk.getInvoice(first.id)).status,'paid');
  assert.equal((await request('/api/developer/apps/'+shop.id+'/revoke-key',owner,{method:'POST'})).status,200);await assert.rejects(sdk.getBalance(),error=>error.status===401);
  let events=(await request('/api/developer/apps/'+shop.id+'/events',owner)).data;assert.equal(events.items.length,1);assert.equal(events.items[0].state,'pending');
  assert.equal((await request('/api/developer/apps/'+shop.id+'/events',other)).status,404);
  // Restart against the same database before delivering the transactional outbox.
  await new Promise(resolve=>app.close(resolve));await new Promise(resolve=>setImmediate(resolve));
  const durable=new WalletStore(config.dbPath),service=new MerchantService(durable,config);assert.equal(service.invoice(service.findInvoice(first.id)).status,'paid');
  let clock=Math.floor(Date.now()/1000),attempt=0,eventId,raw;
  const sender=new WebhookWorker(service,{clock:()=>clock,deliver:async(target,body,headers)=>{
    assert.equal(target,'https://8.8.8.8/hook');assert.equal(verifyWebhook(shop.webhookSecret,headers['FK-Timestamp'],body,headers['FK-Signature'],clock),true);
    assert.equal(verifyFKWebhook({secret:shop.webhookSecret,timestamp:headers['FK-Timestamp'],signature:headers['FK-Signature'],rawBody:Buffer.from(body),now:clock}),true);
    assert.equal(verifyFKWebhook({secret:shop.webhookSecret,timestamp:headers['FK-Timestamp'],signature:headers['FK-Signature'],rawBody:Buffer.from(body+'x'),now:clock}),false);
    assert.equal(verifyWebhook(shop.webhookSecret,headers['FK-Timestamp'],body,headers['FK-Signature'],clock+301),false);
    if(eventId)assert.equal(headers['FK-Event-Id'],eventId);eventId=headers['FK-Event-Id'];raw=body;attempt++;if(attempt===1)throw new Error('HTTP 503');
  }});
  await sender.tick();let event=service.events('111',shop.id).items[0];assert.equal(event.state,'pending');assert.equal(event.attempts,1);assert.equal(event.nextAttempt,clock+30);
  await sender.tick();assert.equal(attempt,1);clock+=30;await sender.tick();event=service.events('111',shop.id).items[0];assert.equal(event.state,'delivered');assert.equal(event.attempts,2);assert.equal(JSON.parse(raw).data.invoice.payload,'order-123');assert.equal(JSON.parse(raw).id,eventId);
  assert.throws(()=>service.retryEvent('111',shop.id,eventId),/доставлено/);
  assert.equal(service.listInvoices(shop.id).items.length,4);
  const wrongKey=new WalletStore(config.dbPath);assert.throws(()=>new MerchantService(wrongKey,{...config,encryptionKey:randomBytes(32)}),/APP_ENCRYPTION_KEY/);wrongKey.close();
  await sender.stop();durable.close();
});
