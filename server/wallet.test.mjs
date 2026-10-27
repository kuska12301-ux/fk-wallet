import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWalletServer } from './app.mjs';
import { validateTelegram, readConfig } from './auth.mjs';
import { WalletStore, parseAmount, formatAmount } from './store.mjs';

const token='999999:'+ 'a'.repeat(35);
function signed(id,extra={}) {
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'User '+id,username:'user_'+id}),...extra});
  const check=[...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  params.set('hash',createHmac('sha256',secret).update(check).digest('hex'));return params.toString();
}
test('Telegram HMAC validation rejects forged, expired, duplicate and future data',()=>{
  assert.equal(validateTelegram(signed(111),token).id,'111');
  assert.throws(()=>validateTelegram(signed(111).replace('user_111','admin_1'),token),/подпись/);
  assert.throws(()=>validateTelegram(signed(111,{auth_date:'1'}),token),/устарела/);
  assert.throws(()=>validateTelegram(signed(111)+'&auth_date=1',token),/Повторяющиеся/);
  assert.throws(()=>validateTelegram(signed(111,{auth_date:String(Math.floor(Date.now()/1000)+1000)}),token),/устарела/);
  assert.throws(()=>readConfig({BOT_TOKEN:token,ADMIN_TELEGRAM_IDS:'@admin',PUBLIC_URL:'https://example.com'}),/ADMIN/);
  assert.throws(()=>readConfig({BOT_TOKEN:token,ADMIN_TELEGRAM_IDS:'111',PUBLIC_URL:'http://example.com',NODE_ENV:'production'}),/HTTPS/);
});
test('Amounts remain exact and reject floats, negatives, scientific notation and excessive precision',()=>{
  assert.equal(parseAmount('0.000001'),1);assert.equal(parseAmount('10.123456'),10123456);assert.equal(formatAmount(-1000001),'-1.000001');
  for(const bad of [0,10,'0','-1','1e3','1.0000001','01','1000001','Infinity'])assert.throws(()=>parseAmount(bad));
});
test('Admin access, atomic balance changes, idempotency, audit, user isolation and persistence',async t=>{
  const temp=mkdtempSync(join(tmpdir(),'fk-wallet-test-'));
  const config={botToken:token,adminIds:new Set(['111']),dbPath:join(temp,'test.sqlite'),origin:'http://127.0.0.1',secure:false,authMaxAge:300,sessionTtl:3600};
  const {app,store}=createWalletServer(config);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));config.origin='http://127.0.0.1:'+app.address().port;
  t.after(async()=>{if(app.listening)await new Promise(resolve=>app.close(resolve));rmSync(temp,{recursive:true,force:true});});
  async function request(path,actor=null,{method='GET',body,headers={}}={}){
    const response=await fetch(config.origin+path,{method,headers:{Origin:config.origin,...(body?{'Content-Type':'application/json'}:{}),...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();return {status:response.status,data,headers:response.headers};
  }
  async function login(id){const r=await request('/api/auth/telegram',null,{method:'POST',body:{initData:signed(id)}});assert.equal(r.status,200);return {...r.data,cookie:r.headers.get('set-cookie').split(';')[0]};}
  assert.equal((await request('/api/admin/operations')).status,401);
  assert.equal((await request('/api/auth/telegram',null,{method:'POST',body:{initData:'user={"id":111}'}})).status,401);
  const admin=await login(111),user=await login(222),other=await login(333);
  assert.equal((await request('/api/me',null,{headers:{Authorization:'Bearer '+admin.sessionToken}})).data.isAdmin,true);
  assert.equal(admin.isAdmin,true);assert.equal(user.isAdmin,false);
  assert.equal((await request('/api/admin/summary',user)).status,403);
  const key=randomUUID();const body={userId:'222',direction:'credit',amount:'10.123456',reason:'Внесение по подтверждению'};
  const adjust=(actor,b=body,k=key,headers={})=>request('/api/admin/adjustments',actor,{method:'POST',body:b,headers:{'Idempotency-Key':k,...headers}});
  assert.equal((await adjust(user)).status,403);
  assert.equal((await adjust(admin,body,key,{'X-CSRF-Token':'x'.repeat(48)})).status,403);
  assert.equal((await adjust(admin,body,key,{Origin:'https://evil.example'})).status,403);
  const results=await Promise.all([adjust(admin),adjust(admin)]);assert.ok(results.every(r=>r.status===200));assert.equal(results.filter(r=>r.data.replayed).length,1);
  assert.equal((await request('/api/me',user)).data.user.balance,'10.123456');
  assert.equal((await adjust(admin,{...body,amount:'9'},key)).status,409);
  assert.equal((await adjust(admin,{...body,direction:'debit',amount:'11'},randomUUID())).status,409);
  assert.equal((await request('/api/admin/summary',admin)).data.operations,1);
  assert.equal((await adjust(admin,{...body,direction:'debit',amount:'0.123456',reason:'Корректировка'},randomUUID())).status,200);
  assert.equal((await request('/api/me',user)).data.user.balance,'10.000000');
  assert.equal((await request('/api/transactions?userId=222',other)).data.items.length,0);
  const entries=(await request('/api/admin/operations?userId=222',admin)).data.items;
  assert.equal(entries.length,2);assert.equal(entries[0].actorId,'111');assert.equal(entries[0].balanceAfter,'10.000000');assert.equal(entries[0].reason,'Корректировка');
  assert.throws(()=>store.db.exec('DELETE FROM entries'),/cannot be deleted/);
  assert.throws(()=>store.db.exec("UPDATE entries SET reason='changed'"),/cannot be edited/);
  assert.equal((await adjust(admin,{...body,userId:'999'},randomUUID())).status,404);
  assert.equal((await request('/api/admin/users?search=222',admin)).data.items.length,1);
  assert.equal((await request('/api/admin/operations?before=invalid',admin)).status,400);
  const source=await fetch(config.origin+'/.env');assert.equal(source.status,404);
  // Verify pagination covers every entry, without duplicates or skipped rows.
  for(let i=0;i<52;i++)assert.equal((await adjust(admin,{...body,amount:'0.000001'},randomUUID())).status,200);
  const page1=(await request('/api/admin/operations',admin)).data;assert.equal(page1.items.length,50);assert.ok(page1.next);
  const page2=(await request('/api/admin/operations?before='+page1.next,admin)).data;assert.equal(page2.items.length,4);assert.equal(page2.next,null);
  assert.equal(new Set([...page1.items,...page2.items].map(e=>e.id)).size,54);
  await new Promise(resolve=>app.close(resolve));
  const reopened=new WalletStore(config.dbPath);assert.equal(reopened.user('222').balance,'10.000052');assert.equal(reopened.summary().operations,54);reopened.close();
});
