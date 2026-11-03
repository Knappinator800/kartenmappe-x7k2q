/* Synchronisation über Firebase (Anmeldung per E-Mail + Firestore).
   Ohne Eintrag in firebase-config.js bleibt alles lokal. */
(function () {
  'use strict';
  var App = window.PokeApp;
  var body = document.getElementById('syncBody');
  var summary = document.getElementById('syncSummary');
  var details = document.getElementById('syncBox');
  if (!App || !body || !summary) return;

  var cfg = window.FIREBASE_CONFIG || {};
  var configured = !!(cfg.apiKey && cfg.projectId);
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var META_KEY = 'pokesammlung.sync.v1';
  var WISH = '_wish';
  var MAX_BYTES = 900000;

  var auth = null, db = null, user = null, unsubs = [], timer = null, flushing = false;
  var meta = loadMeta();
  var ui = { phase: configured ? 'loading' : 'off', msg: '', err: false, last: null, email: '', pass: '', cloud: null };

  /* ---------- Hilfen ---------- */
  function h(tag, props) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'text') e.textContent = v;
      else if (k === 'class') e.className = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach(function (c) {
        if (c == null || c === false) return;
        e.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
      .map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function sig(payload) { return stable(payload); }
  function freshMeta() { return { uid: null, sig: {}, upd: {}, dirty: {}, del: {} }; }
  function loadMeta() {
    try {
      var m = JSON.parse(localStorage.getItem(META_KEY));
      if (m && typeof m === 'object') {
        return { uid: m.uid || null, sig: m.sig || {}, upd: m.upd || {}, dirty: m.dirty || {}, del: m.del || {} };
      }
    } catch (e) {}
    return freshMeta();
  }
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }

  var MESSAGES = {
    'auth/invalid-email': 'Die E-Mail-Adresse ist ungültig.',
    'auth/missing-password': 'Bitte ein Passwort eingeben.',
    'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
    'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
    'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.',
    'auth/email-already-in-use': 'Zu dieser E-Mail gibt es schon ein Konto. Melde dich an.',
    'auth/weak-password': 'Das Passwort ist zu schwach (mindestens 6 Zeichen).',
    'auth/network-request-failed': 'Keine Verbindung zum Internet.',
    'auth/too-many-requests': 'Zu viele Versuche. Warte einen Moment.',
    'auth/operation-not-allowed': 'Die Anmeldung per E-Mail ist im Firebase-Projekt noch nicht aktiviert.',
    'permission-denied': 'Zugriff verweigert. Prüfe die Firestore-Regeln.',
    'unavailable': 'Server nicht erreichbar. Es wird später erneut versucht.',
    'app/too-large': 'Eine Sammlung ist für die Synchronisation zu groß (über 900 KB).'
  };
  function niceError(e) {
    var c = (e && e.code) || '';
    return MESSAGES[c] || (e && e.message) || 'Unbekannter Fehler';
  }

  /* ---------- Anzeige ---------- */
  function summaryText() {
    switch (ui.phase) {
      case 'off': return 'Synchronisation: nicht eingerichtet';
      case 'loading': return 'Synchronisation: wird geladen …';
      case 'offline': return 'Synchronisation: nicht erreichbar';
      case 'out': return 'Synchronisation: nicht angemeldet';
      case 'deciding': return 'Synchronisation: Auswahl nötig';
      case 'busy': return 'Synchronisation: läuft …';
      default: return 'Synchronisation: ' + (user && user.email ? user.email : 'angemeldet') + (ui.err ? ' · Fehler' : ' · aktuell');
    }
  }
  function countLocal() {
    var st = App.getState(), cards = 0;
    st.collections.forEach(function (c) { (c.items || []).forEach(function (i) { cards += i.qty || 0; }); });
    return { cols: st.collections.length, cards: cards, wish: (st.wish || []).reduce(function (n, i) { return n + (i.qty || 0); }, 0) };
  }
  function countCloud(cloud) {
    var cols = 0, cards = 0;
    cloud.cols.forEach(function (c) {
      if (c.data.deleted) return;
      cols++;
      (c.data.items || []).forEach(function (i) { cards += i.qty || 0; });
    });
    var wish = cloud.wish && !cloud.wish.deleted ? (cloud.wish.items || []).reduce(function (n, i) { return n + (i.qty || 0); }, 0) : 0;
    return { cols: cols, cards: cards, wish: wish };
  }
  function line(c) { return c.cols + ' Sammlung(en), ' + c.cards + ' Karten, ' + c.wish + ' auf der Wunschliste'; }

  function render() {
    summary.textContent = summaryText();
    body.replaceChildren();
    var msg = h('div', { class: 'meta', role: 'status', 'aria-live': 'polite', style: ui.err ? 'color:var(--danger)' : '', text: ui.msg || '' });

    if (ui.phase === 'off') {
      body.append(h('p', { class: 'meta', text: 'Die Synchronisation ist noch nicht eingerichtet. Deine Daten bleiben auf diesem Gerät.' }));
      return;
    }
    if (ui.phase === 'loading') { body.append(h('p', { class: 'meta', text: 'Wird geladen …' })); return; }
    if (ui.phase === 'offline') {
      body.append(h('p', { class: 'meta', text: 'Der Anmeldedienst ist gerade nicht erreichbar. Die App funktioniert weiter, nur ohne Abgleich.' }),
        h('button', { class: 'btn small', type: 'button', text: 'Erneut versuchen', onclick: function () { ui.phase = 'loading'; render(); boot(); } }));
      return;
    }
    if (ui.phase === 'busy') { body.append(h('p', { class: 'meta', text: ui.msg || 'Bitte warten …' })); return; }

    if (ui.phase === 'out') {
      var email = h('input', { id: 'syncEmail', type: 'email', autocomplete: 'username', placeholder: 'E-Mail-Adresse', 'aria-label': 'E-Mail-Adresse', value: ui.email });
      var pass = h('input', { id: 'syncPass', type: 'password', autocomplete: 'current-password', placeholder: 'Passwort', 'aria-label': 'Passwort' });
      email.addEventListener('input', function () { ui.email = email.value.trim(); });
      pass.addEventListener('input', function () { ui.pass = pass.value; });
      var form = h('form', { class: 'syncform' },
        h('p', { class: 'meta', text: 'Mit einem Konto siehst du auf allen deinen Geräten denselben Stand. Jeder Nutzer hat eigene, getrennte Daten.' }),
        email, pass,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', type: 'submit', text: 'Anmelden' }),
          h('button', { class: 'btn small', type: 'button', text: 'Konto erstellen', onclick: function () { signIn(true); } }),
          h('button', { class: 'btn small', type: 'button', text: 'Passwort vergessen', onclick: resetPassword })),
        msg);
      form.addEventListener('submit', function (e) { e.preventDefault(); signIn(false); });
      body.append(form);
      return;
    }

    if (ui.phase === 'deciding') {
      var c = ui.cloud;
      body.append(
        h('p', { text: 'Auf diesem Gerät und in deinem Konto liegen schon Daten. Wie soll es weitergehen?' }),
        h('p', { class: 'meta', text: 'Dieses Gerät: ' + line(countLocal()) }),
        h('p', { class: 'meta', text: 'Konto (Cloud): ' + line(countCloud(c)) }),
        h('div', { class: 'syncchoices' },
          h('button', { class: 'btn primary', type: 'button', text: 'Zusammenführen (empfohlen)', onclick: function () { choose('merge'); } }),
          h('button', { class: 'btn', type: 'button', text: 'Cloud übernehmen, dieses Gerät ersetzen', onclick: function () { choose('cloud'); } }),
          h('button', { class: 'btn', type: 'button', text: 'Dieses Gerät hochladen, Cloud ersetzen', onclick: function () { choose('upload'); } }),
          h('button', { class: 'btn', type: 'button', text: 'Abmelden', onclick: signOut })),
        h('p', { class: 'meta', text: 'Beim Zusammenführen bleibt von jeder Karte die höhere Anzahl erhalten.' }),
        msg);
      return;
    }

    /* angemeldet */
    var when = ui.last ? 'Zuletzt abgeglichen um ' + ui.last.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr.' : '';
    body.append(
      h('p', { class: 'meta', text: 'Angemeldet als ' + (user && user.email ? user.email : '') + '. ' + when }),
      msg,
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', type: 'button', text: 'Jetzt synchronisieren', onclick: syncNow }),
        h('button', { class: 'btn small', type: 'button', text: 'Abmelden', onclick: signOut })));
  }
  function setStatus(msg, err) { ui.msg = msg || ''; ui.err = !!err; render(); }

  /* ---------- Firebase laden ---------- */
  function loadScripts(list) {
    return list.reduce(function (p, src) {
      return p.then(function () {
        return new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = src; s.onload = res; s.onerror = function () { rej(new Error('Laden fehlgeschlagen')); };
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
  }
  function boot() {
    if (!configured) { render(); return; }
    loadScripts([SDK + 'firebase-app-compat.js', SDK + 'firebase-auth-compat.js', SDK + 'firebase-firestore-compat.js'])
      .then(function () {
        if (!firebase.apps.length) firebase.initializeApp(cfg);
        auth = firebase.auth();
        db = firebase.firestore();
        try { db.enablePersistence({ synchronizeTabs: true }).catch(function () {}); } catch (e) {}
        auth.onAuthStateChanged(onUser);
      })
      .catch(function () { ui.phase = 'offline'; render(); });
  }

  /* ---------- Anmeldung ---------- */
  function onUser(u) {
    user = u;
    unlisten();
    if (!u) {
      meta = freshMeta(); saveMeta();
      ui.phase = 'out'; ui.msg = ''; ui.err = false; render();
      return;
    }
    if (meta.uid === u.uid) {
      /* Bekanntes Konto: erst eigene Änderungen festhalten, dann auf Neues aus der Cloud hören. */
      changed();
      ui.phase = 'in'; setStatus('', false);
      listen(); flush();
    } else {
      initialSync(u);
    }
  }
  function signIn(create) {
    if (!ui.email || !ui.pass) { setStatus('Bitte E-Mail und Passwort eingeben.', true); return; }
    var p = create ? auth.createUserWithEmailAndPassword(ui.email, ui.pass) : auth.signInWithEmailAndPassword(ui.email, ui.pass);
    p.then(function () { ui.pass = ''; }, function (e) { setStatus(niceError(e), true); });
  }
  function resetPassword() {
    if (!ui.email) { setStatus('Gib oben deine E-Mail-Adresse ein.', true); return; }
    auth.sendPasswordResetEmail(ui.email).then(
      function () { setStatus('Falls es ein Konto gibt, wurde eine E-Mail zum Zurücksetzen gesendet.', false); },
      function (e) { setStatus(niceError(e), true); });
  }
  function signOut() { auth.signOut(); }

  /* ---------- Erster Abgleich nach der Anmeldung ---------- */
  function baseRef(u) { return db.collection('users').doc(u.uid); }
  function cloudHas(cloud) {
    return cloud.cols.some(function (c) { return !c.data.deleted && (c.data.items || []).length; }) ||
      !!(cloud.wish && !cloud.wish.deleted && (cloud.wish.items || []).length);
  }
  function localHas() {
    var st = App.getState();
    return (st.wish || []).length > 0 || st.collections.some(function (c) { return (c.items || []).length; });
  }
  function initialSync(u) {
    ui.phase = 'busy'; setStatus('Vergleiche mit deinem Konto …', false);
    var base = baseRef(u);
    Promise.all([
      base.collection('collections').get({ source: 'server' }),
      base.collection('meta').doc('wish').get({ source: 'server' })
    ]).then(function (r) {
      if (user !== u) return;
      var cloud = { cols: [], wish: null };
      r[0].forEach(function (d) { cloud.cols.push({ id: d.id, data: d.data() || {} }); });
      if (r[1].exists) cloud.wish = r[1].data();
      var cHas = cloudHas(cloud), lHas = localHas();
      if (cHas && lHas) {
        ui.cloud = cloud; ui.phase = 'deciding'; ui.msg = ''; render();
        try { details.open = true; } catch (e) {}
        return;
      }
      apply(cHas ? 'cloud' : 'upload', cloud);
    }).catch(function (e) {
      if (user !== u) return;
      ui.phase = 'in'; setStatus(niceError(e), true);
    });
  }
  function choose(kind) { apply(kind, ui.cloud); }

  function mergeItems(a, b) {
    var map = {}, out = [];
    a.forEach(function (i) { map[i.key] = i; out.push(i); });
    b.forEach(function (i) {
      var x = map[i.key];
      if (!x) { map[i.key] = i; out.push(i); return; }
      x.qty = Math.max(x.qty || 0, i.qty || 0);
      if (typeof x.manual !== 'number' && typeof i.manual === 'number') x.manual = i.manual;
      var xu = (x.price && x.price.updated) || '', iu = (i.price && i.price.updated) || '';
      if (iu > xu) x.price = i.price;
      if (!x.image && i.image) x.image = i.image;
    });
    return out;
  }

  function apply(kind, cloud) {
    var u = user; if (!u) return;
    var st = clone(App.getState()), t = Date.now();
    var live = cloud.cols.filter(function (c) { return !c.data.deleted; });
    meta = freshMeta();

    if (kind === 'cloud') {
      st.collections = live.map(function (c) { return { id: c.id, name: c.data.name || 'Sammlung', items: c.data.items || [] }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'de'); });
      st.wish = cloud.wish && !cloud.wish.deleted ? (cloud.wish.items || []) : [];
      cloud.cols.forEach(function (c) { meta.upd[c.id] = Number(c.data.updatedAt) || 0; });
      if (cloud.wish) meta.upd[WISH] = Number(cloud.wish.updatedAt) || 0;
      App.applyState(st);
      /* gespeicherte Signaturen des übernommenen Stands */
      App.getState().collections.forEach(function (c) { meta.sig[c.id] = sig({ name: c.name, items: c.items || [] }); });
      meta.sig[WISH] = sig({ items: App.getState().wish || [] });
    } else {
      if (kind === 'merge') {
        live.forEach(function (c) {
          var local = st.collections.find(function (x) { return x.id === c.id; });
          if (local) local.items = mergeItems(local.items || [], c.data.items || []);
          else st.collections.push({ id: c.id, name: c.data.name || 'Sammlung', items: c.data.items || [] });
        });
        if (cloud.wish && !cloud.wish.deleted) st.wish = mergeItems(st.wish || [], cloud.wish.items || []);
        App.applyState(st);
      } else if (kind === 'upload') {
        var keep = {};
        App.getState().collections.forEach(function (c) { keep[c.id] = true; });
        live.forEach(function (c) { if (!keep[c.id]) { meta.upd[c.id] = t; meta.del[c.id] = true; } });
      }
      /* alles Lokale gilt als neu und wird hochgeladen */
      var cur = App.getState();
      cur.collections.forEach(function (c) {
        meta.sig[c.id] = sig({ name: c.name, items: c.items || [] }); meta.upd[c.id] = t; meta.dirty[c.id] = true;
      });
      meta.sig[WISH] = sig({ items: cur.wish || [] }); meta.upd[WISH] = t; meta.dirty[WISH] = true;
    }
    meta.uid = u.uid; saveMeta();
    ui.cloud = null; ui.phase = 'in';
    changed();
    setStatus('', false);
    listen(); flush();
  }

  /* ---------- Lokale Änderungen erkennen und hochladen ---------- */
  function localDocs() {
    var st = App.getState(), d = {};
    st.collections.forEach(function (c) { d[c.id] = { name: c.name, items: c.items || [] }; });
    d[WISH] = { items: st.wish || [] };
    return d;
  }
  function changed() {
    if (!user || meta.uid !== user.uid) return;
    var docs = localDocs(), t = Date.now(), any = false;
    Object.keys(docs).forEach(function (id) {
      var s = sig(docs[id]);
      if (meta.sig[id] !== s) { meta.sig[id] = s; meta.upd[id] = t; meta.dirty[id] = true; delete meta.del[id]; any = true; }
    });
    Object.keys(meta.sig).forEach(function (id) {
      if (!docs[id]) { delete meta.sig[id]; meta.upd[id] = t; meta.del[id] = true; delete meta.dirty[id]; any = true; }
    });
    if (any) { saveMeta(); schedule(); }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 1200); }
  function refOf(id) {
    var base = baseRef(user);
    return id === WISH ? base.collection('meta').doc('wish') : base.collection('collections').doc(id);
  }
  function flush() {
    if (!user || !db || meta.uid !== user.uid || flushing) return Promise.resolve();
    var ids = Object.keys(meta.dirty).concat(Object.keys(meta.del));
    if (!ids.length) return Promise.resolve();
    flushing = true;
    var docs = localDocs();
    var jobs = ids.map(function (id) {
      var upd = meta.upd[id], data;
      if (meta.del[id]) data = { deleted: true, updatedAt: upd };
      else {
        if (!docs[id]) return Promise.resolve();
        data = clone(docs[id]); data.updatedAt = upd; data.deleted = false;
        if (JSON.stringify(data).length > MAX_BYTES) { var err = new Error('zu groß'); err.code = 'app/too-large'; return Promise.reject(err); }
      }
      return refOf(id).set(data).then(function () {
        if (meta.upd[id] === upd) { delete meta.dirty[id]; delete meta.del[id]; }
      });
    });
    return Promise.all(jobs).then(function () {
      ui.last = new Date(); ui.phase = 'in'; setStatus('', false);
    }, function (e) {
      setStatus(niceError(e), true);
    }).then(function () {
      flushing = false; saveMeta();
      if (Object.keys(meta.dirty).length || Object.keys(meta.del).length) schedule();
    });
  }

  /* ---------- Änderungen aus der Cloud übernehmen ---------- */
  function applyRemote(entries) {
    var st = clone(App.getState()), any = false;
    entries.forEach(function (e) {
      var id = e.id, d = e.data || {}, upd = Number(d.updatedAt) || 0;
      if (upd <= (meta.upd[id] || 0)) return;
      meta.upd[id] = upd; delete meta.dirty[id]; delete meta.del[id];
      if (id === WISH) {
        st.wish = d.deleted ? [] : (d.items || []);
        meta.sig[id] = sig({ items: st.wish });
        any = true; return;
      }
      var idx = st.collections.findIndex(function (c) { return c.id === id; });
      if (d.deleted) {
        delete meta.sig[id];
        if (idx >= 0) { st.collections.splice(idx, 1); any = true; }
        return;
      }
      var col = { id: id, name: d.name || 'Sammlung', items: d.items || [] };
      if (idx >= 0) st.collections[idx] = col; else st.collections.push(col);
      meta.sig[id] = sig({ name: col.name, items: col.items });
      any = true;
    });
    saveMeta();
    if (any) {
      App.applyState(st);
      changed();
      ui.last = new Date(); render();
    }
  }
  function listen() {
    unlisten();
    var base = baseRef(user);
    var onErr = function (e) { setStatus(niceError(e), true); };
    unsubs.push(base.collection('collections').onSnapshot(function (snap) {
      var es = [];
      snap.forEach(function (d) { es.push({ id: d.id, data: d.data() }); });
      applyRemote(es);
    }, onErr));
    unsubs.push(base.collection('meta').doc('wish').onSnapshot(function (s) {
      if (s.exists) applyRemote([{ id: WISH, data: s.data() }]);
    }, onErr));
  }
  function unlisten() { unsubs.forEach(function (f) { try { f(); } catch (e) {} }); unsubs = []; }

  function syncNow() {
    if (!user) return;
    var base = baseRef(user);
    setStatus('Gleiche ab …', false);
    changed();
    Promise.all([
      base.collection('collections').get({ source: 'server' }),
      base.collection('meta').doc('wish').get({ source: 'server' })
    ]).then(function (r) {
      var es = [];
      r[0].forEach(function (d) { es.push({ id: d.id, data: d.data() }); });
      if (r[1].exists) es.push({ id: WISH, data: r[1].data() });
      applyRemote(es);
      return flush();
    }).then(function () { ui.last = new Date(); setStatus('Abgleich abgeschlossen.', false); },
      function (e) { setStatus(niceError(e), true); });
  }

  /* ---------- Start ---------- */
  App.onSave = changed;
  window.addEventListener('online', function () { if (user) { changed(); flush(); } });
  render();
  boot();
})();
