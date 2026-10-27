import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createWalletServer} from './app.mjs';
import {digest} from './auth.mjs';
import {signWebhook} from './webhooks.mjs';
import {createExampleShop} from '../examples/merchant-server.mjs';

test('Example merchant completes order only after signed webhook AND provider verification, once',async t=>{
  const config={botToken:'999999:'+'a'.repeat(35),adminIds:new Set(['111']),dbPath:':memory:',origin:'http://127.0.0.1',secure:false,authMaxAge:300,sessionTtl:3600,encryptionKey:randomBytes(32)};
  const {app,store,merchant,worker}=createWalletServer(config);await worker.stop();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));config.origin='http://127.0.0.1:'+app.address().port;
  store.register({id:'111',firstName:'Owner',username:'owner_111'});store.register({id:'222',firstName:'Buyer',username:'buyer_222'});
  store.adjust('111',{userId:'222',direction:'credit',amount:'10',reason:'Isolated example fixture'},randomUUID());
  const token=randomBytes(32).toString('hex'),csrf='a'.repeat(48);store.createSession(digest(token),'222',csrf,Math.floor(Date.now()/1000)+3600);
  const application=await merchant.createApp('111',{name:'Example shop'});
  const {app:shop,db}=createExampleShop({baseUrl:config.origin,apiKey:application.apiKey,webhookSecret:application.webhookSecret,appId:application.id,dbPath:':memory:'});
  await new Promise(resolve=>shop.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+shop.address().port;
  t.after(async()=>{await new Promise(resolve=>shop.close(resolve));await new Promise(resolve=>app.close(resolve));});
  const response=await fetch(origin+'/orders',{method:'POST'});assert.equal(response.status,200);const order=await response.json();assert.ok(order.invoiceId);assert.ok(order.paymentUrl);
  const repeated=await fetch(origin+'/orders/'+order.orderId+'/invoice',{method:'POST'});assert.equal((await repeated.json()).invoiceId,order.invoiceId);
  const eventId=randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
  const payload=()=>JSON.stringify({id:eventId,type:'invoice.paid',data:{invoice:{id:order.invoiceId,status:'paid',amount:'0.000001'}}});
  async function callback(raw=payload(),signature=null){return fetch(origin+'/fk-webhook',{method:'POST',headers:{'Content-Type':'application/json','FK-Event-Id':eventId,'FK-Timestamp':timestamp,'FK-Signature':signature||'sha256='+signWebhook(application.webhookSecret,timestamp,raw)},body:raw});}
  assert.equal((await callback(payload(),'sha256='+'0'.repeat(64))).status,401);
  assert.equal((await callback()).status,409);assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.orderId).status,'pending');
  const payment=await fetch(config.origin+'/api/invoices/'+order.invoiceId+'/pay',{method:'POST',headers:{Origin:config.origin,Authorization:'Bearer '+token,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({amount:'5.000000'})});assert.equal(payment.status,200);
  assert.equal((await callback()).status,200);const duplicate=await callback();assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
  const final=await fetch(origin+'/orders/'+order.orderId);assert.equal((await final.json()).status,'paid');assert.equal(db.prepare('SELECT count(*) n FROM received_events').get().n,1);assert.equal(store.user('222').balance,'5.000000');
});

test('Outbox recovers expired leases, exhausts attempts and supports explicit retry on new URL',async()=>{
  const config={encryptionKey:randomBytes(32),origin:'https://wallet.example.com'};
  const {WalletStore}=await import('./store.mjs');const {MerchantService}=await import('./merchant.mjs');const store=new WalletStore(':memory:'),service=new MerchantService(store,config);
  try{
    store.register({id:'111',firstName:'Owner',username:null});store.register({id:'222',firstName:'Buyer',username:null});store.adjust('111',{userId:'222',direction:'credit',amount:'3',reason:'Isolated fixture'},randomUUID());
    const app=await service.createApp('111',{name:'Outbox shop',webhookUrl:'https://8.8.8.8/hook'}),row=service.owned('111',app.id);
    const invoice=service.createInvoice(row,{amount:'1'},randomUUID());service.payInvoice('222',invoice.id,{amount:'1'},randomUUID());
    let now=Math.floor(Date.now()/1000),job=service.claimJob(now);assert.equal(job.attempts,1);assert.equal(service.claimJob(now),null);
    now+=61;job=service.claimJob(now);assert.equal(job.attempts,2);
    for(let n=2;n<=8;n++){
      assert.equal(job.attempts,n);service.finishJob(job.id,false,now,'HTTP 503');
      const event=service.events('111',app.id).items[0];if(n===8){assert.equal(event.state,'failed');break;}now=event.nextAttempt;job=service.claimJob(now);
    }
    const failed=service.events('111',app.id).items[0];assert.equal(service.claimJob(now+10000),null);
    await service.updateApp('111',app.id,{name:'Outbox shop',webhookUrl:'https://1.1.1.1/hook'});service.retryEvent('111',app.id,failed.id);
    const retried=store.db.prepare('SELECT * FROM webhook_jobs WHERE id=?').get(failed.id);assert.equal(retried.state,'pending');assert.equal(retried.attempts,0);assert.equal(retried.target_url,'https://1.1.1.1/hook');
    await service.updateApp('111',app.id,{name:'Outbox shop',webhookUrl:null});assert.equal(service.events('111',app.id).items[0].state,'cancelled');assert.throws(()=>service.retryEvent('111',app.id,failed.id),/настройте/);
    assert.equal(store.user('222').balance,'2.000000');assert.equal(store.user('111').balance,'1.000000');
  }finally{store.close();}
});

test('Upgrade migrates a populated v1 ledger without changing balances, history or guards',async()=>{
  const {WalletStore}=await import('./store.mjs');const {MerchantService}=await import('./merchant.mjs');
  const store=new WalletStore(':memory:');
  try{
    store.register({id:'111',firstName:'Admin',username:null});store.register({id:'222',firstName:'Buyer',username:null});
    const original=store.adjust('111',{userId:'222',direction:'credit',amount:'2.000001',reason:'Preserve existing v1 history'},randomUUID());
    assert.equal(store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='entries'").get().sql.includes('invoice_debit'),false);
    const service=new MerchantService(store,{encryptionKey:randomBytes(32),origin:'https://wallet.example.com'});
    assert.equal(store.user('222').balance,'2.000001');assert.equal(store.entries().items[0].operationId,original.operationId);
    const app=await service.createApp('111',{name:'Migrated shop'}),invoice=service.createInvoice(service.owned('111',app.id),{amount:'1'},randomUUID());
    service.payInvoice('222',invoice.id,{amount:'1'},randomUUID());
    assert.equal(store.user('222').balance,'1.000001');assert.equal(store.entries().items.length,3);assert.equal(store.entries().items[0].id,3);
    assert.throws(()=>store.db.exec('DELETE FROM entries'),/cannot be deleted/);
  }finally{store.close();}
});
