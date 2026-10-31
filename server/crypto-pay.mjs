import { randomUUID } from 'node:crypto';
import { HttpError } from './auth.mjs';
import { parseAmount, formatAmount } from './store.mjs';

const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || '');
const now = () => new Date().toISOString();
function feeMicros(value) {
  if (!['string','number'].includes(typeof value)) throw new Error('Комиссия неизвестна');
  const text=String(value),match=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length>64) throw new Error('Некорректная комиссия');
  const exponent=Number(match[3]||0),fraction=match[2]||'';
  if(Math.abs(exponent)>20)throw new Error('Некорректная комиссия');
  const units=BigInt(match[1]+fraction),scale=6+exponent-fraction.length;
  const divisor=scale<0?10n**BigInt(-scale):1n;
  const micros=scale>=0?units*10n**BigInt(scale):(units+divisor-1n)/divisor;
  if(micros>1000000000000n)throw new Error('Некорректная комиссия');
  return Number(micros);
}
const items = result => { if (Array.isArray(result)) return result; if (Array.isArray(result?.items)) return result.items; throw new Error('Некорректный список Crypto Pay'); };
export class CryptoPayError extends Error {
  constructor(code) { super('Crypto Pay: ' + code); this.providerCode = code; }
}
export class CryptoPayClient {
  constructor(token) { this.token = token; }
  async call(method, body = {}) {
    let response, data;
    try {
      response = await fetch('https://pay.crypt.bot/api/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': this.token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000), redirect: 'error'
      });
      data = await response.json();
    } catch { throw new Error('Crypto Pay временно недоступен'); }
    if (response.status < 500 && data.ok === false && typeof data.error?.name === 'string') throw new CryptoPayError(data.error.name);
    if (!response.ok || data.ok !== true) throw new Error('Неизвестный ответ Crypto Pay');
    return data.result;
  }
}
export class CryptoPayService {
  constructor(store, config, client = null) {
    this.store = store; this.db = store.db; this.config = config;
    this.client = client || (config.cryptoPayToken ? new CryptoPayClient(config.cryptoPayToken) : null);
    this.migrate(); this.running = null; this.timer = null; this.stopped = false;
  }
  migrate() {
    const entrySql=this.db.prepare("SELECT sql FROM sqlite_schema WHERE name='entries'").get().sql;
    if (!entrySql.includes('crypto_deposit') || !entrySql.includes('payout_debit')) this.store.transaction(() => {
      this.db.exec(`DROP TRIGGER entries_no_update; DROP TRIGGER entries_no_delete;
        ALTER TABLE entries RENAME TO entries_crypto_legacy;
        CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES operations(id),user_id TEXT NOT NULL REFERENCES users(id),actor_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('admin_credit','admin_debit','invoice_credit','invoice_debit','payout_credit','payout_debit','crypto_deposit','crypto_withdraw','crypto_refund')),amount INTEGER NOT NULL CHECK(amount!=0),balance_after INTEGER NOT NULL CHECK(balance_after>=0),reason TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
        INSERT INTO entries SELECT * FROM entries_crypto_legacy; DROP TABLE entries_crypto_legacy;
        CREATE INDEX entry_user ON entries(user_id,id DESC);
        CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be edited'); END;
        CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'Ledger entries cannot be deleted'); END;`);
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS crypto_jobs(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('deposit','withdraw')),
      amount INTEGER NOT NULL CHECK(amount>0),request_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('creating','active','pending','paid','completed','failed','expired')),
      provider_id TEXT UNIQUE,payment_url TEXT,credited INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(user_id,kind,request_key)) STRICT;
      CREATE INDEX IF NOT EXISTS crypto_due ON crypto_jobs(state,next_check);
      CREATE TRIGGER IF NOT EXISTS crypto_terms_fixed BEFORE UPDATE OF id,user_id,kind,amount,request_key,created_at ON crypto_jobs BEGIN SELECT RAISE(ABORT,'Crypto payment terms cannot be edited'); END;`);
  }
  ready() { if (!this.client) throw new HttpError(503, 'Crypto Pay не настроен на сервере.'); }
  public(row) { return { id: row.id, kind: row.kind, amount: formatAmount(row.amount), creditedAmount: row.credited == null ? null : formatAmount(row.credited), asset: 'USDT', status: row.state, paymentUrl: row.payment_url, error: row.error, createdAt: row.created_at }; }
  job(id) { return this.db.prepare('SELECT * FROM crypto_jobs WHERE id=?').get(id); }
  list(user) { return { configured: !!this.client, items: this.db.prepare('SELECT * FROM crypto_jobs WHERE user_id=? ORDER BY seq DESC LIMIT 50').all(user).map(row => this.public(row)) }; }
  record(row, delta, kind, suffix = '') {
    const key = 'crypto:' + row.id + suffix;
    if (this.db.prepare('SELECT id FROM operations WHERE actor_id=? AND request_key=?').get(row.user_id, key)) return;
    const user = this.db.prepare('SELECT balance FROM users WHERE id=?').get(row.user_id);
    const balance = user.balance + delta;
    if (balance < 0) throw new HttpError(409, 'Недостаточно средств.');
    if (balance > 100000000000000) throw new HttpError(409, 'Превышен максимальный баланс.');
    const op = randomUUID(), date = now();
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op, row.user_id, key, row.id + suffix, date);
    this.db.prepare('UPDATE users SET balance=? WHERE id=?').run(balance, row.user_id);
    const reason = { crypto_deposit: 'Пополнение через CryptoBot', crypto_withdraw: 'Вывод на свой CryptoBot: сумма зарезервирована', crypto_refund: 'Вывод отклонён: возврат резерва' }[kind];
    this.db.prepare('INSERT INTO entries(operation_id,user_id,actor_id,kind,amount,balance_after,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').run(op, row.user_id, row.user_id, kind, delta, balance, reason, date);
  }
  async create(user, kind, body, key) {
    this.ready(); if (!uuid(key)) throw new HttpError(400, 'Требуется UUID в Idempotency-Key.');
    const amount = parseAmount(body.amount);
    if (amount < 1000000 || amount > 25000000000) throw new HttpError(400, 'Сумма от 1 до 25 000 USDT.');
    let row = this.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM crypto_jobs WHERE user_id=? AND kind=? AND request_key=?').get(user, kind, key);
      if (previous) { if (previous.amount !== amount) throw new HttpError(409, 'Ключ уже использован для другой суммы.'); return previous; }
      if (kind === 'withdraw' && this.db.prepare("SELECT id FROM crypto_jobs WHERE user_id=? AND kind='withdraw' AND state='pending'").get(user)) throw new HttpError(409, 'Дождитесь результата предыдущего вывода.');
      if (this.db.prepare("SELECT count(*) n FROM crypto_jobs WHERE user_id=? AND state IN ('creating','active','pending')").get(user).n >= 10) throw new HttpError(409, 'Завершите предыдущие операции.');
      const id = randomUUID(), date = now();
      this.db.prepare('INSERT INTO crypto_jobs(id,user_id,kind,amount,request_key,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user,kind,amount,key,kind === 'deposit' ? 'creating' : 'pending',date,date);
      const job = this.job(id);
      if (kind === 'withdraw') this.record(job, -amount, 'crypto_withdraw');
      return job;
    });
    if (kind === 'deposit' && row.state === 'creating' && row.attempts === 0) {
      // Claim before awaiting: concurrent retries cannot create two visible invoices.
      if (this.db.prepare('UPDATE crypto_jobs SET attempts=1 WHERE id=? AND attempts=0').run(row.id).changes) {
        try {
          const invoice = await this.client.call('createInvoice', { currency_type: 'crypto', asset: 'USDT', amount: formatAmount(amount), payload: row.id, description: 'FK Wallet: пополнение', expires_in: 3600, allow_comments: false, allow_anonymous: false });
          this.validateInvoice(row, invoice);
          const url = new URL(invoice.bot_invoice_url);
          if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.username || url.password) throw new Error('Некорректный адрес счёта');
          this.db.prepare("UPDATE crypto_jobs SET state='active',provider_id=?,payment_url=?,error=NULL,updated_at=? WHERE id=? AND state='creating'").run(String(invoice.invoice_id),url.href,now(),row.id);
        } catch (error) {
          this.db.prepare("UPDATE crypto_jobs SET state=?,error=?,updated_at=? WHERE id=? AND state='creating'").run(error instanceof CryptoPayError ? 'failed' : 'creating', error instanceof CryptoPayError ? 'Crypto Pay отклонил создание счёта: ' + error.providerCode : 'Проверяем создание счёта в Crypto Pay.',now(),row.id);
        }
      }
    }
    // The durable worker handles withdrawals after the client confirms the request.
    return this.public(this.job(row.id));
  }
  validateInvoice(row, invoice) {
    if (!invoice || !Number.isSafeInteger(invoice.invoice_id) || invoice.asset !== 'USDT' || invoice.currency_type !== 'crypto' || invoice.payload !== row.id || parseAmount(invoice.amount) !== row.amount) throw new Error('Счёт Crypto Pay не совпадает');
  }
  settleDeposit(row, invoice) {
    this.validateInvoice(row, invoice);
    if (String(invoice.invoice_id) !== row.provider_id) throw new Error('Другой счёт Crypto Pay');
    if (invoice.status === 'paid') this.store.transaction(() => {
      const current = this.job(row.id); if (current.state === 'paid') return;
      if (invoice.fee_asset !== 'USDT') throw new Error('Комиссия Crypto Pay неизвестна');
      const fee = feeMicros(invoice.fee_amount);
      if (fee >= current.amount) throw new Error('Некорректная комиссия Crypto Pay');
      const credit = current.amount - fee;
      this.record(current, credit, 'crypto_deposit');
      this.db.prepare("UPDATE crypto_jobs SET state='paid',credited=?,error=NULL,updated_at=? WHERE id=?").run(credit,now(),row.id);
    });
    else if (invoice.status === 'expired') this.db.prepare("UPDATE crypto_jobs SET state='expired',updated_at=? WHERE id=? AND state='active'").run(now(),row.id);
  }
  completeWithdrawal(row, transfer) {
    if (!transfer || transfer.status !== 'completed' || !Number.isSafeInteger(transfer.transfer_id) || transfer.asset !== 'USDT' || String(transfer.user_id) !== row.user_id || transfer.spend_id !== row.id || parseAmount(transfer.amount) !== row.amount) throw new Error('Перевод Crypto Pay не совпадает');
    this.db.prepare("UPDATE crypto_jobs SET state='completed',provider_id=?,error=NULL,updated_at=? WHERE id=? AND state='pending'").run('transfer:' + transfer.transfer_id,now(),row.id);
  }
  async withdraw(row) {
    // A process crash or timeout can happen after provider settlement. Always reconcile first.
    const transfers = items(await this.client.call('getTransfers', { spend_id: row.id, count: 100 }));
    const existing = transfers.find(t => t.spend_id === row.id);
    if (existing) return this.completeWithdrawal(row, existing);
    this.db.prepare('UPDATE crypto_jobs SET attempts=attempts+1,updated_at=? WHERE id=?').run(now(),row.id);
    let transfer;
    try {
      transfer = await this.client.call('transfer', { user_id: Number(row.user_id), asset: 'USDT', amount: formatAmount(row.amount), spend_id: row.id, comment: 'FK Wallet: вывод' });
    } catch (error) {
      // Only the first, unambiguously rejected request may release the reserve.
      // Subsequent errors after a timeout never imply that money was not sent.
      if (error instanceof CryptoPayError && row.attempts === 0) this.store.transaction(() => {
        if (this.job(row.id).state !== 'pending') return;
        this.record(row, row.amount, 'crypto_refund', ':refund');
        this.db.prepare("UPDATE crypto_jobs SET state='failed',error=?,updated_at=? WHERE id=?").run('Crypto Pay отклонил вывод: ' + error.providerCode,now(),row.id);
      });
      else throw error;
      return;
    }
    this.completeWithdrawal(row, transfer);
  }
  async cycle() {
    if (!this.client || this.running || this.stopped) return this.running;
    this.running = (async () => {
      const due = this.db.prepare("SELECT * FROM crypto_jobs WHERE state IN ('creating','active','pending') AND next_check<=? ORDER BY next_check,seq LIMIT 20").all(Date.now());
      for (const row of due) {
        if (this.stopped) break;
        this.db.prepare('UPDATE crypto_jobs SET next_check=? WHERE id=?').run(Date.now()+15000,row.id);
        try {
          if (row.kind === 'deposit') {
            const result = await this.client.call('getInvoices', row.provider_id ? { invoice_ids: row.provider_id } : { count: 1000 });
            const invoice = items(result).find(i => row.provider_id ? String(i.invoice_id) === row.provider_id : i.payload === row.id);
            if (invoice) {
              if (!row.provider_id) {
                this.validateInvoice(row,invoice);
                const url=new URL(invoice.bot_invoice_url);
                if(url.protocol!=='https:'||url.hostname!=='t.me'||url.username||url.password)throw new Error('Некорректный адрес счёта');
                this.db.prepare("UPDATE crypto_jobs SET state='active',provider_id=?,payment_url=?,error=NULL,updated_at=? WHERE id=? AND state='creating'").run(String(invoice.invoice_id),url.href,now(),row.id);
              }
              this.settleDeposit(this.job(row.id), invoice);
            }
          } else await this.withdraw(row);
        } catch {
          this.db.prepare("UPDATE crypto_jobs SET error='Проверяем результат в Crypto Pay. Сумма сохранена в резерве; не создавайте повторный вывод.',updated_at=? WHERE id=? AND state='pending'").run(now(),row.id);
        }
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  start() {
    if (!this.client) return;
    this.client.call('getMe').then(()=>console.log('Crypto Pay: API подключён')).catch(()=>console.error('Crypto Pay: проверьте CRYPTO_PAY_TOKEN и доступ к API'));
    this.timer = setInterval(() => this.cycle().catch(() => console.error('Crypto Pay worker failed')), 5000); this.timer.unref();
    this.cycle().catch(() => console.error('Crypto Pay worker failed'));
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.running; }
}
