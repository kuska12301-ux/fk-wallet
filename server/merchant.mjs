import {randomBytes,randomUUID} from 'node:crypto';
import {HttpError,digest} from './auth.mjs';
import {parseAmount,formatAmount} from './store.mjs';
import {encryptSecret,decryptSecret,validateWebhookTarget} from './webhooks.mjs';

const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||'');
export class MerchantService {
  constructor(store,config){
    this.store=store;this.db=store.db;this.config=config;
    this.migrate();
    const existing=this.db.prepare('SELECT webhook_secret FROM merchant_apps LIMIT 1').get();
    if(existing&&config.encryptionKey){try{decryptSecret(existing.webhook_secret,config.encryptionKey);}catch{throw new Error('APP_ENCRYPTION_KEY не соответствует существующей базе. Восстановите прежний ключ.');}}
  }
  migrate(){
    const sql=this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='entries'").get().sql;
    if(!sql.includes('invoice_debit')||!sql.includes('payout_debit'))this.store.transaction(()=>{
      this.db.exec(`DROP TRIGGER IF EXISTS entries_no_update; DROP TRIGGER IF EXISTS entries_no_delete;
      ALTER TABLE entries RENAME TO entries_legacy;
      CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id), user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('admin_credit','admin_debit','invoice_credit','invoice_debit','payout_credit','payout_debit','crypto_deposit','crypto_withdraw','crypto_refund')), amount INTEGER NOT NULL CHECK(amount!=0), balance_after INTEGER NOT NULL CHECK(balance_after>=0), reason TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      INSERT INTO entries SELECT * FROM entries_legacy; DROP TABLE entries_legacy;
      CREATE INDEX entry_user ON entries(user_id,id DESC);
      CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be edited'); END;
      CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be deleted'); END;`);
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS merchant_apps(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT UNIQUE,token_prefix TEXT NOT NULL,webhook_url TEXT,webhook_secret TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS invoices(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,app_id TEXT NOT NULL REFERENCES merchant_apps(id),amount INTEGER NOT NULL CHECK(amount>0),description TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paid','cancelled')),expires_at INTEGER NOT NULL,paid_by TEXT REFERENCES users(id),paid_at TEXT,operation_id TEXT REFERENCES operations(id),created_at TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,UNIQUE(app_id,request_key)) STRICT;
    CREATE INDEX IF NOT EXISTS invoice_app ON invoices(app_id,seq DESC);
    CREATE TABLE IF NOT EXISTS payouts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,app_id TEXT NOT NULL REFERENCES merchant_apps(id),recipient_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL CHECK(amount>0),description TEXT NOT NULL,payload TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL REFERENCES operations(id),created_at TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,UNIQUE(app_id,request_key)) STRICT;
    CREATE INDEX IF NOT EXISTS payout_app ON payouts(app_id,seq DESC);
    CREATE TABLE IF NOT EXISTS webhook_jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,app_id TEXT NOT NULL REFERENCES merchant_apps(id),invoice_id TEXT NOT NULL REFERENCES invoices(id),target_url TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','failed','cancelled')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,delivered_at TEXT,UNIQUE(invoice_id)) STRICT;
    CREATE INDEX IF NOT EXISTS webhook_due ON webhook_jobs(state,next_attempt);
    CREATE TRIGGER IF NOT EXISTS invoices_fixed BEFORE UPDATE OF app_id,amount,description,payload,expires_at,created_at,request_key,request_hash ON invoices BEGIN SELECT RAISE(ABORT,'Invoice terms cannot be edited'); END;
    CREATE TRIGGER IF NOT EXISTS invoices_paid_fixed BEFORE UPDATE ON invoices WHEN OLD.status='paid' BEGIN SELECT RAISE(ABORT,'Paid invoices cannot be edited'); END;
    CREATE TRIGGER IF NOT EXISTS invoices_no_delete BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT,'Invoices cannot be deleted'); END;`);
  }
  ready(){if(!this.config.encryptionKey)throw new HttpError(503,'Настройте APP_ENCRYPTION_KEY на сервере для включения FK Pay.');}
  publicApp(row){return {id:row.id,name:row.name,webhookUrl:row.webhook_url,keyPrefix:row.token_prefix,keyActive:!!row.token_hash,createdAt:row.created_at};}
  owned(owner,id){const row=this.db.prepare('SELECT * FROM merchant_apps WHERE id=? AND owner_id=?').get(id,owner);if(!row)throw new HttpError(404,'Приложение не найдено.');return row;}
  listApps(owner){return {configured:!!this.config.encryptionKey,items:this.db.prepare('SELECT * FROM merchant_apps WHERE owner_id=? ORDER BY created_at DESC,id').all(owner).map(row=>this.publicApp(row))};}
  name(value){if(typeof value!=='string'||value.trim().length<2||value.trim().length>60)throw new HttpError(400,'Название приложения: 2–60 символов.');return value.trim();}
  async createApp(owner,body){
    this.ready();const name=this.name(body.name),target=await validateWebhookTarget(body.webhookUrl||null);
    return this.store.transaction(()=>{
      if(this.db.prepare('SELECT count(*) n FROM merchant_apps WHERE owner_id=?').get(owner).n>=10)throw new HttpError(409,'Можно создать до 10 приложений.');
      const id=randomUUID(),apiKey='fkw_'+randomBytes(32).toString('hex'),secret='fkw_wh_'+randomBytes(32).toString('hex');
      this.db.prepare('INSERT INTO merchant_apps VALUES(?,?,?,?,?,?,?,?)').run(id,owner,name,digest(apiKey),apiKey.slice(0,12),target?.url||null,encryptSecret(secret,this.config.encryptionKey),new Date().toISOString());
      return {...this.publicApp(this.owned(owner,id)),apiKey,webhookSecret:secret};
    });
  }
  async updateApp(owner,id,body){
    this.ready();this.owned(owner,id);const name=this.name(body.name),target=await validateWebhookTarget(body.webhookUrl||null);
    return this.store.transaction(()=>{
      const app=this.owned(owner,id),url=target?.url||null;
      if(app.webhook_url!==url)this.db.prepare("UPDATE webhook_jobs SET state='cancelled',last_error='Webhook URL changed' WHERE app_id=? AND state IN ('pending','delivering')").run(id);
      this.db.prepare('UPDATE merchant_apps SET name=?,webhook_url=? WHERE id=? AND owner_id=?').run(name,url,id,owner);
      return this.publicApp(this.owned(owner,id));
    });
  }
  rotateKey(owner,id){this.ready();this.owned(owner,id);const token='fkw_'+randomBytes(32).toString('hex');this.db.prepare('UPDATE merchant_apps SET token_hash=?,token_prefix=? WHERE id=?').run(digest(token),token.slice(0,12),id);return {apiKey:token};}
  revokeKey(owner,id){this.owned(owner,id);this.db.prepare('UPDATE merchant_apps SET token_hash=NULL WHERE id=?').run(id);return {ok:true};}
  authenticate(authorization){
    this.ready();const token=/^Bearer (fkw_[a-f0-9]{64})$/.exec(authorization||'')?.[1];
    const app=token?this.db.prepare('SELECT * FROM merchant_apps WHERE token_hash=?').get(digest(token)):null;
    if(!app)throw new HttpError(401,'Недействительный или отозванный API-ключ.');return app;
  }
  invoice(row,privateFields=true){
    if(!row)return null;
    const status=row.status==='active'&&row.expires_at<=Math.floor(Date.now()/1000)?'expired':row.status;
    const paymentUrl=this.config.origin+'/#pay='+row.id;
    const telegramUrl=this.config.botUsername?'https://t.me/'+this.config.botUsername+'?startapp=pay_'+row.id:null;
    const value={id:row.id,appId:row.app_id,appName:row.app_name,asset:'USDT',amount:formatAmount(row.amount),description:row.description,status,expiresAt:new Date(row.expires_at*1000).toISOString(),createdAt:row.created_at,paidAt:row.paid_at,paymentUrl,telegramUrl};
    if(privateFields)Object.assign(value,{payload:row.payload,payerId:row.paid_by,operationId:row.operation_id});
    return value;
  }
  findInvoice(id,appId=null){
    if(!uuid(id))throw new HttpError(404,'Счёт не найден.');
    const row=this.db.prepare('SELECT i.*,a.name app_name,a.owner_id,a.webhook_url,a.webhook_secret FROM invoices i JOIN merchant_apps a ON a.id=i.app_id WHERE i.id=? AND (? IS NULL OR i.app_id=?)').get(id,appId,appId);
    if(!row)throw new HttpError(404,'Счёт не найден.');return row;
  }
  createInvoice(app,body,key){
    this.ready();if(!uuid(key))throw new HttpError(400,'Требуется UUID в Idempotency-Key.');
    if(body.asset!==undefined&&body.asset!=='USDT')throw new HttpError(400,'Поддерживается только USDT.');
    const amount=parseAmount(body.amount),description=body.description??'',payload=body.payload??'',ttl=body.expiresIn??3600;
    if(typeof description!=='string'||description.length>200||typeof payload!=='string'||Buffer.byteLength(payload)>2048)throw new HttpError(400,'Описание до 200 символов, payload — строка до 2048 байт.');
    if(!Number.isInteger(ttl)||ttl<60||ttl>86400)throw new HttpError(400,'expiresIn: от 60 до 86400 секунд.');
    const fingerprint=digest(JSON.stringify([amount,description,payload,ttl]));
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT id,request_hash FROM invoices WHERE app_id=? AND request_key=?').get(app.id,key);
      if(prior){if(prior.request_hash!==fingerprint)throw new HttpError(409,'Ключ использован для другого счёта.');return this.invoice(this.findInvoice(prior.id,app.id));}
      const id=randomUUID();this.db.prepare("INSERT INTO invoices(id,app_id,amount,description,payload,status,expires_at,created_at,request_key,request_hash) VALUES(?,?,?,?,?,'active',?,?,?,?)").run(id,app.id,amount,description,payload,Math.floor(Date.now()/1000)+ttl,new Date().toISOString(),key,fingerprint);
      return this.invoice(this.findInvoice(id,app.id));
    });
  }
  listInvoices(appId,{before=Number.MAX_SAFE_INTEGER,status=null}={}){
    if(status&&!['active','paid','cancelled','expired'].includes(status))throw new HttpError(400,'Некорректный статус.');
    const now=Math.floor(Date.now()/1000);
    const rows=this.db.prepare("SELECT i.*,a.name app_name FROM invoices i JOIN merchant_apps a ON a.id=i.app_id WHERE i.app_id=? AND i.seq<? AND (? IS NULL OR CASE WHEN i.status='active' AND i.expires_at<=? THEN 'expired' ELSE i.status END=?) ORDER BY i.seq DESC LIMIT 51").all(appId,before,status,now,status);
    return {items:rows.slice(0,50).map(row=>this.invoice(row)),next:rows.length>50?rows[49].seq:null};
  }
  cancelInvoice(app,id){return this.store.transaction(()=>{const row=this.findInvoice(id,app.id);if(row.status==='paid')throw new HttpError(409,'Оплаченный счёт нельзя отменить.');if(row.status==='active')this.db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(id);return this.invoice(this.findInvoice(id,app.id));});}
  payout(row){return {id:row.id,appId:row.app_id,appName:row.app_name,asset:'USDT',amount:formatAmount(row.amount),recipient:{username:row.recipient_username},description:row.description,payload:row.payload,status:'completed',operationId:row.operation_id,createdAt:row.created_at};}
  findPayout(id,appId=null){
    if(!uuid(id))throw new HttpError(404,'Выплата не найдена.');
    const row=this.db.prepare('SELECT p.*,a.name app_name,u.username recipient_username FROM payouts p JOIN merchant_apps a ON a.id=p.app_id JOIN users u ON u.id=p.recipient_id WHERE p.id=? AND (? IS NULL OR p.app_id=?)').get(id,appId,appId);
    if(!row)throw new HttpError(404,'Выплата не найдена.');return row;
  }
  createPayout(app,body,key){
    this.ready();if(!uuid(key))throw new HttpError(400,'Требуется UUID в Idempotency-Key.');
    const amount=parseAmount(body.amount),raw=typeof body.recipient==='string'?body.recipient.trim().replace(/^@/,''):'';
    if(!/^[A-Za-z0-9_]{5,32}$/.test(raw))throw new HttpError(400,'Укажите Telegram @username получателя.');
    const description=body.description??'',payload=body.payload??'';
    if(typeof description!=='string'||description.length>200||typeof payload!=='string'||Buffer.byteLength(payload)>2048)throw new HttpError(400,'Описание до 200 символов, payload — строка до 2048 байт.');
    const recipient=this.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(raw);
    if(!recipient)throw new HttpError(404,'Пользователь не найден. Он должен сначала открыть FK Wallet через Telegram.');
    if(recipient.id===app.owner_id)throw new HttpError(409,'Нельзя отправить выплату владельцу этого магазина.');
    const fingerprint=digest(JSON.stringify([recipient.id,amount,description,payload]));
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT id,request_hash FROM payouts WHERE app_id=? AND request_key=?').get(app.id,key);
      if(prior){if(prior.request_hash!==fingerprint)throw new HttpError(409,'Ключ использован для другой выплаты.');return this.payout(this.findPayout(prior.id,app.id));}
      const sender=this.db.prepare('SELECT balance FROM users WHERE id=?').get(app.owner_id),receiver=this.db.prepare('SELECT balance FROM users WHERE id=?').get(recipient.id);
      if(sender.balance<amount)throw new HttpError(409,'Недостаточно средств на балансе магазина.');
      if(receiver.balance+amount>100000000000000)throw new HttpError(409,'Превышен лимит баланса получателя.');
      const id=randomUUID(),operation=randomUUID(),createdAt=new Date().toISOString(),operationKey='payout:'+app.id+':'+key;
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(operation,app.owner_id,operationKey,fingerprint,createdAt);
      this.db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(amount,app.owner_id);
      this.db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amount,recipient.id);
      const entry=this.db.prepare('INSERT INTO entries(operation_id,user_id,actor_id,kind,amount,balance_after,reason,created_at) VALUES(?,?,?,?,?,?,?,?)');
      entry.run(operation,app.owner_id,app.owner_id,'payout_debit',-amount,sender.balance-amount,'Выплата магазина '+app.name+' пользователю @'+recipient.username,createdAt);
      entry.run(operation,recipient.id,app.owner_id,'payout_credit',amount,receiver.balance+amount,'Выплата от магазина '+app.name,createdAt);
      this.db.prepare('INSERT INTO payouts(id,app_id,recipient_id,amount,description,payload,operation_id,created_at,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,app.id,recipient.id,amount,description,payload,operation,createdAt,key,fingerprint);
      return this.payout(this.findPayout(id,app.id));
    });
  }
  listPayouts(appId,{before=Number.MAX_SAFE_INTEGER}={}){const rows=this.db.prepare('SELECT p.*,a.name app_name,u.username recipient_username FROM payouts p JOIN merchant_apps a ON a.id=p.app_id JOIN users u ON u.id=p.recipient_id WHERE p.app_id=? AND p.seq<? ORDER BY p.seq DESC LIMIT 51').all(appId,before);return {items:rows.slice(0,50).map(row=>this.payout(row)),next:rows.length>50?rows[49].seq:null};}
  payInvoice(payer,id,body,key){
    this.ready();if(!uuid(key))throw new HttpError(400,'Требуется UUID в Idempotency-Key.');const expected=parseAmount(body.amount);
    const hash=digest(JSON.stringify(['invoice_payment',id,expected]));
    return this.store.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM operations WHERE actor_id=? AND request_key=?').get(payer,key),row=this.findInvoice(id);
      if(prior){if(prior.request_hash!==hash)throw new HttpError(409,'Ключ уже использован для другой операции.');return {invoice:this.invoice(row,false),replayed:true};}
      if(row.status==='paid'){if(row.paid_by===payer)return {invoice:this.invoice(row,false),replayed:true};throw new HttpError(409,'Счёт уже оплачен.');}
      if(this.invoice(row).status!=='active')throw new HttpError(409,'Счёт отменён или истёк.');
      if(row.owner_id===payer)throw new HttpError(409,'Нельзя оплатить счёт собственного приложения.');
      if(row.amount!==expected)throw new HttpError(409,'Сумма счёта не совпадает. Обновите страницу.');
      const sender=this.db.prepare('SELECT balance FROM users WHERE id=?').get(payer),receiver=this.db.prepare('SELECT balance FROM users WHERE id=?').get(row.owner_id);
      if(sender.balance<row.amount)throw new HttpError(409,'Недостаточно средств на внутреннем балансе.');
      if(receiver.balance+row.amount>100000000000000)throw new HttpError(409,'Превышен лимит баланса получателя.');
      const operation=randomUUID(),now=new Date().toISOString();
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(operation,payer,key,hash,now);
      this.db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(row.amount,payer);
      this.db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(row.amount,row.owner_id);
      const entry=this.db.prepare('INSERT INTO entries(operation_id,user_id,actor_id,kind,amount,balance_after,reason,created_at) VALUES(?,?,?,?,?,?,?,?)');
      entry.run(operation,payer,payer,'invoice_debit',-row.amount,sender.balance-row.amount,'Оплата счёта '+id,now);
      entry.run(operation,row.owner_id,payer,'invoice_credit',row.amount,receiver.balance+row.amount,'Платёж по счёту '+id,now);
      this.db.prepare("UPDATE invoices SET status='paid',paid_by=?,paid_at=?,operation_id=? WHERE id=? AND status='active'").run(payer,now,operation,id);
      const paid=this.findInvoice(id);
      if(row.webhook_url){
        const eventId=randomUUID(),payload=JSON.stringify({id:eventId,type:'invoice.paid',createdAt:now,data:{invoice:this.invoice(paid)}});
        this.db.prepare("INSERT INTO webhook_jobs(id,app_id,invoice_id,target_url,payload,state,next_attempt,created_at) VALUES(?,?,?,?,?,'pending',?,?)").run(eventId,row.app_id,id,row.webhook_url,payload,Math.floor(Date.now()/1000),now);
      }
      return {invoice:this.invoice(paid,false),replayed:false};
    });
  }
  events(owner,appId,before=Number.MAX_SAFE_INTEGER){this.owned(owner,appId);const rows=this.db.prepare('SELECT * FROM webhook_jobs WHERE app_id=? AND seq<? ORDER BY seq DESC LIMIT 51').all(appId,before);return {items:rows.slice(0,50).map(row=>({id:row.id,invoiceId:row.invoice_id,state:row.state,attempts:row.attempts,lastError:row.last_error,nextAttempt:row.next_attempt,createdAt:row.created_at,deliveredAt:row.delivered_at})),next:rows.length>50?rows[49].seq:null};}
  retryEvent(owner,appId,eventId){
    this.ready();const app=this.owned(owner,appId);if(!app.webhook_url)throw new HttpError(409,'Сначала настройте webhook URL.');
    return this.store.transaction(()=>{const event=this.db.prepare('SELECT * FROM webhook_jobs WHERE id=? AND app_id=?').get(eventId,appId);if(!event)throw new HttpError(404,'Событие не найдено.');if(event.state==='delivered'||event.state==='delivering')throw new HttpError(409,'Событие уже доставлено или доставляется.');if(event.state!=='pending')this.db.prepare("UPDATE webhook_jobs SET state='pending',attempts=0,next_attempt=?,lease_until=0,last_error=NULL,target_url=? WHERE id=?").run(Math.floor(Date.now()/1000),app.webhook_url,eventId);return {ok:true};});
  }
  claimJob(now){
    return this.store.transaction(()=>{
      this.db.prepare("UPDATE webhook_jobs SET state='failed',last_error='Delivery lease expired' WHERE state='delivering' AND lease_until<=? AND attempts>=8").run(now);
      const row=this.db.prepare("SELECT j.*,a.webhook_secret FROM webhook_jobs j JOIN merchant_apps a ON a.id=j.app_id WHERE attempts<8 AND ((state='pending' AND next_attempt<=?) OR (state='delivering' AND lease_until<=?)) ORDER BY j.seq LIMIT 1").get(now,now);if(!row)return null;
      this.db.prepare("UPDATE webhook_jobs SET state='delivering',attempts=attempts+1,lease_until=? WHERE id=?").run(now+60,row.id);return {...row,attempts:row.attempts+1};
    });
  }
  finishJob(id,success,now,error=null){
    const row=this.db.prepare("SELECT * FROM webhook_jobs WHERE id=? AND state='delivering'").get(id);if(!row)return;
    this.db.prepare('UPDATE webhook_jobs SET state=?,lease_until=0,next_attempt=?,last_error=?,delivered_at=? WHERE id=?').run(success?'delivered':row.attempts>=8?'failed':'pending',now+Math.min(3600,30*2**(row.attempts-1)),error,success?new Date(now*1000).toISOString():null,id);
  }
}
