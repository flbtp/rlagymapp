// GYM_APP — front end v1
// Référence fonctionnelle : PROJECT_SPEC.md. Tous les textes affichés sont en anglais.
// Toute modification (démarrer, série, fin, saut) est d'abord appliquée localement,
// mise en file d'attente, puis envoyée au Worker par POST /sync dès que possible.
(function () {
  'use strict';

  var APP_VERSION = 'v1';
  var WORKER = ((window.GYM_CONFIG && window.GYM_CONFIG.workerUrl) || '').replace(/\/+$/, '');
  var REQUEST_TIMEOUT_MS = 10000;
  var RETRY_MS = 15000;
  var REST_DONE_MIN_S = 5; // durée minimale d'affichage de « Rest done »

  var LOGO = '<path d="M14 18H86" stroke="#F5A524" stroke-width="9" stroke-linecap="round"/>' +
    '<path d="M14 9V27M86 9V27" stroke="#F5A524" stroke-width="9" stroke-linecap="round"/>' +
    '<path d="M30 18 50 50 70 18M50 50V88" stroke="#EEECE8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
    '<circle cx="50" cy="36" r="6" fill="#EEECE8"/>';
  var ICON_CHECK = '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function logo(size) { return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true">' + LOGO + '</svg>'; }
  function check(size, width) { return ICON_CHECK.replace(/\{s\}/g, size).replace('{w}', width || 2.5); }

  // -------------------------------------------------------------------------
  // Stockage local (toujours protégé : navigation privée, stockage bloqué…)
  // -------------------------------------------------------------------------
  var store = {
    get: function (k) { try { var v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignoré */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignoré */ } }
  };
  function key(name) { return 'gymapp.' + name + '.' + S.user; }

  // -------------------------------------------------------------------------
  // État
  // -------------------------------------------------------------------------
  var S = {
    code: store.get('gymapp.code'),
    user: store.get('gymapp.user'),
    view: 'login',
    home: null,        // dernière réponse de GET /home
    session: null,     // séance en cours (locale)
    after: null,       // séance terminée ou sautée en attente de synchronisation
    queue: [],
    rejected: [],
    net: 'ok',         // 'offline' si le dernier appel a échoué faute de réseau
    homeError: null,
    loginError: null,
    loginBusy: false,
    dialog: null,
    expanded: null,    // exercice ouvert choisi par l'utilisateur
    active: null,      // série en cours de saisie ou de correction ("exercise_id:set_no")
    drafts: {},
    timer: null,
    flushing: false
  };

  function loadUserState() {
    S.home = store.get(key('home'));
    S.session = store.get(key('session'));
    S.after = store.get(key('after'));
    S.queue = store.get(key('queue')) || [];
  }
  function saveQueue() { store.set(key('queue'), S.queue); }
  function saveSession() { if (S.session) store.set(key('session'), S.session); else store.del(key('session')); }
  function saveAfter() { if (S.after) store.set(key('after'), S.after); else store.del(key('after')); }

  // -------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function fmtNum(n) { return String(round2(n)); }
  function parseNum(s) {
    if (s === null || s === undefined) return null;
    s = String(s).trim().replace(',', '.');
    if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  function parseIntStrict(s) {
    s = String(s === null || s === undefined ? '' : s).trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function nowIso() {
    var d = new Date();
    var off = -d.getTimezoneOffset();
    var p = function (n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
      p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(off / 60) + ':' + p(off % 60);
  }
  function loadLabel(ex, kg) {
    if (kg === null || kg === undefined) return '—';
    if (ex.bodyweight) return kg > 0 ? 'BW + ' + fmtNum(kg) + ' kg' : 'BW';
    return fmtNum(kg) + ' kg';
  }
  function range(a, b) { return a === b ? String(a) : a + '–' + b; }
  function repsText(ex) { return ex.sets + ' × ' + range(ex.reps_min, ex.reps_max) + (ex.per_side ? ' per side' : ''); }
  function rirText(ex) { return 'RIR ' + range(ex.rir_min, ex.rir_max); }
  function restText(ex) {
    if (ex.rest_max_s < 120) return 'Rest ' + range(ex.rest_min_s, ex.rest_max_s) + ' s';
    var m = function (s) { return String(Math.round(s / 6) / 10); };
    return 'Rest ' + (ex.rest_min_s === ex.rest_max_s ? m(ex.rest_min_s) : m(ex.rest_min_s) + '–' + m(ex.rest_max_s)) + ' min';
  }
  function clock(sec) { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

  // -------------------------------------------------------------------------
  // Appels au Worker
  // -------------------------------------------------------------------------
  function api(method, path, body, code) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    var headers = { Authorization: 'Bearer ' + (code || S.code) };
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(WORKER + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) { var err = new Error(data.error || 'HTTP ' + res.status); err.status = res.status; throw err; }
          return data;
        });
      }, function () {
        clearTimeout(timer);
        var err = new Error('network'); err.network = true; throw err;
      });
  }

  function fetchHome(refresh) {
    return api('GET', '/home' + (refresh ? '?refresh=1' : '')).then(function (data) {
      S.home = data; S.net = 'ok'; S.homeError = null;
      store.set(key('home'), data);
      if (S.after && S.after.accepted) { S.after = null; saveAfter(); }
      if (S.session && S.session.finished && !hasOps(S.session.session_uid)) { S.session = null; saveSession(); }
      // Séance locale inconnue du Worker et sans envoi en attente : elle n'existe plus, on l'oublie.
      if (S.session && !S.session.finished && !hasOps(S.session.session_uid) &&
          (!data.in_progress || data.in_progress.session_uid !== S.session.session_uid)) {
        S.session = null; saveSession();
        if (S.view === 'session') { S.view = 'home'; S.timer = null; }
      }
      render();
    }, function (err) {
      if (err.status === 401) { signOut(); return; }
      if (err.network) S.net = 'offline';
      if (!S.home) S.homeError = err.network ? 'No connection. Try again.' : 'Server error. Try again later.';
      render();
    });
  }
  function hasOps(uid) { return S.queue.some(function (op) { return op.session_uid === uid; }); }

  function enqueue(op) {
    S.queue.push(op); saveQueue();
    flush();
  }

  function flush() {
    if (S.flushing || !S.queue.length || !S.code) return Promise.resolve();
    S.flushing = true;
    var batch = S.queue.slice(0, 200);
    return api('POST', '/sync', { ops: batch }).then(function (res) {
      S.net = 'ok';
      var results = res.results || [];
      S.queue = S.queue.slice(results.length); saveQueue();
      var needHome = false;
      results.forEach(function (r, i) {
        var op = batch[i];
        if (!r.ok) {
          if (S.rejected.indexOf(r.error) < 0) S.rejected.push(r.error);
          if (op.type === 'session_start' && S.session && op.session_uid === S.session.session_uid) {
            S.session = null; saveSession(); S.timer = null;
            if (S.view === 'session') S.view = 'home';
            needHome = true;
          }
          if (S.after && op.session_uid === S.after.uid && (op.type === 'session_skip' || op.type === 'session_finish')) {
            S.after.accepted = true; needHome = true;
          }
        } else if (S.after && op.session_uid === S.after.uid && (op.type === 'session_skip' || op.type === 'session_finish')) {
          S.after.accepted = true; needHome = true;
        }
      });
      saveAfter();
      S.flushing = false;
      render();
      if (needHome) return fetchHome(false);
      if (S.queue.length) return flush();
    }, function (err) {
      S.flushing = false;
      if (err.status === 401) { signOut(); return; }
      if (err.network) S.net = 'offline';
      render();
    });
  }

  setInterval(function () { if (S.queue.length) flush(); }, RETRY_MS);
  window.addEventListener('online', function () { flush(); if (S.code) fetchHome(false); });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  function signIn(code) {
    S.loginBusy = true; S.loginError = null; render();
    api('GET', '/home', null, code).then(function (data) {
      S.code = code; S.user = data.user.id;
      store.set('gymapp.code', code); store.set('gymapp.user', S.user);
      loadUserState();
      S.home = data; store.set(key('home'), data);
      S.loginBusy = false; S.view = 'home'; S.net = 'ok'; S.homeError = null;
      render(); flush();
    }, function (err) {
      S.loginBusy = false;
      S.loginError = err.status === 401 ? 'Invalid access code.' : err.network ? 'No connection. Try again.' : 'Server error. Try again later.';
      render();
    });
  }

  function signOut() {
    store.del('gymapp.code'); store.del('gymapp.user');
    S.code = null; S.user = null; S.view = 'login'; S.home = null; S.session = null; S.after = null;
    S.queue = []; S.rejected = []; S.timer = null; S.dialog = null; S.loginError = null;
    render();
  }

  function buildSession(detail, uid, cycle, planVersion, startedAt) {
    return {
      session_uid: uid, cycle: cycle, plan_version: planVersion, session_seq: detail.session_seq,
      block: detail.block, session_id: detail.session_id, session_name: detail.session_name,
      warmup: detail.warmup, exercises: detail.exercises, sets: {}, started_at: startedAt, finished: false
    };
  }

  function startSession() {
    var h = S.home; if (!h || !h.session || !h.plan) return;
    var uid = uuid(); var at = nowIso();
    S.session = buildSession(h.session, uid, h.plan.cycle, h.plan.version, at);
    saveSession(); resetSessionUi(); S.view = 'session'; render(); window.scrollTo(0, 0);
    enqueue({ type: 'session_start', session_uid: uid, cycle: h.plan.cycle, plan_version: h.plan.version, session_seq: h.session.session_seq, started_at: at });
  }

  function resumeSession() {
    if (!S.session && S.home && S.home.in_progress && S.home.session) {
      var ip = S.home.in_progress;
      S.session = buildSession(S.home.session, ip.session_uid, ip.cycle, ip.plan_version, ip.started_at);
      ip.sets.forEach(function (x) { S.session.sets[x.exercise_id + ':' + x.set_no] = { load_kg: x.load_kg, reps: x.reps, status: x.status }; });
      saveSession();
    }
    if (!S.session) return;
    resetSessionUi(); S.view = 'session'; render(); window.scrollTo(0, 0);
  }

  function resetSessionUi() { S.expanded = null; S.active = null; S.drafts = {}; S.timer = null; }

  function skipSession() {
    var h = S.home; if (!h || !h.session || !h.plan) return;
    var n = h.session.session_seq;
    S.dialog = {
      msg: 'Skip session ' + n + '? It will be marked as skipped.', ok: 'Skip', cancel: 'Cancel',
      run: function () {
        var uid = uuid();
        S.after = { kind: 'skipped', uid: uid, seq: n, accepted: false }; saveAfter();
        render();
        enqueue({ type: 'session_skip', session_uid: uid, cycle: h.plan.cycle, plan_version: h.plan.version, session_seq: n, at: nowIso() });
      }
    };
    render();
  }

  function exById(id) { return S.session.exercises.filter(function (e) { return e.exercise_id === id; })[0]; }
  function entry(exId, n) { return S.session.sets[exId + ':' + n]; }
  function exComplete(ex) { for (var n = 1; n <= ex.sets; n++) if (!entry(ex.exercise_id, n)) return false; return true; }
  function sessionComplete() { return S.session.exercises.every(exComplete); }

  function draftFor(ex, n) {
    var k = ex.exercise_id + ':' + n;
    if (S.drafts[k]) return S.drafts[k];
    var e = entry(ex.exercise_id, n);
    var load = null, reps = ex.reps_max;
    if (e && e.status === 'DONE') { load = e.load_kg; reps = e.reps; }
    else {
      for (var m = n - 1; m >= 1; m--) { var p = entry(ex.exercise_id, m); if (p && p.status === 'DONE') { load = p.load_kg; break; } }
      if (load === null) load = ex.proposed_load_kg;
    }
    return { load: load === null || load === undefined ? '' : fmtNum(load), reps: String(reps) };
  }
  function draftValid(d) { return parseNum(d.load) !== null && parseIntStrict(d.reps) !== null; }

  function step(k, field, dir) {
    var parts = k.split(':'); var ex = exById(parts[0]); var n = Number(parts[1]);
    var d = draftFor(ex, n); d = { load: d.load, reps: d.reps };
    if (field === 'load') {
      var v = parseNum(d.load);
      v = v === null ? (dir > 0 ? ex.increment_kg : 0) : Math.max(0, round2(v + dir * ex.increment_kg));
      d.load = fmtNum(v);
    } else {
      var r = parseIntStrict(d.reps); r = r === null ? ex.reps_max : Math.max(0, r + dir);
      d.reps = String(r);
    }
    S.drafts[k] = d; S.active = k; render();
  }

  function logSet(k) {
    var parts = k.split(':'); var ex = exById(parts[0]); var n = Number(parts[1]);
    var d = draftFor(ex, n);
    if (!draftValid(d)) return;
    var load = parseNum(d.load), reps = parseIntStrict(d.reps);
    var prev = entry(ex.exercise_id, n);
    var isNew = !prev || prev.status !== 'DONE';
    S.session.sets[k] = { load_kg: load, reps: reps, status: 'DONE' };
    delete S.drafts[k]; S.active = null;
    if (S.expanded === ex.exercise_id && exComplete(ex)) S.expanded = null;
    saveSession();
    if (isNew && !sessionComplete()) startTimer(ex);
    render();
    enqueue(setOp(ex, n, 'DONE', load, reps));
  }

  function setOp(ex, n, status, load, reps) {
    return {
      type: 'set', set_uid: S.session.session_uid + ':' + ex.exercise_id + ':' + n, session_uid: S.session.session_uid,
      exercise_id: ex.exercise_id, exercise_name: ex.exercise_name, set_no: n, bodyweight: ex.bodyweight,
      status: status, load_kg: status === 'DONE' ? load : null, reps: status === 'DONE' ? reps : null, logged_at: nowIso()
    };
  }

  function skipExercise(exId) {
    var ex = exById(exId);
    S.dialog = {
      msg: 'Skip ' + ex.exercise_name + '?', ok: 'Skip', cancel: 'Cancel',
      run: function () {
        var ops = [];
        for (var n = 1; n <= ex.sets; n++) {
          if (!entry(exId, n)) { S.session.sets[exId + ':' + n] = { load_kg: null, reps: null, status: 'SKIPPED' }; ops.push(setOp(ex, n, 'SKIPPED')); }
        }
        if (S.expanded === exId) S.expanded = null;
        if (S.active && S.active.indexOf(exId + ':') === 0) S.active = null;
        saveSession(); render();
        ops.forEach(function (op) { S.queue.push(op); }); saveQueue(); flush();
      }
    };
    render();
  }

  function finishSession() {
    var run = function () {
      var s = S.session;
      s.finished = true; saveSession();
      S.after = { kind: 'finished', uid: s.session_uid, seq: s.session_seq, accepted: false }; saveAfter();
      S.timer = null; S.view = 'home'; resetSessionUi(); render(); window.scrollTo(0, 0);
      enqueue({ type: 'session_finish', session_uid: s.session_uid, finished_at: nowIso() });
    };
    if (sessionComplete()) { run(); return; }
    S.dialog = { msg: 'Some sets are not logged. Finish anyway?', ok: 'Finish', cancel: 'Cancel', run: run };
    render();
  }

  // -------------------------------------------------------------------------
  // Minuteur de repos
  // -------------------------------------------------------------------------
  function startTimer(ex) { S.timer = { start: Date.now(), min: ex.rest_min_s, max: ex.rest_max_s, vibrated: false }; }
  function timerState() {
    var t = S.timer; if (!t) return null;
    var el = (Date.now() - t.start) / 1000;
    if (el >= Math.max(t.max, t.min + REST_DONE_MIN_S)) return { hide: true };
    if (el < t.min) return { label: 'Rest', text: clock(Math.ceil(t.min - el)), pct: t.min ? (el / t.min) * 100 : 100 };
    if (!t.vibrated) { t.vibrated = true; try { if (navigator.vibrate) navigator.vibrate(300); } catch (e) { /* ignoré */ } }
    return { label: 'Rest done', text: '+' + clock(el - t.min), pct: 100 };
  }
  setInterval(function () {
    if (!S.timer || S.view !== 'session') return;
    var st = timerState();
    if (st.hide) { S.timer = null; render(); return; }
    var l = document.getElementById('timer-l'), t = document.getElementById('timer-t'), b = document.getElementById('timer-b');
    if (l) l.textContent = st.label;
    if (t) t.textContent = st.text;
    if (b) b.style.width = st.pct.toFixed(1) + '%';
  }, 250);

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------
  var root = document.getElementById('app');

  function render() {
    var html;
    if (!S.code) html = viewLogin();
    else if (S.view === 'session' && S.session) html = viewSession();
    else { S.view = 'home'; html = viewHome(); }
    if (S.dialog) html += viewDialog();
    root.innerHTML = html;
  }

  function syncChip() {
    if (S.queue.length) return '<span class="chip chip-warn" data-sync="pending">Not synced (' + S.queue.length + ')</span>';
    return '<span class="chip chip-ok" data-sync="ok">' + check(14) + 'Synced</span>';
  }

  function viewLogin() {
    var err = S.loginError;
    return '<main class="screen login">' +
      '<div class="login-brand"><h1 class="wordmark" aria-label="Gym App"><span>G</span>' + logo(52) + '<span>M</span></h1></div>' +
      '<form data-form="login" novalidate>' +
      '<label class="field-label" for="code">Access code</label>' +
      '<input id="code" name="code" class="text-input' + (err ? ' has-error' : '') + '" type="password" placeholder="Access code" autocomplete="current-password" autocapitalize="off" required>' +
      (err ? '<div class="form-error" role="alert">' + esc(err) + '</div>' : '') +
      '<button class="btn btn-primary" type="submit" style="margin-top:8px"' + (S.loginBusy ? ' disabled' : '') + '>Sign in</button>' +
      '</form></main>';
  }

  function viewHome() {
    var h = S.home;
    var out = '<main class="screen">';
    out += '<div class="topbar"><div class="brand">' + logo(28) + '<span class="hello">' + (h ? 'Hi ' + esc(h.user.name) : '') + '</span></div>' + syncChip() + '</div>';
    if (S.rejected.length) {
      out += '<div class="banner-error" role="alert"><div class="title">Some changes were rejected:</div>' +
        S.rejected.map(function (m) { return '<div>' + esc(m) + '</div>'; }).join('') +
        '<button class="small-btn" type="button" data-act="dismiss-rejected">OK</button></div>';
    }
    if (h && h.plan) {
      var p = h.progress || { done: 0, total: 0 };
      out += '<div class="plan-line"><span>Cycle ' + h.plan.cycle + ' · v' + h.plan.version + '</span><span>' +
        (S.net === 'offline' ? 'Offline' : p.done + ' / ' + p.total + ' done') + '</span></div>';
      if (p.total) {
        var cur = h.cycle_complete ? -1 : p.done;
        out += '<div class="segments" style="grid-template-columns:repeat(' + p.total + ',minmax(0,1fr))" aria-hidden="true">';
        for (var i = 0; i < p.total; i++) out += '<div class="' + (i < p.done ? 'done' : i === cur ? 'current' : '') + '"></div>';
        out += '</div>';
      }
    }
    out += homeMain(h);
    out += '<div class="footer"><button class="btn-ghost" type="button" data-act="refresh">Refresh</button>' +
      '<span class="version">' + APP_VERSION + '</span>' +
      '<button class="btn-ghost" type="button" data-act="signout">Sign out</button></div>';
    return out + '</main>';
  }

  function inProgressCard(seq, total, name, logged, planned) {
    var pct = planned ? Math.round((logged / planned) * 100) : 0;
    return '<section class="card active" data-card="in-progress"><div class="kicker"><span class="dot"></span>Session in progress</div>' +
      '<div><div class="big-title">Session ' + seq + (total ? ' <span class="of">of ' + total + '</span>' : '') + '</div>' +
      '<div class="sub">' + esc(name) + '</div></div>' +
      '<div><div class="plan-line" style="font-size:14px;margin-bottom:8px"><span>Sets logged</span><span>' + logged + ' / ' + planned + '</span></div>' +
      '<div class="bar"><div style="width:' + pct + '%"></div></div></div>' +
      '<button class="btn btn-primary" type="button" data-act="resume">Resume session</button></section>';
  }

  function homeMain(h) {
    var total = h && h.progress ? h.progress.total : 0;
    if (S.session && !S.session.finished) {
      var s = S.session, planned = 0, logged = 0;
      s.exercises.forEach(function (ex) { planned += ex.sets; for (var n = 1; n <= ex.sets; n++) if (entry(ex.exercise_id, n)) logged++; });
      return inProgressCard(s.session_seq, total, s.session_name, logged, planned);
    }
    if (S.after) {
      return '<section class="card" data-card="after"><div class="kicker grey">Session ' + S.after.seq + '</div>' +
        '<div class="sub" style="color:var(--text)">' + (S.after.kind === 'skipped' ? 'Session ' + S.after.seq + ' skipped.' : 'Session ' + S.after.seq + ' finished.') +
        ' Waiting for sync to show the next session.</div></section>';
    }
    if (!h) {
      return '<section class="card" data-card="no-data"><div class="sub" style="color:var(--text)">' + esc(S.homeError || 'Loading…') + '</div></section>';
    }
    if (h.plan_error) {
      return '<section class="card" style="background:var(--danger-bg);border-color:var(--danger-line)" role="alert" data-card="plan-error">' +
        '<div class="plan-error-title">Plan error</div><div class="mono">' + esc(h.plan_error) + '</div></section>';
    }
    if (!h.plan) {
      return '<section class="card" data-card="no-plan"><div class="sub" style="color:var(--text)">No plan found. Ask Trainer for a plan.</div></section>';
    }
    if (h.cycle_complete) {
      return '<section class="card center-card" data-card="cycle-complete">' + logo(72) +
        '<div class="d" style="font-size:30px;font-weight:700;line-height:1.1">Cycle complete. Waiting for the next plan.</div></section>';
    }
    if (h.in_progress && h.session) {
      var planned2 = 0; h.session.exercises.forEach(function (ex) { planned2 += ex.sets; });
      return inProgressCard(h.session.session_seq, total, h.session.session_name, h.in_progress.sets.length, planned2);
    }
    if (!h.session) return '';
    var d = h.session;
    return '<section class="card" data-card="next"><div class="kicker">Next session</div>' +
      '<div><div class="big-title">Session ' + d.session_seq + ' <span class="of">of ' + total + '</span></div>' +
      '<div class="sub">Block ' + d.block + ' · ' + esc(d.session_id) + ' · ' + esc(d.session_name) + '</div></div>' +
      '<div class="ex-list">' + d.exercises.map(function (ex) {
        return '<div><span>' + esc(ex.exercise_name) + '</span><span class="load">' + loadLabel(ex, ex.proposed_load_kg) + '</span></div>';
      }).join('') + '</div>' +
      '<button class="btn btn-primary" type="button" data-act="start">Start session</button>' +
      '<button class="btn btn-secondary" type="button" data-act="skip-session">Skip session</button></section>';
  }

  function viewSession() {
    var s = S.session;
    var out = '<main class="screen' + (S.timer ? ' has-timer' : '') + '">';
    out += '<div class="topbar"><button class="link-back" type="button" data-act="home">‹ Home</button>' + syncChip() + '</div>';
    out += '<div><h1 class="session-title">Session ' + s.session_seq + ' · ' + esc(s.session_name) + '</h1><div class="muted" style="font-size:15px">Block ' + s.block + '</div></div>';
    if (s.warmup && s.warmup.notes) {
      out += '<section class="warmup"><div class="kicker grey">Warm-up</div><p>' + esc(s.warmup.notes) + '</p></section>';
    }
    var open = openExerciseId();
    s.exercises.forEach(function (ex) { out += exerciseCard(ex, ex.exercise_id === open); });
    out += '<button class="btn btn-secondary" type="button" data-act="finish" style="margin-top:8px">Finish session</button>';
    out += '</main>';
    if (S.timer) {
      var st = timerState();
      if (st && !st.hide) {
        out += '<div class="timer" role="timer"><div class="timer-inner"><div class="grow"><div class="row"><span class="lbl" id="timer-l">' + st.label +
          '</span><span class="t" id="timer-t">' + st.text + '</span></div><div class="bar"><div id="timer-b" style="width:' + st.pct.toFixed(1) + '%"></div></div></div>' +
          '<button class="skip" type="button" data-act="skip-rest">Skip rest</button></div></div>';
      }
    }
    return out;
  }

  function openExerciseId() {
    var s = S.session;
    if (S.expanded && exById(S.expanded)) return S.expanded;
    for (var i = 0; i < s.exercises.length; i++) if (!exComplete(s.exercises[i])) return s.exercises[i].exercise_id;
    return null;
  }

  function nameLine(ex) {
    return '<span class="ex-name"><span class="d">' + esc(ex.exercise_name) + '</span>' + (ex.shared ? '<span class="badge badge-shared">Shared</span>' : '') + '</span>';
  }

  function summary(ex) {
    var done = [];
    for (var n = 1; n <= ex.sets; n++) { var e = entry(ex.exercise_id, n); if (e && e.status === 'DONE') done.push(e); }
    if (!done.length) return '';
    var same = done.every(function (e) { return e.load_kg === done[0].load_kg; });
    if (same) return loadLabel(ex, done[0].load_kg) + ' × ' + done.map(function (e) { return e.reps; }).join(' / ');
    return done.map(function (e) { return loadLabel(ex, e.load_kg) + ' × ' + e.reps; }).join(' / ');
  }

  function exerciseCard(ex, isOpen) {
    var id = esc(ex.exercise_id);
    var complete = exComplete(ex);
    var anyDone = false, allSkipped = true;
    for (var n = 1; n <= ex.sets; n++) { var e = entry(ex.exercise_id, n); if (e && e.status === 'DONE') anyDone = true; if (!e || e.status !== 'SKIPPED') allSkipped = false; }
    if (!isOpen) {
      if (complete && anyDone) {
        return '<section class="ex done" data-ex="' + id + '"><button class="ex-head" type="button" data-act="open-ex" data-ex="' + id + '">' + nameLine(ex) +
          '<span style="color:var(--accent)" aria-label="Done">' + check(22) + '</span></button><div class="summary">' + esc(summary(ex)) + '</div></section>';
      }
      return '<section class="ex" data-ex="' + id + '"><button class="ex-head" type="button" data-act="open-ex" data-ex="' + id + '">' +
        '<span style="display:flex;flex-direction:column;gap:2px">' + nameLine(ex) + '<span class="ex-meta">' + esc(repsText(ex)) + ' · ' + rirText(ex) + ' · ' + restText(ex) + '</span></span>' +
        (allSkipped ? '<span class="badge badge-skipped">Skipped</span>' : '<span class="compact-load">' + loadLabel(ex, ex.proposed_load_kg) + '</span>') +
        '</button></section>';
    }
    var out = '<section class="ex open" data-ex="' + id + '">';
    out += '<div style="display:flex;flex-direction:column;gap:6px">' +
      '<div class="ex-head">' + nameLine(ex) + (complete && anyDone ? '<span style="color:var(--accent)" aria-label="Done">' + check(22) + '</span>' : '') + '</div>' +
      (ex.equipment ? '<div class="ex-meta">' + esc(ex.equipment) + '</div>' : '') +
      '<div class="ex-facts"><b>' + esc(repsText(ex)) + '</b><span>' + rirText(ex) + '</span><span>' + restText(ex) + '</span></div>' +
      (ex.notes ? '<div class="ex-meta">' + esc(ex.notes) + '</div>' : '') +
      '<div class="last">' + lastText(ex) + '</div>' +
      (ex.proposed_load_kg === null || ex.proposed_load_kg === undefined ? '<div class="find">Find load (' + rirText(ex) + ')</div>' : '') +
      '</div>';
    var activeKey = S.active && S.active.indexOf(ex.exercise_id + ':') === 0 ? S.active : null;
    if (!activeKey) {
      for (var k = 1; k <= ex.sets; k++) if (!entry(ex.exercise_id, k)) { activeKey = ex.exercise_id + ':' + k; break; }
    }
    for (var m = 1; m <= ex.sets; m++) {
      var sk = ex.exercise_id + ':' + m;
      var en = entry(ex.exercise_id, m);
      if (sk === activeKey) out += activeRow(ex, m);
      else if (en && en.status === 'DONE') {
        out += '<button class="set-row logged" type="button" data-act="edit-set" data-key="' + esc(sk) + '" data-set="' + m + '"><span class="label muted">Set ' + m + '</span>' +
          '<span class="v">' + esc(loadLabel(ex, en.load_kg)) + ' × ' + en.reps + '</span><span style="color:var(--accent)" aria-label="Logged">' + check(22) + '</span></button>';
      } else if (en && en.status === 'SKIPPED') {
        out += '<button class="set-row skipped" type="button" data-act="edit-set" data-key="' + esc(sk) + '" data-set="' + m + '"><span class="label">Set ' + m + '</span><span class="badge badge-skipped">Skipped</span></button>';
      } else {
        var d = draftFor(ex, m);
        out += '<button class="set-row pending" type="button" data-act="edit-set" data-key="' + esc(sk) + '" data-set="' + m + '"><span class="label">Set ' + m + '</span>' +
          '<span class="v">' + esc(loadLabel(ex, parseNum(d.load))) + ' × ' + esc(d.reps) + '</span><span style="width:22px"></span></button>';
      }
    }
    var hasOpen = false;
    for (var q = 1; q <= ex.sets; q++) if (!entry(ex.exercise_id, q)) hasOpen = true;
    if (hasOpen) out += '<button class="btn-ghost" type="button" style="align-self:flex-start" data-act="skip-ex" data-ex="' + id + '">Skip exercise</button>';
    return out + '</section>';
  }

  function lastText(ex) {
    var l = ex.last;
    if (!l) return 'Last time: —';
    return 'Last time: ' + esc(loadLabel(ex, l.load_kg)) + ' × ' + l.reps.join(' / ');
  }

  function activeRow(ex, n) {
    var k = esc(ex.exercise_id + ':' + n);
    var d = draftFor(ex, n);
    var ok = draftValid(d);
    return '<div class="set-active" data-key="' + k + '" data-set="' + n + '">' +
      '<div class="top"><span class="label">Set ' + n + '</span>' +
      '<button class="log-btn" type="button" data-act="log" data-key="' + k + '" aria-label="Log set ' + n + '"' + (ok ? '' : ' disabled') + '>' + check(26, 3) + '</button></div>' +
      '<div class="steppers">' +
      '<div class="stepper"><button class="step" type="button" data-act="load-minus" data-key="' + k + '" aria-label="Decrease load">−</button>' +
      '<label class="num"><input data-field="load" data-key="' + k + '" type="text" inputmode="decimal" value="' + esc(d.load) + '" placeholder="—" aria-label="Load">' +
      '<span class="unit">' + (ex.bodyweight ? 'BW + kg' : 'kg') + '</span></label>' +
      '<button class="step" type="button" data-act="load-plus" data-key="' + k + '" aria-label="Increase load">+</button></div>' +
      '<div class="stepper"><button class="step" type="button" data-act="reps-minus" data-key="' + k + '" aria-label="Decrease reps">−</button>' +
      '<label class="num"><input data-field="reps" data-key="' + k + '" type="text" inputmode="numeric" value="' + esc(d.reps) + '" aria-label="Reps">' +
      '<span class="unit">reps</span></label>' +
      '<button class="step" type="button" data-act="reps-plus" data-key="' + k + '" aria-label="Increase reps">+</button></div>' +
      '</div></div>';
  }

  function viewDialog() {
    var d = S.dialog;
    return '<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-msg">' +
      '<div class="msg" id="dlg-msg">' + esc(d.msg) + '</div><div class="actions">' +
      '<button class="btn btn-primary" type="button" data-act="dlg-ok">' + esc(d.ok) + '</button>' +
      '<button class="btn btn-secondary" type="button" data-act="dlg-cancel">' + esc(d.cancel) + '</button></div></div></div>';
  }

  // -------------------------------------------------------------------------
  // Événements
  // -------------------------------------------------------------------------
  root.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.getAttribute('data-form') !== 'login') return;
    e.preventDefault();
    var code = (f.elements.code.value || '').trim();
    if (!code || S.loginBusy) return;
    signIn(code);
  });

  root.addEventListener('input', function (e) {
    var t = e.target; var field = t.getAttribute('data-field'); if (!field) return;
    var k = t.getAttribute('data-key');
    var parts = k.split(':'); var ex = exById(parts[0]);
    var d = draftFor(ex, Number(parts[1])); d = { load: d.load, reps: d.reps };
    d[field] = t.value; S.drafts[k] = d; S.active = k;
    var box = t.closest('.set-active'); var btn = box && box.querySelector('[data-act="log"]');
    if (btn) btn.disabled = !draftValid(d);
  });

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var act = el.getAttribute('data-act'); var k = el.getAttribute('data-key'); var exId = el.getAttribute('data-ex');
    switch (act) {
      case 'start': startSession(); break;
      case 'resume': resumeSession(); break;
      case 'skip-session': skipSession(); break;
      case 'refresh': fetchHome(true).then(flush); break;
      case 'signout':
        if (S.queue.length) S.dialog = { msg: 'Sign out? Unsynced changes will be sent when you sign in again.', ok: 'Sign out', cancel: 'Cancel', run: signOut };
        else { signOut(); return; }
        render(); break;
      case 'dismiss-rejected': S.rejected = []; render(); break;
      case 'home': S.view = 'home'; S.timer = null; render(); window.scrollTo(0, 0); if (S.code) fetchHome(false); break;
      case 'open-ex': S.expanded = exId; S.active = null; render(); break;
      case 'edit-set': S.active = k; S.expanded = k.split(':')[0]; render(); break;
      case 'load-minus': step(k, 'load', -1); break;
      case 'load-plus': step(k, 'load', 1); break;
      case 'reps-minus': step(k, 'reps', -1); break;
      case 'reps-plus': step(k, 'reps', 1); break;
      case 'log': logSet(k); break;
      case 'skip-ex': skipExercise(exId); break;
      case 'finish': finishSession(); break;
      case 'skip-rest': S.timer = null; render(); break;
      case 'dlg-ok': var run = S.dialog && S.dialog.run; S.dialog = null; render(); if (run) run(); break;
      case 'dlg-cancel': S.dialog = null; render(); break;
    }
  });

  // -------------------------------------------------------------------------
  // Démarrage
  // -------------------------------------------------------------------------
  if (S.code && S.user) {
    loadUserState();
    S.view = 'home';
    render();
    fetchHome(false).then(flush);
  } else {
    S.code = null;
    render();
  }
})();
