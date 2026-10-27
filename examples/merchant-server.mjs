// Educational server integration. Add your own customer auth/catalog before public use.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {FKPay,verifyFKWebhook} from '../sdk/fk-pay.mjs';

export function createExampleShop(config){
  const pay=new FKPay({baseUrl:config.baseUrl,apiKey:config.apiKey});
  if(!/^fkw_wh_[a-f0-9]{64}$/.test(config.webhookSecret||'')||!/^[a-f0-9-]{36}$/.test(config.appId||''))throw new Error('Set FK_WEBHOOK_SECRET and FK_MERCHANT_APP_ID');
  if(config.dbPath!==':memory:')mkdirSync(dirname(resolve(config.dbPath)),{recursive:true});
  const db=new DatabaseSync(config.dbPath);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,amount TEXT NOT NULL,invoice_id TEXT UNIQUE,status TEXT NOT NULL CHECK(status IN ('pending','paid'))) STRICT;
    CREATE TABLE IF NOT EXISTS received_events(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,received_at TEXT NOT NULL) STRICT;`);
  const app=createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try{
      const path=new URL(req.url,'http://example.invalid').pathname;
      if(req.method==='POST'&&path==='/orders'){
        // Price is selected by the merchant's server, never trusted from the buyer.
        const id=randomUUID();db.prepare("INSERT INTO orders VALUES(?,'5.000000',NULL,'pending')").run(id);
        return await invoiceForOrder(id,json);
      }
      const orderMatch=/^\/orders\/([a-f0-9-]{36})(\/invoice)?$/.exec(path);
      if(orderMatch){
        const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderMatch[1]);if(!order)return json(404,{error:'Order not found'});
        if(req.method==='GET'&&!orderMatch[2])return json(200,{id:order.id,status:order.status,amount:order.amount,invoiceId:order.invoice_id});
        if(req.method==='POST'&&orderMatch[2])return await invoiceForOrder(order.id,json);
      }
      if(req.method==='POST'&&path==='/fk-webhook'){
        let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>20000)return json(413,{error:'Too large'});chunks.push(chunk);}
        const rawBody=Buffer.concat(chunks);
        if(!verifyFKWebhook({secret:config.webhookSecret,timestamp:req.headers['fk-timestamp'],signature:req.headers['fk-signature'],rawBody}))return json(401,{error:'Invalid signature'});
        let event;try{event=JSON.parse(rawBody.toString('utf8'));}catch{return json(400,{error:'Invalid JSON'});}
        if(event.id!==req.headers['fk-event-id']||!/^[a-f0-9-]{36}$/.test(event.id||''))return json(400,{error:'Invalid event ID'});
        if(event.type!=='invoice.paid')return json(200,{ignored:true});
        if(db.prepare('SELECT 1 FROM received_events WHERE id=?').get(event.id))return json(200,{duplicate:true});
        if(!/^[a-f0-9-]{36}$/.test(event.data?.invoice?.id||''))return json(400,{error:'Invalid invoice'});
        // Do not trust status/amount/order ID supplied in the notification: query FK Pay.
        const invoice=await pay.getInvoice(event.data.invoice.id),order=db.prepare('SELECT * FROM orders WHERE id=?').get(invoice.payload);
        if(!order||invoice.appId!==config.appId||invoice.status!=='paid'||invoice.asset!=='USDT'||invoice.amount!==order.amount||(order.invoice_id&&order.invoice_id!==invoice.id))return json(409,{error:'Invoice does not match order'});
        db.exec('BEGIN IMMEDIATE');
        try{
          const prior=db.prepare('SELECT 1 FROM received_events WHERE id=?').get(event.id);
          if(!prior){db.prepare('INSERT INTO received_events VALUES(?,?,?)').run(event.id,invoice.id,new Date().toISOString());db.prepare("UPDATE orders SET status='paid',invoice_id=? WHERE id=?").run(invoice.id,order.id);}
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        return json(200,{ok:true});
      }
      return json(404,{error:'Not found'});
    }catch{json(503,{error:'Temporary failure. Retry the same order or webhook.'});}
  });
  async function invoiceForOrder(id,json){
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    try{
      const invoice=order.invoice_id?await pay.getInvoice(order.invoice_id):await pay.createInvoice({amount:order.amount,asset:'USDT',description:'Example item',payload:id},id);
      db.prepare('UPDATE orders SET invoice_id=? WHERE id=?').run(invoice.id,id);
      return json(200,{orderId:id,invoiceId:invoice.id,paymentUrl:invoice.telegramUrl||invoice.paymentUrl});
    }catch{return json(503,{orderId:id,error:'Retry POST /orders/'+id+'/invoice with the SAME order ID.'});}
  }
  app.on('close',()=>db.close());return {app,db};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const {app}=createExampleShop({baseUrl:process.env.FK_PAY_BASE_URL,apiKey:process.env.FK_PAY_API_KEY,webhookSecret:process.env.FK_WEBHOOK_SECRET,appId:process.env.FK_MERCHANT_APP_ID,dbPath:process.env.SHOP_DB_PATH||'./data/example-shop.sqlite'});
    const port=Number(process.env.SHOP_PORT||4000),host=process.env.SHOP_HOST||'127.0.0.1';app.listen(port,host,()=>console.log(`Example merchant listening at ${host}:${port}`));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close(()=>process.exit(0)));
  }catch{console.error('Check examples/.env.example and your merchant environment variables.');process.exitCode=1;}
}
