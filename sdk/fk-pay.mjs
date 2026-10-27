import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';

export class FKPay {
  constructor({baseUrl,apiKey,timeout=15000}){
    const url=new URL(baseUrl);if(url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('baseUrl must be an origin');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('HTTPS required');
    if(!/^fkw_[a-f0-9]{64}$/.test(apiKey||''))throw new Error('Invalid FK Pay API key');
    this.baseUrl=url.origin;this.apiKey=apiKey;this.timeout=timeout;
  }
  async request(path,{method='GET',body,key}={}){
    const response=await fetch(this.baseUrl+path,{method,headers:{Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(this.timeout),redirect:'error'});
    const value=await response.json();if(!response.ok){const error=new Error(value.error||'FK Pay request failed');error.status=response.status;throw error;}return value;
  }
  createInvoice(invoice,idempotencyKey){if(!idempotencyKey)throw new Error('Pass a stable UUID idempotency key for this order');return this.request('/v1/invoices',{method:'POST',body:invoice,key:idempotencyKey});}
  getInvoice(id){return this.request('/v1/invoices/'+encodeURIComponent(id));}
  listInvoices({before,status}={}){const query=new URLSearchParams();if(before)query.set('before',before);if(status)query.set('status',status);return this.request('/v1/invoices?'+query);}
  cancelInvoice(id){return this.request('/v1/invoices/'+encodeURIComponent(id)+'/cancel',{method:'POST'});}
  getBalance(){return this.request('/v1/balance');}
  static idempotencyKey(){return randomUUID();}
}

export function verifyFKWebhook({secret,timestamp,signature,rawBody,now=Math.floor(Date.now()/1000),tolerance=300}){
  if(typeof secret!=='string'||!secret||!/^\d{10}$/.test(timestamp||'')||Math.abs(now-Number(timestamp))>tolerance||!/^sha256=[a-f0-9]{64}$/.test(signature||''))return false;
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest();
  return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
