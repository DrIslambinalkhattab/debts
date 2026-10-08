// اختبارات منطق التخزين والمزامنة: تشغّل نفس سكربت index.html داخل Node مع IndexedDB وSupabase "محاكيين".
// تشغيل: node tests/sync.test.js [path/to/index.html]
// مهم: المحاكيان يختبران منطق التطبيق فقط. IndexedDB الحقيقي على الموبايلات وSupabase الحقيقي يُختبران يدويًا (قائمة الاختبار).
const fs = require('fs'), vm = require('vm'), assert = require('assert'), nodeCrypto = require('crypto');
const html = fs.readFileSync(process.argv[2] || __dirname + '/../index.html', 'utf8');
const SRC = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const uuid = () => nodeCrypto.randomUUID();
const J = x => JSON.parse(JSON.stringify(x));

// ---------- IndexedDB محاكي (transactions ذرّية، ConstraintError، QuotaExceededError) ----------
function newStore() { return { ops: new Map(), meta: new Map(), failAdd: false, created: false }; }
function makeIDB(store) {
  const err = n => Object.assign(new Error(n), { name: n });
  const db = {
    createObjectStore() { return { createIndex() {} }; },
    close() {},
    transaction(names) {
      names = [].concat(names);
      const tx = { error: null, _n: 0, _undo: [], _fail: null, _fin: false };
      const finish = () => setTimeout(() => {
        if (tx._fin || tx._n > 0) return; tx._fin = true;
        if (tx._fail) { tx._undo.reverse().forEach(f => f()); tx.error = tx._fail; tx.onabort && tx.onabort(); }
        else tx.oncomplete && tx.oncomplete();
      }, 0);
      const req = fn => {
        const r = {}; tx._n++;
        Promise.resolve().then(() => {
          try { r.result = fn(); r.onsuccess && r.onsuccess({ target: r }); }
          catch (e) { r.error = e; let prevented = false; r.onerror && r.onerror({ preventDefault() { prevented = true; } }); if (!prevented) tx._fail = e; }
          tx._n--; if (tx._n === 0) finish();
        });
        return r;
      };
      tx.objectStore = n => {
        const m = store[n], key = v => v.id ?? v.k;
        return {
          add: v => req(() => { if (m.has(key(v))) throw err('ConstraintError'); if (store.failAdd) throw err('QuotaExceededError'); const k = key(v); m.set(k, J(v)); tx._undo.push(() => m.delete(k)); }),
          put: v => req(() => { const k = key(v), old = m.get(k); if (store.failAdd) throw err('QuotaExceededError'); m.set(k, J(v)); tx._undo.push(() => old === undefined ? m.delete(k) : m.set(k, old)); }),
          getAll: () => req(() => [...m.values()].map(J)),
        };
      };
      Promise.resolve().then(() => finish());
      return tx;
    },
  };
  return { open() { const r = {}; Promise.resolve().then(() => { r.result = db; if (!store.created) { store.created = true; r.onupgradeneeded && r.onupgradeneeded(); } r.onsuccess && r.onsuccess(); }); return r; } };
}

// ---------- Supabase محاكي: نفس قواعد دوال SQL (ping/register/push idempotent/pull بصفحات) ----------
function makeServer() {
  const S = { ops: [], seq: 0, code: 'SECRET', down: false, dropResponse: 0, t: Date.parse('2026-10-09T08:00:00Z'), pushes: 0 };
  const bad = o => {
    const m = ['debt', 'payment', 'tx_amend'].includes(o.type);
    if (m && !(+o.amount > 0 && o.op_date)) return 'check_violation';
    if (['tx_amend', 'tx_void', 'review_ack'].includes(o.type) && !o.target_id) return 'check_violation';
    if (['customer_create', 'customer_update'].includes(o.type) && !String(o.name || '').trim()) return 'check_violation';
    return null;
  };
  S.handle = (fn, a) => {
    if (a.p_code !== S.code) throw { status: 400, message: 'invalid_code' };
    if (fn === 'ping') return { ok: true };
    if (fn === 'register_device') return { ok: true };
    if (fn === 'push_ops') {
      S.pushes++; const acked = [], errors = [];
      for (const o of a.p_ops) {
        const ex = S.ops.find(x => x.id === o.id);
        if (ex) { const same = ex.type === o.type && ex.customer_id === o.customer_id && (+ex.amount || 0) === (+o.amount || 0) && (ex.op_date || null) === (o.op_date || null) && (ex.target_id || null) === (o.target_id || null); same ? acked.push(o.id) : errors.push({ id: o.id, msg: 'id_conflict' }); continue; }
        const b = bad(o); if (b) { errors.push({ id: o.id, msg: b }); continue; }
        S.t += 1000; S.ops.push({ ...J(o), received_at: new Date(S.t).toISOString(), seq: ++S.seq }); acked.push(o.id);
      }
      return { acked, errors };
    }
    if (fn === 'pull_ops') {
      const since = Date.parse(a.p_since), rows = S.ops.filter(o => Date.parse(o.received_at) > since && o.seq > a.p_after_seq).sort((x, y) => x.seq - y.seq).slice(0, a.p_limit + 1);
      return { rows: rows.slice(0, a.p_limit), has_more: rows.length > a.p_limit };
    }
    throw { status: 404, message: 'no such fn' };
  };
  S.fetch = async (url, init) => {
    if (S.down) throw new TypeError('network');
    const fn = url.split('/rpc/')[1]; let out;
    try { out = S.handle(fn, JSON.parse(init.body)); } catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ message: e.message }) }; }
    if (fn === 'push_ops' && S.dropResponse > 0) { S.dropResponse--; throw new TypeError('response lost after server applied'); }
    return { ok: true, status: 200, json: async () => J(out) };
  };
  return S;
}

// ---------- "موبايل": يشغّل سكربت التطبيق في context مستقل مع DOM وهمي ----------
const stub = () => new Proxy(function () {}, {
  get: (t, k) => k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains() { return false; } } : k === 'dataset' ? {} : k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub(),
  set: () => true, apply: () => stub(),
});
async function phone(S, store = newStore(), code = 'SECRET') {
  const js = SRC.replace("const SB_URL='',SB_KEY='';", "const SB_URL='https://t.supabase.co',SB_KEY='k'.repeat(30);")
    .replace('(async()=>{await boot();', 'globalThis.__ready=(async()=>{await boot();')
    + ';globalThis.__T={mk,putOps,commit,sync,rebuild,db:()=>db,OPS,META,pend0,errs,readBackup,makeBackup,asLocal,ST,saveMeta,retryErr,idle:()=>new Promise(r=>{const w=()=>(syncing||again)?setTimeout(w,5):setTimeout(()=>(syncing||again)?w():r(),25);w()}),DEV:()=>DEV};';
  const sb = {
    console, setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 5)), clearTimeout, setInterval: () => 0, requestAnimationFrame: () => 0, performance, AbortController, TextEncoder, URL, Blob, File: class {},
    document: { querySelector: () => stub(), querySelectorAll: () => ({ forEach() {} }), addEventListener() {}, createElement: () => stub(), body: stub(), hidden: false },
    addEventListener() {}, location: { hash: '', pathname: '/', protocol: 'https:', hostname: 'x' }, history: { replaceState() {}, length: 1 },
    navigator: { storage: { persist: async () => true } }, crypto: nodeCrypto.webcrypto, indexedDB: makeIDB(store), fetch: S.fetch,
  };
  const ctx = vm.createContext(sb); vm.runInContext(js, ctx);
  await ctx.__ready; const T = ctx.__T;
  if (code && !T.META.code) await T.saveMeta('code', code);
  await T.idle();
  return { T, store };
}

// ---------- أدوات ----------
const OPD = '2026-10-09';
const addCustomer = async (T, name) => { const id = uuid(); assert(await T.commit([T.mk('customer_create', { id, customer_id: id, name, phone: '' })])); return id; };
const addTx = async (T, cid, type, amount) => { const id = uuid(); assert(await T.commit([T.mk(type, { id, customer_id: cid, amount, op_date: OPD, note: '' })])); return id; };
const cust = (T, cid) => T.db().c.find(c => c.id === cid);
const bal = (T, cid) => { const c = cust(T, cid); return c ? Math.round(c.tx.reduce((s, t) => s + (t.type === 'debt' ? t.amount : -t.amount), 0) * 100) / 100 : null; };
const tx = (T, cid, id) => { const c = cust(T, cid); return c && [...c.tx, ...c.vx].find(t => t.id === id); };
const sync = async (...ps) => { for (const p of ps) { await p.T.sync('t'); await p.T.idle(); } };

let pass = 0, fail = 0; const R = [];
async function test(name, fn) { try { await fn(); pass++; R.push('✅ ' + name); } catch (e) { fail++; R.push('❌ ' + name + '\n     ' + (e && e.message || e)); } }

(async () => {
  const S = makeServer(); let A, A2, B, C, cid, d1, e1;

  await test('1) تسجيل دين ودفعة بدون إنترنت: يُحفظ محليًا ويبقى pending ولا يُحسب synced', async () => {
    S.down = true; A = await phone(S);
    cid = await addCustomer(A.T, 'عميل ١'); d1 = await addTx(A.T, cid, 'debt', 100); await addTx(A.T, cid, 'payment', 30);
    assert.strictEqual(bal(A.T, cid), 70); assert.strictEqual(A.T.pend0().length, 3);
    await sync(A);
    assert.strictEqual(A.T.pend0().length, 3); assert.strictEqual(S.ops.length, 0); assert.strictEqual(A.T.ST.fails, 0);
  });

  await test('2) إغلاق التطبيق وفتحه (جلسة جديدة على نفس التخزين): العمليات والرصيد كما هي', async () => {
    A2 = await phone(S, A.store);
    assert.strictEqual(A2.T.pend0().length, 3); assert.strictEqual(bal(A2.T, cid), 70); assert.strictEqual(A2.T.DEV(), A.T.DEV());
  });

  await test('3) انقطاع بعد نجاح الرفع وقبل وصول الرد: تبقى pending، والإعادة بنفس المعرّف لا تكرّر', async () => {
    S.down = false; S.dropResponse = 1;
    await sync(A2);
    assert.strictEqual(S.ops.length, 3, 'الخادم استلم 3'); assert.strictEqual(A2.T.pend0().length, 3, 'لا synced بدون تأكيد');
    await sync(A2);
    assert.strictEqual(A2.T.pend0().length, 0); assert.strictEqual(S.ops.length, 3, 'لا تكرار');
    assert([...A2.T.OPS.values()].every(o => o.sync === 'synced' && o.seq > 0));
  });

  await test('4) إعادة إرسال نفس العملية مباشرة للخادم مرتين: acked بدون إدخال جديد', async () => {
    const o = J(S.ops[0]); for (const k of ['seq', 'received_at']) delete o[k];
    for (let i = 0; i < 2; i++) { const r = S.handle('push_ops', { p_code: 'SECRET', p_device_id: uuid(), p_ops: [o] }); assert.deepStrictEqual(r.acked, [o.id]); }
    assert.strictEqual(S.ops.length, 3);
  });

  await test('5) ثلاثة موبايلات أوفلاين على نفس العميل ثم مزامنة: لا فقد ولا تكرار والأرصدة متطابقة', async () => {
    B = await phone(S); C = await phone(S); await sync(B, C);
    assert.strictEqual(bal(B.T, cid), 70); assert.strictEqual(bal(C.T, cid), 70); // تنزيل عمليات الموبايل الآخر
    S.down = true;
    await addTx(B.T, cid, 'debt', 50); await addTx(C.T, cid, 'debt', 20); await addTx(C.T, cid, 'payment', 10); await addTx(A2.T, cid, 'debt', 5);
    S.down = false; await sync(B, C, A2, B, C);
    for (const p of [A2, B, C]) { assert.strictEqual(bal(p.T, cid), 135, 'balance'); assert.strictEqual(p.T.pend0().length, 0); assert.strictEqual(p.T.OPS.size, S.ops.length); }
    assert.strictEqual(new Set(S.ops.map(o => o.id)).size, S.ops.length);
  });

  await test('6) موبايل جديد ينزّل كل عمليات الآخرين', async () => {
    const D = await phone(S); await sync(D); assert.strictEqual(bal(D.T, cid), 135); assert.strictEqual(D.T.OPS.size, S.ops.length);
  });

  await test('7) تعديلان لنفس المعاملة من موبايلين أوفلاين: العمليتان محفوظتان، الساري الأحدث، وتُعلَّم للمراجعة ثم تُحسم', async () => {
    S.down = true;
    for (const [p, amt] of [[A2, 120], [B, 90]]) { const t = tx(p.T, cid, d1); assert(await p.T.commit([p.T.mk('tx_amend', { customer_id: cid, target_id: d1, base_id: t.head, amount: amt, op_date: OPD, note: '' })])); }
    S.down = false; await sync(A2, B, C, A2);
    for (const p of [A2, B, C]) { const t = tx(p.T, cid, d1); assert.strictEqual(t.amount, 90); assert.strictEqual(t.conflict, true); assert.strictEqual(bal(p.T, cid), 125); }
    assert.strictEqual(S.ops.filter(o => o.type === 'tx_amend').length, 2, 'لا شيء اتحذف');
    const t = tx(A2.T, cid, d1); assert(await A2.T.commit([A2.T.mk('review_ack', { customer_id: cid, target_id: d1 })])); await sync(A2, B, C);
    for (const p of [A2, B, C]) assert.strictEqual(tx(p.T, cid, d1).conflict, false);
  });

  await test('8) إلغاء على موبايل وتعديل على آخر لنفس المعاملة: الإلغاء يكسب، التعديل يبقى في السجل، وتُعلَّم للمراجعة', async () => {
    e1 = await addTx(A2.T, cid, 'debt', 40); await sync(A2, B, C); assert.strictEqual(bal(B.T, cid), 165);
    S.down = true;
    const ta = tx(A2.T, cid, e1), tb = tx(B.T, cid, e1);
    assert(await A2.T.commit([A2.T.mk('tx_void', { customer_id: cid, target_id: e1, base_id: ta.head })]));
    assert(await B.T.commit([B.T.mk('tx_amend', { customer_id: cid, target_id: e1, base_id: tb.head, amount: 60, op_date: OPD, note: '' })]));
    S.down = false; await sync(B, A2, C, B);
    for (const p of [A2, B, C]) { const t = tx(p.T, cid, e1); assert.strictEqual(t.voided, true); assert.strictEqual(t.conflict, true); assert.strictEqual(bal(p.T, cid), 125); }
    assert.strictEqual(S.ops.filter(o => o.target_id === e1).length, 2);
  });

  await test('9) فشل الكتابة المحلية (امتلاء المساحة): العملية تُرفض بوضوح ولا يُعتبر شيء محفوظًا', async () => {
    const before = A2.T.OPS.size, bb = bal(A2.T, cid); A2.store.failAdd = true;
    const ok = await A2.T.commit([A2.T.mk('debt', { customer_id: cid, amount: 999, op_date: OPD, note: '' })]);
    A2.store.failAdd = false;
    assert.strictEqual(ok, false); assert.strictEqual(A2.T.OPS.size, before); assert.strictEqual(bal(A2.T, cid), bb); assert.strictEqual(A2.store.ops.size, before, 'ولا في التخزين نفسه');
    assert.strictEqual(await A2.T.commit([A2.T.mk('debt', { customer_id: cid, amount: 1, op_date: OPD, note: '' })]), true);
    await sync(A2); assert.strictEqual(bal(A2.T, cid), 126);
  });

  await test('10) ضغطتان على "حفظ" بنفس معرّف العملية: عملية واحدة فقط', async () => {
    const o = A2.T.mk('debt', { customer_id: cid, amount: 7, op_date: OPD, note: '' }), n = A2.T.OPS.size;
    assert.strictEqual(await A2.T.putOps([o]), 1); assert.strictEqual(await A2.T.putOps([o]), 0); assert.strictEqual(A2.T.OPS.size, n + 1);
    await sync(A2, B, C); assert.strictEqual(bal(B.T, cid), 133);
  });

  await test('11) كود دكان خاطئ: لا تُعتبر أي عملية synced ويظهر خطأ الكود', async () => {
    const E = await phone(S, newStore(), 'WRONG'); await addCustomer(E.T, 'غريب'); await sync(E);
    assert.strictEqual(E.T.ST.codeBad, true); assert.strictEqual(E.T.pend0().length, 1); assert(!S.ops.some(o => o.name === 'غريب'));
  });

  await test('12) رفض الخادم لعملية غير صالحة: تُعلَّم error ولا تُحذف، وباقي الدفعة تُرفع', async () => {
    const F = await phone(S), f = await addCustomer(F.T, 'عميل ف'), good = await addTx(F.T, f, 'debt', 15);
    const badOp = F.T.mk('debt', { customer_id: f, amount: -5, op_date: OPD, note: '' }); await F.T.putOps([badOp]); await sync(F);
    assert.strictEqual(F.T.OPS.get(good).sync, 'synced'); assert.strictEqual(F.T.OPS.get(badOp.id).sync, 'error'); assert(F.T.OPS.get(badOp.id).err);
    assert.strictEqual(F.T.pend0().length, 0); assert.strictEqual(F.T.errs().length, 1);
  });

  await test('13) نسخة احتياطية كاملة ← استرجاع على موبايل فارغ ← مزامنة: لا تكرار على الخادم والأرصدة متطابقة', async () => {
    const b = await A2.T.makeBackup('full'), G = await phone(S, newStore()), n = S.ops.length;
    const r = await G.T.readBackup(b.text); assert.strictEqual(r.fresh.length, A2.T.OPS.size);
    assert(await G.T.commit(r.fresh.map(G.T.asLocal))); await sync(G);
    assert.strictEqual(S.ops.length, n, 'لا عمليات مكررة على الخادم'); assert.strictEqual(bal(G.T, cid), bal(A2.T, cid)); assert.strictEqual(G.T.pend0().length, 0);
    const r2 = await G.T.readBackup(b.text); assert.strictEqual(r2.fresh.length, 0); assert.strictEqual(r2.have, r.fresh.length);
  });

  await test('14) ملف نسخة احتياطية معدَّل أو تالف يُرفض (checksum / تنسيق)', async () => {
    const b = await A2.T.makeBackup('full'), d = JSON.parse(b.text); const k = d.ops.findIndex(o => o.amount); d.ops[k].amount = 1;
    await assert.rejects(A2.T.readBackup(JSON.stringify(d)), /checksum/);
    await assert.rejects(A2.T.readBackup('{"x":1}'), /format/); await assert.rejects(A2.T.readBackup('not json'));
  });

  await test('15) نسخة "العمليات غير المرفوعة" تحتوي المعلّق فقط', async () => {
    S.down = true; const H = await phone(S, newStore()); await addCustomer(H.T, 'ح'); const b = await H.T.makeBackup('pending'); S.down = false;
    assert.strictEqual(JSON.parse(b.text).count, 1);
  });

  await test('16) تنزيل 1203 عملية بصفحات (500) على موبايل جديد بدون فقد أو تكرار', async () => {
    const S2 = makeServer(); for (let i = 0; i < 1203; i++) { S2.t += 1000; const id = uuid(); S2.ops.push({ id, type: 'customer_create', customer_id: id, name: 'ع' + i, phone: '', device_id: uuid(), client_created_at: new Date(S2.t).toISOString(), received_at: new Date(S2.t).toISOString(), seq: ++S2.seq }); }
    const P = await phone(S2); await sync(P); assert.strictEqual(P.T.OPS.size, 1203); await sync(P); assert.strictEqual(P.T.OPS.size, 1203);
  });

  console.log(R.join('\n') + `\n\nنجح ${pass} / فشل ${fail}`); process.exit(fail ? 1 : 0);
})();
