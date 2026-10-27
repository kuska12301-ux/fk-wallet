import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletStore } from './store.mjs';
import { CryptoPayService, CryptoPayError } from './crypto-pay.mjs';
import { MerchantService } from './merchant.mjs';

function fixture(t) {
  const store = new WalletStore(':memory:');
  store.register({id:'111',firstName:'One',username:'user_one'});
  store.register({id:'222',firstName:'Two',username:'user_two'});
  const invoices = [], transfers = [], calls = [];
  const client = { async call(method, body) {
    calls.push([method,body]);
    if (method === 'createInvoice') { const invoice = { ...body, invoice_id:invoices.length+1, status:'active', bot_invoice_url:'https://t.me/CryptoBot?start=fixture',fee_asset:'USDT',fee_amount:'0.3' }; invoices.push(invoice); return invoice; }
    if (method === 'getInvoices') return {items:invoices};
    if (method === 'getTransfers') return {items:transfers.filter(x=>x.spend_id===body.spend_id)};
    if (method === 'transfer') { const prior=transfers.find(x=>x.spend_id===body.spend_id);if(prior)return prior; const transfer={...body,transfer_id:transfers.length+1,status:'completed'};transfers.push(transfer);return transfer; }
    throw new Error('Unexpected method');
  }};
  const service=new CryptoPayService(store,{},client);
  t.after(async()=>{await service.stop();store.close();});
  const due=()=>store.db.exec('UPDATE crypto_jobs SET next_check=0');
  return {store,service,client,invoices,transfers,calls,due};
}
test('Crypto deposit credits verified USDT net of fee exactly once and preserves ledger guards',async t=>{
  const {store,service,invoices,due}=fixture(t),key=randomUUID();
  const first=await service.create('111','deposit',{amount:'10'},key);
  assert.equal(first.status,'active');assert.equal(store.user('111').balance,'0.000000');
  assert.equal((await service.create('111','deposit',{amount:'10.000000'},key)).id,first.id);
  assert.equal(invoices.length,1);
  await assert.rejects(()=>service.create('111','deposit',{amount:'11'},key),/другой суммы/);
  invoices[0].status='paid';await service.cycle();
  assert.equal(store.user('111').balance,'9.700000');
  due();await service.cycle();assert.equal(store.user('111').balance,'9.700000');
  assert.equal(service.list('111').items[0].creditedAmount,'9.700000');
  assert.equal(service.list('222').items.length,0);
  assert.throws(()=>store.db.exec('UPDATE entries SET amount=1'),/cannot be edited/);
  assert.throws(()=>store.db.exec('DELETE FROM entries'),/cannot be deleted/);
});
test('Crypto deposit rejects mismatched invoice data, bad asset and invalid fee',async t=>{
  const {store,service,invoices,due}=fixture(t);
  await service.create('111','deposit',{amount:'10'},randomUUID());
  invoices[0].status='paid';invoices[0].amount='100';await service.cycle();assert.equal(store.user('111').balance,'0.000000');
  invoices[0].amount='10';invoices[0].asset='TON';due();await service.cycle();assert.equal(store.user('111').balance,'0.000000');
  invoices[0].asset='USDT';invoices[0].fee_amount='20';due();await service.cycle();assert.equal(store.user('111').balance,'0.000000');
  invoices[0].fee_amount=3e-8;due();await service.cycle();assert.equal(store.user('111').balance,'9.999999');
});
test('Crypto withdrawal reserves atomically, pays own user once and rejects duplicate pending requests',async t=>{
  const {store,service,transfers}=fixture(t);
  store.adjust('111',{userId:'111',direction:'credit',amount:'20',reason:'Fixture'},randomUUID());
  const key=randomUUID(),job=await service.create('111','withdraw',{amount:'7'},key);
  assert.equal(store.user('111').balance,'13.000000');
  assert.equal((await service.create('111','withdraw',{amount:'7'},key)).id,job.id);
  await assert.rejects(()=>service.create('111','withdraw',{amount:'7'},randomUUID()),/предыдущего вывода/);
  await service.cycle();assert.equal(transfers.length,1);assert.equal(transfers[0].user_id,111);
  assert.equal(service.job(job.id).state,'completed');assert.equal(store.user('111').balance,'13.000000');
  await service.cycle();assert.equal(transfers.length,1);
  await assert.rejects(()=>service.create('111','withdraw',{amount:'14'},randomUUID()),/Недостаточно/);
});
test('Crypto definitively rejected withdrawal restores reserve once; ambiguous timeout never refunds',async t=>{
  const {store,service,client,due}=fixture(t);
  store.adjust('111',{userId:'111',direction:'credit',amount:'20',reason:'Fixture'},randomUUID());
  const original=client.call.bind(client);
  client.call=async(method,body)=>{if(method==='transfer')throw new CryptoPayError('NOT_ENOUGH_COINS');return original(method,body);};
  const rejected=await service.create('111','withdraw',{amount:'5'},randomUUID());await service.cycle();
  assert.equal(service.job(rejected.id).state,'failed');assert.equal(store.user('111').balance,'20.000000');
  due();await service.cycle();assert.equal(store.user('111').balance,'20.000000');
  client.call=async(method,body)=>{if(method==='transfer')throw new Error('timeout');return original(method,body);};
  const unknown=await service.create('111','withdraw',{amount:'5'},randomUUID());await service.cycle();
  assert.equal(store.user('111').balance,'15.000000');assert.equal(service.job(unknown.id).state,'pending');
  client.call=async(method,body)=>{if(method==='transfer')throw new CryptoPayError('DUPLICATE_SPEND_ID');return original(method,body);};
  due();await service.cycle();assert.equal(store.user('111').balance,'15.000000');assert.equal(service.job(unknown.id).state,'pending');
});
test('Crypto restart reconciles a successful transfer whose response was lost without paying again',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fk-crypto-')),path=join(directory,'wallet.sqlite');
  let store=new WalletStore(path);store.register({id:'111',firstName:'One',username:'user_one'});
  store.adjust('111',{userId:'111',direction:'credit',amount:'20',reason:'Fixture'},randomUUID());
  let transfer,sends=0;
  const client={async call(method,body){if(method==='getTransfers')return {items:transfer?[transfer]:[]};if(method==='transfer'){sends++;transfer={...body,transfer_id:1,status:'completed'};throw new Error('Lost response');}throw new Error('unexpected');}};
  let service=new CryptoPayService(store,{},client);
  const job=await service.create('111','withdraw',{amount:'5'},randomUUID());await service.cycle();await service.stop();store.close();
  store=new WalletStore(path);service=new CryptoPayService(store,{},client);store.db.exec('UPDATE crypto_jobs SET next_check=0');
  await service.cycle();assert.equal(service.job(job.id).state,'completed');assert.equal(store.user('111').balance,'15.000000');assert.equal(sends,1);
  await service.stop();store.close();rmSync(directory,{recursive:true,force:true});
});
test('Crypto invoice creation timeout recovers the provider invoice by durable payload',async t=>{
  const {store,service,client,invoices}=fixture(t),original=client.call.bind(client);
  client.call=async(method,body)=>{const result=await original(method,body);if(method==='createInvoice')throw new Error('Lost invoice response');return result;};
  const job=await service.create('111','deposit',{amount:'10'},randomUUID());assert.equal(job.status,'creating');
  invoices[0].status='paid';await service.cycle();assert.equal(service.job(job.id).state,'paid');assert.equal(store.user('111').balance,'9.700000');
});
test('Shop invoice paid from verified CryptoBot deposit credits merchant once and can fund merchant withdrawal',async t=>{
  const {store,service,invoices,transfers,due}=fixture(t);
  const merchant=new MerchantService(store,{origin:'https://wallet.example',botUsername:'fixture_bot',encryptionKey:Buffer.alloc(32,7)});
  const app=await merchant.createApp('222',{name:'Fixture shop',webhookUrl:null});
  const client=merchant.authenticate('Bearer '+app.apiKey);
  const deposit=await service.create('111','deposit',{amount:'10'},randomUUID());
  invoices[0].status='paid';await service.cycle();
  assert.equal(service.job(deposit.id).state,'paid');assert.equal(store.user('111').balance,'9.700000');
  const invoice=merchant.createInvoice(client,{amount:'8',payload:'order-123'},randomUUID());
  const key=randomUUID(),payment=merchant.payInvoice('111',invoice.id,{amount:'8'},key);
  assert.equal(merchant.findInvoice(invoice.id).status,'paid');
  merchant.payInvoice('111',invoice.id,{amount:'8'},key);
  assert.equal(store.user('111').balance,'1.700000');assert.equal(store.user('222').balance,'8.000000');
  assert.ok(payment);merchant.payInvoice('111',invoice.id,{amount:'8'},randomUUID());
  assert.equal(store.user('111').balance,'1.700000');assert.equal(store.user('222').balance,'8.000000');
  const payout=await service.create('222','withdraw',{amount:'8'},randomUUID());due();await service.cycle();
  assert.equal(service.job(payout.id).state,'completed');assert.equal(transfers.length,1);assert.equal(transfers[0].user_id,222);
  assert.equal(store.user('222').balance,'0.000000');assert.equal(store.user('111').balance,'1.700000');
});
