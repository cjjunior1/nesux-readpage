/* ReadPage · Nesux — la app.
   Cola de lecturas, presentación con una voz y lectura con otra, tiempos,
   listas compartibles por enlace y lectura párrafo a párrafo con resaltado. */
(function () {
  // Cuenta: si la sesión vence o se quita el acceso, la API responde 401 y se vuelve a la página de acceso.
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (...a) => fetchOriginal(...a).then(r => {
    if (r.status === 401 && /\/api\/(?!cuenta|admin)/.test(String(a[0] && a[0].url || a[0]))) setTimeout(() => location.reload(), 300);
    return r;
  });
  let yo = null;
  const pintarCuenta = () => {
    const el = document.getElementById('aj-cuenta'); if (el && yo) el.textContent = '👤 ' + yo.nombre;
    const pe = document.getElementById('dp-pendiente'); if (!pe || !yo) return;
    const c = yo.cambio;
    pe.hidden = !c;
    if (c) pe.textContent = '⏳ Cambio pendiente de aprobación: ' + [c.nombre && 'nombre → ' + c.nombre, c.whatsapp && 'WhatsApp → ' + c.whatsapp, c.correo && 'correo → ' + c.correo].filter(Boolean).join(' · ') + '. Mientras tanto sigues con tus datos actuales.';
  };
  fetchOriginal('/api/cuenta').then(r => r.json()).then(d => { yo = d.usuario; pintarCuenta(); }).catch(() => {});
  // Mi perfil: nombre, WhatsApp y correo se aplican cuando el administrador lo aprueba; la contraseña cambia al instante.
  document.addEventListener('click', ev => {
    if (!(ev.target instanceof Element)) return;
    if (ev.target.closest('#dp-cerrar')) { document.getElementById('d-perfil').close(); return; }
    if (!ev.target.closest('#b-perfil') || !yo) return;
    const g = id => document.getElementById(id);
    g('dp-nombre').value = yo.nombre; g('dp-whatsapp').value = yo.whatsapp; g('dp-correo').value = yo.correo;
    g('dp-nueva').value = ''; g('dp-actual').value = ''; g('dp-msg').hidden = true; pintarCuenta();
    g('d-perfil').showModal();
  });
  document.addEventListener('submit', ev => {
    if (!(ev.target instanceof Element) || ev.target.id !== 'dp-form') return;
    ev.preventDefault();
    const g = id => document.getElementById(id), msg = g('dp-msg'), btn = g('dp-guardar');
    btn.disabled = true; msg.hidden = true;
    fetchOriginal('/api/cuenta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'cambio', nombre: g('dp-nombre').value, whatsapp: g('dp-whatsapp').value, correo: g('dp-correo').value, claveNueva: g('dp-nueva').value, claveActual: g('dp-actual').value }) })
      .then(r => r.json().then(j => { if (!r.ok) throw new Error(j.error || 'No se pudo guardar.'); return j; }))
      .then(j => {
        yo = j.usuario; pintarCuenta();
        msg.style.color = '#22c55e';
        msg.textContent = [j.clave && '✅ Tu contraseña se cambió. Desde ahora entras con la nueva.', j.datos && '✅ Tu cambio de datos fue enviado para aprobación.'].filter(Boolean).join(' ');
        g('dp-nueva').value = ''; g('dp-actual').value = '';
      })
      .catch(e => { msg.style.color = 'var(--rojo)'; msg.textContent = e.message; })
      .finally(() => { msg.hidden = false; btn.disabled = false; });
  });
  document.addEventListener('click', ev => {
    if (!(ev.target instanceof Element) || !ev.target.closest('#b-salir')) return;
    fetchOriginal('/api/cuenta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'salir' }) }).finally(() => location.reload());
  });

  'use strict';
  const $ = id => document.getElementById(id);
  const PPM = 150;                                   // palabras por minuto a velocidad 1×
  const VELS = [1, 1.25, 1.5, 1.75, 2, 0.85];
  const CLAVE = 'readpage.v1';
  const hayVoz = 'speechSynthesis' in window;

  // ------------------------------------------------------------ estado
  let E = { cola: [], historial: [], papelera: [], actualId: null, iv: 0, ajustes: { vpres: 'auto', vlec: 'auto', presentar: true, pantalla: true, idioma: 'orig', motor: 'audio', vozEs: 'claude', vozEsPres: 'narrador' } };
  try { const g = JSON.parse(localStorage.getItem(CLAVE) || 'null'); if (g) E = Object.assign(E, g, { ajustes: Object.assign(E.ajustes, g.ajustes || {}) }); } catch (_) {}
  let reproduciendo = false, pausado = false, turno = 0, bloqueo = null, viendoId = null;
  // Se guarda en dos sitios: localStorage (rápido, pero de ~5 MB) e IndexedDB (sin ese límite, para libros y PDF grandes).
  const BD = (() => {
    let db = null;
    const abrir = () => db || (db = new Promise((ok, mal) => {
      try { const q = indexedDB.open('readpage', 1); q.onupgradeneeded = () => q.result.createObjectStore('estado'); q.onsuccess = () => ok(q.result); q.onerror = () => mal(q.error); }
      catch (e) { mal(e); }
    }));
    return {
      leer: () => abrir().then(d => new Promise((ok, mal) => { const q = d.transaction('estado').objectStore('estado').get('E'); q.onsuccess = () => ok(q.result || null); q.onerror = () => mal(q.error); })).catch(() => null),
      escribir: v => abrir().then(d => new Promise((ok, mal) => { const t = d.transaction('estado', 'readwrite'); t.objectStore('estado').put(v, 'E'); t.oncomplete = ok; t.onerror = () => mal(t.error); })),
    };
  })();
  let avisoLleno = false, tGuardar = null;
  function guardar() {
    E.t = Date.now();
    try { localStorage.setItem(CLAVE, JSON.stringify(E)); }
    catch (_) { try { localStorage.removeItem(CLAVE); } catch (__) {} }   // no cabe: queda solo en IndexedDB
    clearTimeout(tGuardar);
    tGuardar = setTimeout(() => {
      BD.escribir(JSON.parse(JSON.stringify(E))).catch(() => {
        if (!avisoLleno) { avisoLleno = true; toast('No se pudo guardar la cola en este equipo: si cierras la app, se perderán los archivos grandes.'); }
      });
    }, 300);
  }
  const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const item = id => E.cola.find(x => x.id === id);
  const indice = id => E.cola.findIndex(x => x.id === id);

  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('ver'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('ver'), 2600); }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return u; } };
  /** Enlace legible: «es.wikipedia.org › Batería de ion de litio» en vez de «https://…/Bater%C3%ADa_de_ion…». */
  function bonita(u) {
    try {
      const x = new URL(u); let p = x.pathname;
      try { p = decodeURIComponent(p); } catch (_) {}
      const partes = p.split('/').filter(Boolean).map(s => s.replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim()).filter(Boolean);
      return host(u) + (partes.length ? ' › ' + partes.join(' › ') : '');
    } catch (_) { return u; }
  }

  // ------------------------------------------------------------ tiempos
  const vel = () => VELS[E.iv] || 1;
  const palabrasDesde = (it, p) => (it.parrafos || []).slice(p || 0).reduce((s, x) => s + (x.t ? x.t.split(/\s+/).length : 0), 0);
  const min = palabras => palabras / (PPM * vel());
  function fmtMin(m) {
    if (!isFinite(m) || m <= 0) return '0 min';
    if (m < 1) return '< 1 min';
    const t = Math.round(m), h = Math.floor(t / 60), r = t % 60;
    return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${t} min`;
  }
  // Duración para la voz: «menos de un minuto», «7 minutos», «1 hora y 5 minutos».
  function durHablada(m) {
    if (!isFinite(m) || m < 1) return 'menos de un minuto';
    const t = Math.round(m), h = Math.floor(t / 60), r = t % 60;
    const hs = h ? (h === 1 ? '1 hora' : h + ' horas') : '', ms = r ? (r === 1 ? '1 minuto' : r + ' minutos') : '';
    return [hs, ms].filter(Boolean).join(' y ');
  }
  function tiempos() {
    let total = 0, falta = 0, actualFalta = 0; const act = item(E.actualId); let pasadoActual = !act;
    E.cola.forEach(it => {
      if (it.estado === 'error') return;
      const w = it.palabras || 0;
      if (it.estado !== 'leido') total += w;
      if (act && it.id === act.id) { actualFalta = palabrasDesde(it, it.pos || 0); falta += actualFalta; pasadoActual = true; return; }
      if (pasadoActual && it.estado !== 'leido') falta += w;
    });
    return { total: min(total), falta: min(falta), actual: min(actualFalta) };
  }

  // ------------------------------------------------------------ voces
  function puntaje(v, lang) {
    const n = (v.name || '') + ' ' + (v.voiceURI || ''); let p = 0;
    if (!v.lang.toLowerCase().startsWith(lang)) return -1;
    if (/natural|neural|online|premium|enhanced|mejorad/i.test(n)) p += 100;
    if (/google/i.test(n)) p += 60;
    if (/microsoft/i.test(n)) p += 40;
    if (/[-_]DO$/i.test(v.lang)) p += 60; else if (/[-_](US|MX|419|CO)$/i.test(v.lang)) p += 20;
    if (v.localService === false) p += 5;
    return p;
  }
  function voces() { return hayVoz ? speechSynthesis.getVoices() : []; }
  function mejores(lang) { return voces().map(v => [puntaje(v, lang), v]).filter(x => x[0] >= 0).sort((a, b) => b[0] - a[0]).map(x => x[1]); }
  function vozDe(rol, lang) {
    const nombre = rol === 'pres' ? E.ajustes.vpres : E.ajustes.vlec;
    if (nombre && nombre !== 'auto') { const v = voces().find(x => x.name === nombre); if (v) return v; }
    const l = mejores(lang || 'es');
    if (rol === 'lec') return l[0] || null;
    // Presentación: otra voz distinta a la de lectura, para que se note el cambio.
    const lec = vozDe('lec', lang);
    return l.find(v => v !== lec && /natural|neural|online|google/i.test(v.name)) || l.find(v => v !== lec) || lec;
  }
  function llenarVoces() {
    const lista = voces().filter(v => /^(es|en|pt|fr|it|de)/i.test(v.lang)).sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    for (const [sel, val] of [[$('aj-vpres'), E.ajustes.vpres], [$('aj-vlec'), E.ajustes.vlec]]) {
      sel.innerHTML = '<option value="auto">Automática (la mejor del idioma)</option>' +
        lista.map(v => `<option value="${esc(v.name)}">${esc(v.name.replace(/^Microsoft /, '').replace(/ - .*$/, ''))} · ${esc(v.lang)}</option>`).join('');
      sel.value = lista.some(v => v.name === val) ? val : 'auto';
    }
  }
  if (hayVoz) { speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', llenarVoces); }

  // Sin emojis en la voz; los iconos de aviso se dicen con palabras.
  const ICONOS = { '⚠': 'Atención', '⛔': 'Prohibido', '🚫': 'Prohibido', '✅': 'Correcto', '✔': 'Correcto', '❌': 'Incorrecto', '✖': 'Incorrecto', '💡': 'Consejo' };
  function paraVoz(t) {
    let x = String(t || '');
    for (const k in ICONOS) x = x.split(k).join(' ' + ICONOS[k] + ', ');
    x = x.replace(/×/g, ' por ').replace(/÷/g, ' entre ').replace(/≈/g, ' aproximadamente ').replace(/[→←↑↓•·▪►▸↳|]/g, ' ');
    x = x.replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu, '');
    return x.replace(/\s{2,}/g, ' ').trim();
  }
  // Trozos cortos (por frases): evita que algunos navegadores corten la voz en textos largos.
  function trozos(t) {
    const frases = t.match(/[^.!?;:]+[.!?;:]*\s*/g) || [t]; const out = []; let b = '';
    for (const f of frases) { if ((b + f).length > 220 && b) { out.push(b.trim()); b = ''; } b += f; }
    if (b.trim()) out.push(b.trim());
    return out;
  }
  function decir(texto, voz, lang, alTerminar) {
    const mio = turno; const partes = trozos(paraVoz(texto)); let i = 0;
    const sig = () => {
      if (mio !== turno) return;
      if (i >= partes.length) { alTerminar && alTerminar(); return; }
      const u = new SpeechSynthesisUtterance(partes[i++]);
      if (voz) { u.voice = voz; u.lang = voz.lang; } else u.lang = lang === 'en' ? 'en-US' : 'es-ES';
      u.rate = vel();
      u.onstart = () => { vozArranco = true; };
      u.onend = () => { if (mio === turno) sig(); };
      u.onerror = ev => { if (mio === turno && ev.error !== 'interrupted' && ev.error !== 'canceled') sig(); };
      speechSynthesis.speak(u);
      if (!vozArranco && !vigilando) {          // la primera vez: si en 5 s no empezó a sonar, el equipo no tiene voz
        vigilando = true;
        setTimeout(() => { vigilando = false; if (!vozArranco && mio === turno && !pausado) sinVoz(); }, 5000);
      }
    };
    if (!partes.length) { alTerminar && alTerminar(); return; }
    if (hayVoz && speechSynthesis.paused) speechSynthesis.resume();
    if (/Android/i.test(navigator.userAgent) && Date.now() - cancelado < 120) setTimeout(sig, 120); else sig();
  }
  let cancelado = 0, vozArranco = false, vigilando = false;
  function sinVoz() {
    $('aviso-txt').innerHTML = '⚠️ Este equipo no está leyendo en voz alta: le faltan <b>voces de lectura</b>. En Android ve a <b>Ajustes → Accesibilidad → Texto a voz</b>, elige <b>«Servicios de voz de Google»</b> y descarga la voz en español. Revisa también que el volumen multimedia esté subido.';
    $('b-chrome').hidden = true; $('aviso-nav').hidden = false; window.scrollTo(0, 0);
  }
  function callar() {
    turno++; detenerVideo();
    if (hayVoz) { speechSynthesis.cancel(); cancelado = Date.now(); }
    audioEnCurso = false; A.onended = null; if (!A.paused) A.pause();
  }

  // ------------------------------------------------------------ voz de ReadPage (audio del servidor)
  // Es audio de verdad (MP3): sigue sonando con la pantalla apagada o en otra app, con controles en la pantalla bloqueada.
  const A = new Audio(); A.preload = 'auto'; A.setAttribute('playsinline', '');
  let vozServidor = null, audioEnCurso = false, pausaNuestra = false, audioCaido = 0;
  let vocesEs = [];
  fetch('/api/salud').then(r => r.json()).then(d => { vozServidor = d.voz || []; vocesEs = d.vocesEs || []; }).catch(() => { vozServidor = []; });
  const usarAudio = lang => E.ajustes.motor !== 'navegador' && navigator.onLine !== false && Date.now() - audioCaido > 60000
    && (vozServidor === null || vozServidor.includes(String(lang || 'es').slice(0, 2)));
  const audios = new Map();
  /** Pide el audio de un texto (y lo guarda en memoria para que el cambio de párrafo sea inmediato). */
  function obtenerAudio(t, lang, rol) {
    const v = String(lang).slice(0, 2) !== 'es' ? '' : rol === 'pres' ? (E.ajustes.presElegida && VOCES_HOMBRE.includes(E.ajustes.vozEsPres) && E.ajustes.vozEsPres || 'narrador') : (E.ajustes.vozEs || 'claude'), k = lang + '|' + rol + '|' + v + '|' + t;
    if (audios.has(k)) return audios.get(k);
    const pr = fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, l: lang, r: rol, v }) })
      .then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); return fetch(d.url); })
      .then(r => { if (!r.ok) throw new Error('Sin audio.'); return r.blob(); })
      .then(b => URL.createObjectURL(b));
    pr.catch(() => audios.delete(k));
    audios.set(k, pr);
    if (audios.size > 40) { const [k0, p0] = audios.entries().next().value; audios.delete(k0); p0.then(u => setTimeout(() => URL.revokeObjectURL(u), 120000)).catch(() => {}); }
    return pr;
  }
  const VOCES_HOMBRE = ['narrador', 'claude', 'ald', 'sharvard-m', 'davefx'];   // la narración siempre es masculina
  function anticipar(texto, rol, lang) { const t = paraVoz(texto); if (t && usarAudio(lang)) obtenerAudio(t, lang, rol).catch(() => {}); }
  /** Dice un texto: con la voz de ReadPage si se puede; si no, con la del navegador. */
  function hablar(texto, rol, lang, alTerminar, intento = 0) {
    const t = paraVoz(texto);
    if (!t) { alTerminar && alTerminar(); return; }
    if (!usarAudio(lang)) { decir(texto, vozDe(rol, lang), lang, alTerminar); return; }
    const mio = turno; audioEnCurso = true;
    obtenerAudio(t, lang, rol).then(url => {
      if (mio !== turno) return;
      A.onended = () => { if (mio !== turno) return; audioEnCurso = false; alTerminar && alTerminar(); };
      A.src = url; A.defaultPlaybackRate = vel(); A.playbackRate = vel();
      return A.play();
    }).catch(e => {
      if (mio !== turno) return;
      audioEnCurso = false;
      if (e && e.name === 'NotAllowedError') { pausado = true; pintarReproductor(); pintar(); toast('Toca ▶ para empezar a escuchar.'); return; }
      if (intento < 4) { setTimeout(() => { if (mio === turno) hablar(texto, rol, lang, alTerminar, intento + 1); }, [1500, 3000, 6000, 10000][intento]); return; }   // con señal débil se insiste 4 veces antes de rendirse
      audioCaido = Date.now();
      toast('La señal está débil y la voz de ReadPage no llegó: por ahora se usa la voz del teléfono. Vuelve a la voz de ReadPage sola en 1 minuto.');
      decir(texto, vozDe(rol, lang), lang, alTerminar);
    });
  }
  // Pausas que vienen de afuera (una llamada, quitar los audífonos…): el botón se pone al día.
  A.addEventListener('pause', () => { if (pausaNuestra) { pausaNuestra = false; return; } if (audioEnCurso && !A.ended && reproduciendo && !pausado) { pausado = true; pintarReproductor(); pintar(); } });
  A.addEventListener('play', () => { if (audioEnCurso && pausado) { pausado = false; pintarReproductor(); pintar(); } });

  // ------------------------------------------------------------ pantalla encendida
  async function mantenerPantalla(on) {
    try {
      if (on && E.ajustes.pantalla && 'wakeLock' in navigator && !bloqueo) { bloqueo = await navigator.wakeLock.request('screen'); bloqueo.addEventListener('release', () => { bloqueo = null; }); }
      if (!on && bloqueo) { await bloqueo.release(); bloqueo = null; }
    } catch (_) { bloqueo = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && reproduciendo && !pausado) mantenerPantalla(true); });
  // Detectar si es móvil
  const esMobil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Al compartir un enlace desde otra app, Android recarga ReadPage para entregarlo y eso cortaba la lectura.
  // Antes de salir se anota qué se estaba leyendo; al volver a abrir (dentro de 3 minutos) se sigue en el mismo párrafo.
  window.addEventListener('pagehide', () => {
    try {
      const it = reproduciendo && !pausado && E.actualId ? item(E.actualId) : null;
      if (it) { guardar(); localStorage.setItem('readpage.seguir', JSON.stringify({ id: it.id, pos: it.pos || 0, t: Date.now() })); }
      else localStorage.removeItem('readpage.seguir');
    } catch (_) {}
  });

  // ------------------------------------------------------------ extraer páginas
  let enCurso = 0; const espera = [];
  function encolarCarga(it) { if (it.tipo === 'video') return cargarVideo(it); if (!espera.includes(it.id)) espera.push(it.id); bombear(); }
  const errorDeRed = m => /failed to fetch|networkerror|load failed|network|sin conexión con readpage|tardó demasiado/i.test(String(m || ''));
  /** Vuelve a preparar una lectura que falló. */
  function reintentar(it) { if (!it || it.archivo) return; it.estado = 'cargando'; it.error = ''; it.intentosRed = 0; it.progreso = 'Reintentando…'; encolarCarga(it); }
  // Al volver la señal: se reintentan solas las que fallaron por conexión.
  window.addEventListener('online', () => { let n = 0; E.cola.forEach(it => { if (it.estado === 'error' && errorDeRed(it.error)) { reintentar(it); n++; } }); if (n) { guardar(); pintar(); toast(`Volvió la conexión: reintentando ${n} lectura${n === 1 ? '' : 's'}.`); } });
  function bombear() {
    while (enCurso < 3 && espera.length) {
      const it = item(espera.shift()); if (!it) continue;
      enCurso++;
      fetch('/api/extraer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: it.url }) })
        .then(r => r.json()).then(d => {
          if (d.error) throw new Error(d.error);
          if (d.portada && !it.portadaOk) {        // es la portada de un sitio: se ofrecen sus artículos para elegir
            it.estado = 'portada'; it.titulo = d.titulo; it.sitio = d.sitio; it.url = d.url || it.url; it.portada = d;
            if (!$('d-sitio').open) buscarSitio(it.url, `«${d.sitio}» es la portada del sitio: elige qué artículos quieres escuchar.`);
            return;
          }
          Object.assign(it, { estado: 'listo', titulo: d.titulo, sitio: d.sitio, lang: (d.lang || 'es').slice(0, 2), autor: d.autor, parrafos: d.parrafos, palabras: d.palabras, url: d.url || it.url, error: '' });
        }).catch(e => {
          const msg = (e && e.message) || 'No se pudo leer.';
          if (errorDeRed(msg) && (it.intentosRed || 0) < 5) {
            // Señal débil o la app se recargó a mitad de camino: se vuelve a intentar sin molestar.
            it.intentosRed = (it.intentosRed || 0) + 1; it.progreso = 'Sin conexión estable: reintentando…';
            const id = it.id; setTimeout(() => { const x = item(id); if (x && x.estado === 'cargando') encolarCarga(x); }, [3, 8, 20, 45, 90][it.intentosRed - 1] * 1000);
            return;
          }
          it.estado = 'error'; it.error = errorDeRed(msg) ? 'Sin conexión con ReadPage: toca 🔄 Reintentar (o se reintenta solo al volver la señal).' : msg;
        })
        .finally(() => { enCurso--; guardar(); pintar(); bombear(); if (it.id === viendoId) mostrar(it.id); if (it.estado === 'listo') asegurarTraduccion(it); });
    }
  }
  /** La misma noticia aunque el enlace cambie un poco: sin http/https, «www.», barra final, #ancla ni códigos
      de seguimiento (utm_…, fbclid, gclid…). En los videos se compara el video (youtu.be = youtube.com). */
  function claveUrl(u) {
    const v = infoVideo(u); if (v && v.id) return v.plat + ':' + v.id;
    let x; try { x = new URL(u); } catch (_) { return String(u || '').trim().toLowerCase(); }
    [...x.searchParams.keys()].forEach(k => { if (/^(utm_|fbclid$|gclid$|igshid$|mc_|ref$|ref_src$|s$|si$|amp$|share$)/i.test(k)) x.searchParams.delete(k); });
    const q = x.searchParams.toString();
    return x.hostname.replace(/^(www|m|amp)\./, '').toLowerCase() + x.pathname.replace(/\/(amp\/?)?$/, '').replace(/\/+$/, '') + (q ? '?' + q : '');
  }
  function avisarRepetidos(rep) {
    if (!rep.length) return;
    const it = rep[0], tit = (it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url);
    toast(rep.length === 1
      ? `⚠️ Ya está en tu cola${it.estado === 'leido' ? ' (ya la escuchaste)' : ''}: «${tit}». No se agregó otra vez.`
      : `⚠️ ${rep.length} enlaces ya estaban en tu cola y no se repitieron.`);
    // Se resalta en la lista la que ya estaba.
    setTimeout(() => rep.forEach(x => { const li = document.querySelector(`[data-id="${x.id}"]`); if (li) { li.classList.add('repetida'); li.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => li.classList.remove('repetida'), 2600); } }), 250);
  }
  async function agregarUrls(urls, titulos) {
    const ya = new Map(); E.cola.forEach(x => { ya.set(claveUrl(x.url), x); if (x.urlPegada) ya.set(claveUrl(x.urlPegada), x); });
    let n = 0, nv = 0; const repetidas = [];

    // Detectar tipo de cada URL en paralelo
    const detecciones = await Promise.all(urls.map(u => detectarTipo(u)));

    urls.forEach((u, k) => {
      const deteccion = detecciones[k];
      const url = deteccion.url || u;
      const c = claveUrl(url);
      if (ya.has(c)) { const x = ya.get(c); if (x && !repetidas.includes(x)) repetidas.push(x); return; }
      const tit = (titulos && titulos[k]) || '';
      const esVideo = deteccion.tipo === 'video';
      const it = { id: nuevoId(), url, urlPegada: u, estado: 'cargando', titulo: tit, sitio: host(url), pos: 0 };
      ya.set(c, it);
      if (claveUrl(u) !== c) ya.set(claveUrl(u), it);
      if (esVideo) {
        const info = infoVideo(url, tit);
        const plat = info ? info.plat : 'otro';
        Object.assign(it, { tipo: 'video', plat, vid: info ? info.id : '', sitio: PLAT[plat] || PLAT.otro });
      }
      E.cola.push(it); encolarCarga(it); n++; if (esVideo) nv++;
    });
    // Ir a la pestaña donde va lo que se agregó
    if (n && nv > 0 && nv === n) E.vista = 'videos';          // solo videos agregados
    else if (n && nv === 0) E.vista = 'lecturas';             // solo lecturas agregadas
    else if (n && nv > 0 && nv < n) E.vista = 'videos';       // mezcla: ir a videos
    guardar(); pintar();
    if (nv) toast(nv === n ? `🎬 ${nv === 1 ? 'Video agregado' : nv + ' videos agregados'} a la pestaña Videos.` : `${n - nv} lectura(s) y ${nv} video(s): los videos están en la pestaña 🎬 Videos.`);
    if (repetidas.length) setTimeout(() => avisarRepetidos(repetidas), n ? 2200 : 0);
    return n;
  }

  async function detectarTipo(url) {
    const tipoLocal = infoVideo(url) ? 'video' : 'lectura';
    if (tipoLocal === 'video') return { tipo: tipoLocal, url };

    try {
      const response = await fetch('/api/clasificar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      if (!response.ok) throw new Error(`El detector respondió con error ${response.status}.`);
      const data = await response.json();
      if (data.tipo === 'video' || data.tipo === 'lectura') return { tipo: data.tipo, url: data.url || url };
    } catch (_) {}
    return { tipo: tipoLocal, url };
  }
  // ------------------------------------------------------------ archivos (PDF, Word, EPUB, imágenes, texto…)
  let colaArch = Promise.resolve();
  function agregarArchivos(files) {
    files = [...files].filter(Boolean); if (!files.length) return;
    if (!window.RPArchivos) return toast('El lector de archivos no cargó. Recarga la página.');
    files.forEach(f => {
      const id = nuevoId();
      const it = { id, url: 'archivo:' + id, archivo: true, estado: 'cargando', titulo: f.name, sitio: '📎 Archivo', progreso: 'En espera…', pos: 0 };
      E.cola.push(it);
      let ult = 0;
      const avance = t => { it.progreso = t; const a = Date.now(); if (a - ult > 250) { ult = a; pintar(); if (viendoId === it.id) mostrar(it.id); } };
      colaArch = colaArch.then(() => { avance('Abriendo el archivo…'); return window.RPArchivos.leer(f, avance); })            // uno a uno: el OCR es pesado
        .then(d => { Object.assign(it, { estado: 'listo', titulo: d.titulo, sitio: '📎 ' + d.tipo + (d.nota ? ' · ' + d.nota : ''), lang: d.lang, parrafos: d.parrafos, palabras: d.palabras, error: '' }); })
        .catch(e => { it.estado = 'error'; it.error = (e && e.message) || 'No se pudo leer el archivo.'; })
        .finally(() => { delete it.progreso; guardar(); pintar(); if (it.id === viendoId) mostrar(it.id); if (it.estado === 'listo') asegurarTraduccion(it); });
    });
    guardar(); pintar(); irA('cola');
    toast(`${files.length} archivo${files.length > 1 ? 's' : ''} agregado${files.length > 1 ? 's' : ''}: preparando el texto…`);
  }
  /** Agrega lo que viene de una lista compartida: enlaces y documentos ya convertidos a texto. */
  async function agregarDeLista(items) {
    const urls = items.filter(x => !x.archivo);
    let n = await agregarUrls(urls.map(x => x.url), urls.map(x => x.titulo));
    items.filter(x => x.archivo && x.parrafos).forEach(x => {
      const id = nuevoId();
      E.cola.push({ id, url: 'archivo:' + id, archivo: true, estado: 'listo', titulo: x.titulo, sitio: '📎 ' + (x.tipo || 'Documento'), lang: x.lang || 'es', parrafos: x.parrafos, palabras: x.parrafos.reduce((s, p) => s + p.t.split(/\s+/).length, 0), pos: 0 });
      n++; asegurarTraduccion(E.cola[E.cola.length - 1]);
    });
    guardar(); pintar(); return n;
  }

  /** Lo que llega desde «Compartir» (WhatsApp, Chrome…): enlaces → a la cola; texto sin enlaces → se lee ese texto. */
  async function recibirCompartido(titulo, texto, url) {
    const todo = [titulo, texto, url].filter(Boolean).join(' ');
    const urls = sacarUrls(todo);
    if (urls.length) {
      await agregarTodo(urls);
      return;
    }
    const t = String(texto || titulo || '').trim();
    if (t.length < 2) return;
    if (!reproduciendo) {
      const nombre = (t.split(/\n/)[0].slice(0, 60).trim() || 'Texto compartido') + '.txt';
      agregarArchivos([new File([t], nombre, { type: 'text/plain' })]);
    }
  }
  /** Si el enlace es una lista de ReadPage (…/l/CÓDIGO), devuelve el código. */
  function codigoLista(u) {
    try {
      const x = new URL(u);
      if (x.host !== location.host && !/(^|\.)readpage\.nesuxglobalbusinessrd\.com$/i.test(x.hostname)) return null;
      const m = /^\/l\/([A-Za-z0-9]{4,12})\/?$/.exec(x.pathname); return m ? m[1] : null;
    } catch (_) { return null; }
  }
  /** Agrega enlaces normales a la cola y abre las listas de ReadPage que vengan entre ellos. Devuelve cuántas lecturas sumó. */
  async function agregarTodo(urls) {
    const listas = urls.map(codigoLista).filter(Boolean), normales = urls.filter(u => !codigoLista(u));
    if (listas.length) abrirListaCompartida(listas[0]);
    if (listas.length > 1) toast('Abre las listas de una en una: ahora se muestra la primera.');
    const n = normales.length ? await agregarUrls(normales) : 0;
    return { n, videos: n, listas: listas.length };
  }

  // ------------------------------------------------------------ videos
  // Se reconocen solos al agregar: YouTube, Vimeo, TikTok, Facebook, Instagram y archivos de video (.mp4…).
  // Se reproducen uno tras otro, igual que las lecturas. TikTok, Facebook e Instagram no avisan cuándo termina
  // el video: ahí se pasa al siguiente con ⏭⏭.
  const PLAT = { yt: 'YouTube', vimeo: 'Vimeo', tiktok: 'TikTok', fb: 'Facebook', ig: 'Instagram', archivo: 'Video', otro: 'Video' };
  function infoVideo(u, titulo) {
    if (!u && !titulo) return null;
    const t = String(titulo||'').toLowerCase();
    let x = null;
    try { if (u) x = new URL(u); } catch (_) {}
    if (x) {
      const h = x.hostname.toLowerCase().replace(/^(www|m)\./, '');
      const enHost = d => h === d || h.endsWith('.' + d);
      const idRuta = patron => (patron.exec(x.pathname) || [])[1] || '';
      if (enHost('youtube.com') || enHost('youtube-nocookie.com') || enHost('youtu.be')) {
        const id = x.searchParams.get('v') || idRuta(/\/(?:shorts|embed|live|v)\/([^/?]+)/) || (enHost('youtu.be') ? idRuta(/^\/([^/]+)/) : '');
        return { plat: 'yt', id };
      }
      if (enHost('vimeo.com')) return { plat: 'vimeo', id: idRuta(/\/(?:video\/)?(\d+)/) };
      if (enHost('tiktok.com')) return { plat: 'tiktok', id: idRuta(/\/video\/(\d+)/) };
      if (enHost('facebook.com') || enHost('fb.watch')) return { plat: 'fb', id: '' };
      if (enHost('instagram.com')) return { plat: 'ig', id: idRuta(/\/(?:p|reel|reels|tv)\/([^/]+)/) };
      if (/\.(mp4|webm|ogv|m4v|mov|avi|mkv|flv|m3u8|ts)$/i.test(x.pathname)) return { plat: 'archivo', id: '' };
      if (/^(twitch\.tv|dailymotion\.com|rumble\.com|odysee\.com|streamable\.com|kick\.com)$/.test(h) || /\.(video|stream)$/i.test(x.pathname)) return { plat: 'otro', id: '' };
    } else if (!u && (t.includes('youtube') || t.includes('video') || t.includes('twitch') || t.includes('tiktok') || t.includes('vimeo'))) {
      return { plat: 'otro', id: '' };
    }
    return null;
  }
  const esVideoIt = it => !!(it && it.tipo === 'video');
  const fmtDur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(s % 60).padStart(2, '0')}`; };
  function insigniaVideo(it) {
    if (it.estado === 'leido') return '<span class="est est-leida">✓ Visto</span>';
    if (it.id === vpId && !pausado) return '<span class="est est-video">▶ Reproduciendo</span>';
    return '<span class="est est-pend">○ Pendiente</span>';
  }
  function cargarVideo(it) {
    it.estado = 'listo'; it.titulo = it.titulo || (PLAT[it.plat] || 'Video'); guardar(); pintar();
    fetch('/api/video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: it.url }) })
      .then(r => r.json()).then(d => { if (d.error) return; if (d.vid && !it.vid) it.vid = d.vid; if (d.titulo) it.titulo = d.titulo; if (d.autor) it.autor = d.autor; if (d.miniatura) it.mini = d.miniatura; if (d.duracion) it.dur = d.duracion; })
      .catch(() => {}).finally(() => { guardar(); pintar(); if (viendoId === it.id) mostrar(it.id); });
  }
  function siguienteVideo(desde) {
    if (soloIds) return siguienteDeSolo(true);
    for (let k = desde; k < E.cola.length; k++) { const it = E.cola[k]; if (it.tipo === 'video' && it.estado === 'listo') return it; }
    return null;
  }
  // Carga de las librerías de YouTube y Vimeo (una sola vez).
  const libs = {};
  function cargarLib(src, listo) {
    if (listo()) return Promise.resolve();
    if (!libs[src]) libs[src] = new Promise((ok, mal) => { const sc = document.createElement('script'); sc.src = src; sc.async = true; sc.onerror = mal; document.head.appendChild(sc);
      const t0 = Date.now(), mirar = () => listo() ? ok() : (Date.now() - t0 > 15000 ? mal(new Error('tiempo')) : setTimeout(mirar, 120)); mirar(); });
    return libs[src];
  }
  let vp = null, vpId = null, vpReloj = null;   // reproductor activo: { tipo, p } y el id del video
  let vpDesde = 0, vpAvance = false;          // cuándo empezó y si la red informa el avance (para marcarlo visto)
  function detenerVideo() {
    if (!vp) return;
    { const v = item(vpId); if (v && v.estado !== 'leido' && !vpAvance && Date.now() - vpDesde >= 20000) marcarVisto(v); }
    try { if (vp.tipo === 'yt') vp.p.destroy(); else if (vp.tipo === 'vimeo') vp.p.unload().catch(() => {}); else if (vp.tipo === 'html' || vp.tipo === 'fb') vp.p.pause(); } catch (_) {}
    window.__fbAlListo = null;
    vp = null; vpId = null; clearInterval(vpReloj);
    $('vplayer').outerHTML = '<div id="vplayer"></div>'; $('video-caja').hidden = true; $('video-caja').classList.remove('vertical'); $('video-nota').hidden = true; $('video-nota').textContent = '';
  }
  function reproducirVideo(it) {
    if (!it) return;
    callar();                                   // calla la voz y quita el video anterior
    E.actualId = it.id; vpId = it.id; reproduciendo = true; pausado = false; mantenerPantalla(true);
    if (it.estado === 'leido') it.estado = 'listo';
    guardar(); irA('lector'); mostrar(it.id); pintar();
    vpDesde = Date.now(); vpAvance = false;
    clearInterval(vpReloj);
    vpReloj = setInterval(() => avanceVideo(it), 2000);
    const caja = $('video-caja'), nota = $('video-nota'); caja.hidden = false;
    const vertical = it.plat === 'tiktok' || it.plat === 'ig' || /\/shorts\//.test(it.url) || (it.plat === 'fb' && /\/(reel|share\/r)\//.test(it.url));
    caja.classList.toggle('vertical', vertical);
    const iframe = src => { $('vplayer').outerHTML = `<iframe id="vplayer" src="${esc(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`; };
    const sinFin = () => { nota.textContent = `${PLAT[it.plat]} no avisa cuándo termina el video: cuando acabe, toca ⏭⏭ para pasar al siguiente.`; nota.hidden = false; vp = { tipo: 'otro', p: null }; };
    if (it.plat === 'yt' && it.vid) {
      vp = { tipo: 'cargando', p: null };
      cargarLib('https://www.youtube.com/iframe_api', () => window.YT && window.YT.Player).then(() => {
        if (vpId !== it.id) return;
        vp = { tipo: 'yt', p: new YT.Player('vplayer', { videoId: it.vid, playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: e => { try { e.target.setPlaybackRate(vel()); e.target.playVideo(); } catch (_) {} },
            onStateChange: e => { if (vpId !== it.id) return; if (e.data === 0) finVideo(it.id); else if (e.data === 1) { pausado = false; if (!it.dur) { it.dur = e.target.getDuration(); guardar(); } pintar(); } else if (e.data === 2) { pausado = true; pintar(); } },
            onError: () => { toast('Este video no se puede ver dentro de ReadPage: se pasa al siguiente.'); setTimeout(() => { if (vpId === it.id) finVideo(it.id); }, 2500); },
          } }) };
      }).catch(() => { iframe(`https://www.youtube.com/embed/${it.vid}?autoplay=1&playsinline=1`); sinFin(); });
    } else if (it.plat === 'vimeo' && it.vid) {
      iframe(`https://player.vimeo.com/video/${it.vid}?autoplay=1&playsinline=1`);
      vp = { tipo: 'cargando', p: null };
      cargarLib('https://player.vimeo.com/api/player.js', () => window.Vimeo && window.Vimeo.Player).then(() => {
        if (vpId !== it.id) return;
        const p = new Vimeo.Player($('vplayer')); vp = { tipo: 'vimeo', p };
        p.on('ended', () => finVideo(it.id)); p.on('pause', () => { pausado = true; pintar(); }); p.on('play', () => { pausado = false; pintar(); });
        p.setPlaybackRate(vel()).catch(() => {});
      }).catch(sinFin);
    } else if (it.plat === 'archivo') {
      $('vplayer').outerHTML = `<video id="vplayer" src="${esc(it.url)}" controls autoplay playsinline></video>`;
      const v = $('vplayer'); vp = { tipo: 'html', p: v }; v.playbackRate = vel();
      v.onended = () => finVideo(it.id); v.onpause = () => { if (!v.ended) { pausado = true; pintar(); } }; v.onplay = () => { pausado = false; pintar(); };
      v.onerror = () => { toast('No se pudo abrir ese video: se pasa al siguiente.'); setTimeout(() => finVideo(it.id), 2500); };
    } else if (it.plat === 'tiktok' && it.vid) {
      iframe(`https://www.tiktok.com/player/v1/${it.vid}?autoplay=1&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=1&music_info=1&description=0&rel=0&native_context_menu=0`);
      vp = { tipo: 'tiktok', p: $('vplayer'), t: 0, d: 0, arranco: false };
      const vTk = vp;
      setTimeout(() => {
        if (vp !== vTk || vTk.arranco) return;
        aTikTok('mute'); aTikTok('play');
        nota.textContent = '🔇 El video empezó sin sonido (así lo exige el teléfono): toca el video para activar el sonido.'; nota.hidden = false;
      }, 100);
    }
    else if (it.plat === 'fb') {
      // Reproductor oficial de Facebook (SDK): ReadPage lo controla con ▶ / ⏸ / ±10 s y sabe cuándo termina.
      vp = { tipo: 'cargando', p: null };
      const idFb = 'fbv-' + it.id, ancho = Math.max(240, Math.floor(caja.clientWidth || 600));
      $('vplayer').outerHTML = `<div id="vplayer" class="fb-caja"><div class="fb-video" id="${idFb}" data-href="${esc(it.url)}" data-width="${ancho}" data-autoplay="true" data-allowfullscreen="true" data-show-text="false" data-show-captions="false"></div></div>`;
      cargarLib('https://connect.facebook.net/es_LA/sdk.js', () => window.FB && window.FB.XFBML).then(() => {
        if (vpId !== it.id) return;
        if (!window.__fbListo) {
          window.__fbListo = true;
          FB.init({ xfbml: false, version: 'v19.0' });
          FB.Event.subscribe('xfbml.ready', msg => { if (msg.type === 'video' && window.__fbAlListo) window.__fbAlListo(msg); });
        }
        window.__fbAlListo = msg => {
          if (msg.id !== idFb || vpId !== it.id) return;
          const p = msg.instance; let arranco = false;
          vp = { tipo: 'fb', p, pausadoFb: false };
          p.subscribe('startedPlaying', () => { arranco = true; vp && (vp.pausadoFb = false); pausado = false; pintar(); });
          p.subscribe('paused', () => { if (vp) vp.pausadoFb = true; pausado = true; pintar(); });
          p.subscribe('finishedPlaying', () => { if (vpId === it.id) finVideo(it.id); });
          p.subscribe('error', () => { toast('Este video de Facebook no se puede ver aquí: se pasa al siguiente.'); setTimeout(() => { if (vpId === it.id) finVideo(it.id); }, 2500); });
          try { p.play(); } catch (_) {}
          // Si el teléfono no deja arrancar con sonido, arranca en silencio y se avisa para activarlo.
          setTimeout(() => {
            if (arranco || vpId !== it.id) return;
            try { p.mute(); p.play(); } catch (_) {}
            nota.textContent = '🔇 El video empezó sin sonido (así lo exige el teléfono): toca el video para activar el sonido.'; nota.hidden = false;
          }, 100);
        };
        FB.XFBML.parse($('vplayer'));
      }).catch(() => { iframe(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(it.url)}&show_text=false&autoplay=true`); sinFin(); });
    }
    else if (it.plat === 'ig' && it.vid) { iframe(`https://www.instagram.com/p/${it.vid}/embed`); sinFin(); }
    else { caja.hidden = true; nota.innerHTML = `Este video se abre en su página: <a href="${esc(it.url)}" target="_blank" rel="noopener">Abrir ↗</a>. Luego toca ⏭⏭ para el siguiente.`; nota.hidden = false; vp = { tipo: 'otro', p: null }; }
  }
  // El reproductor oficial de TikTok avisa por mensajes: estado (1 reproduce, 2 pausa, 0 terminó) y tiempo.
  function aTikTok(tipo, valor) { try { vp && vp.p && vp.p.contentWindow.postMessage({ type: tipo, value: valor, 'x-tiktok-player': true }, '*'); } catch (_) {} }
  window.addEventListener('message', e => {
    let o; try { o = new URL(e.origin).hostname; } catch (_) { return; }
    if (!/(^|\.)tiktok\.com$/.test(o) || !vp || vp.tipo !== 'tiktok') return;
    let d = e.data; if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
    if (!d || !d['x-tiktok-player']) return;
    const it = item(vpId); if (!it) return;
    if (d.type === 'onStateChange') {
      if (d.value === 0) finVideo(it.id);
      else if (d.value === 1) { vp.arranco = true; pausado = false; pintar(); }
      else if (d.value === 2) { pausado = true; pintar(); }
    } else if (d.type === 'onCurrentTime' && d.value) { vp.t = Number(d.value.currentTime) || 0; vp.d = Number(d.value.duration) || 0; }
    else if (d.type === 'onPlayerReady') aTikTok('play');
  });
  /** Queda como visto (una sola vez en el historial). */
  function marcarVisto(it) {
    if (!it || it.estado === 'leido') return;
    it.estado = 'leido'; anotar(it, 100); guardar(); pintar();
  }
  /** Cada 2 s: cuánto lleva el video. Al 90 % queda visto (sigue sonando hasta el final). */
  function avanceVideo(it) {
    if (!vp || vpId !== it.id || !vp.p) return;
    const usar = (t, d) => {
      if (!(d > 0)) return;
      vpAvance = true;
      if (!it.dur) { it.dur = d; guardar(); }
      if (E.actualId === it.id) $('rep-barra').style.width = Math.min(100, Math.round(100 * t / d)) + '%';
      if (t / d >= 0.9) marcarVisto(it);
    };
    try {
      if (vp.tipo === 'yt') usar(vp.p.getCurrentTime(), vp.p.getDuration());
      else if (vp.tipo === 'html') usar(vp.p.currentTime, vp.p.duration);
      else if (vp.tipo === 'fb') usar(vp.p.getCurrentPosition(), vp.p.getDuration());
      else if (vp.tipo === 'tiktok') usar(vp.t, vp.d);
      else if (vp.tipo === 'vimeo') Promise.all([vp.p.getCurrentTime(), vp.p.getDuration()]).then(([t, d]) => usar(t, d)).catch(() => {});
    } catch (_) {}
  }
  /** Terminó (o se saltó) un video: queda como visto y empieza el siguiente. */
  function finVideo(id, saltado) {
    const it = item(id); if (!it) return;
    it.estado = 'leido'; anotar(it, saltado ? 50 : 100); guardar();
    const sig = siguienteVideo(indice(id) + 1);
    if (sig) { reproducirVideo(sig); return; }
    const sigLec = listoSiguiente(0);
    if (sigLec) { E.vista = 'lecturas'; guardar(); pintar(); reproducir(sigLec.id, 0); return; }
    detenerVideo(); reproduciendo = false; pausado = false; mantenerPantalla(false); pintar(); mostrar(id);
    toast('Terminaste tus videos.');
  }
  function alternarVideo() {
    if (!vp || !vp.p) { toast('Usa los controles del video.'); return; }
    try {
      if (vp.tipo === 'yt') { if (vp.p.getPlayerState() === 1) vp.p.pauseVideo(); else vp.p.playVideo(); }
      else if (vp.tipo === 'vimeo') vp.p.getPaused().then(p => p ? vp.p.play() : vp.p.pause());
      else if (vp.tipo === 'html') { if (vp.p.paused) vp.p.play(); else vp.p.pause(); }
      else if (vp.tipo === 'fb') { if (vp.pausadoFb || pausado) vp.p.play(); else vp.p.pause(); }
      else if (vp.tipo === 'tiktok') { aTikTok(pausado ? 'play' : 'pause'); pausado = !pausado; pintar(); }
    } catch (_) {}
  }
  function moverVideo(seg) {
    if (!vp || !vp.p) return;
    try {
      if (vp.tipo === 'yt') vp.p.seekTo(Math.max(0, vp.p.getCurrentTime() + seg), true);
      else if (vp.tipo === 'vimeo') vp.p.getCurrentTime().then(t => vp.p.setCurrentTime(Math.max(0, t + seg)));
      else if (vp.tipo === 'html') vp.p.currentTime = Math.max(0, vp.p.currentTime + seg);
      else if (vp.tipo === 'fb') vp.p.seek(Math.max(0, vp.p.getCurrentPosition() + seg));
      else if (vp.tipo === 'tiktok') aTikTok('seekTo', Math.max(0, (vp.t || 0) + seg));
    } catch (_) {}
  }
  function velVideo() {
    if (!vp || !vp.p) return;
    try { if (vp.tipo === 'yt') vp.p.setPlaybackRate(vel()); else if (vp.tipo === 'vimeo') vp.p.setPlaybackRate(vel()).catch(() => {}); else if (vp.tipo === 'html') vp.p.playbackRate = vel(); } catch (_) {}
  }

  const sacarUrls = t => [...new Set((String(t).match(/https?:\/\/[^\s<>"'()]+/gi) || []).map(u => u.replace(/[.,;:!?)\]]+$/, '')))];

  // ------------------------------------------------------------ traducción
  // Si no hay un nombre de sitio que se pueda decir bien, la presentación lo omite.
  const FRASES = {
    es: (n, N, t, s, d) => `Lectura ${n} de ${N}. ${t}.${s ? ` De ${s}.` : ''} Duración aproximada: ${d}.`,
    en: (n, N, t, s) => `Reading ${n} of ${N}. ${t}.${s ? ` From ${s}.` : ''}`,
    pt: (n, N, t, s) => `Leitura ${n} de ${N}. ${t}.${s ? ` De ${s}.` : ''}`,
    fr: (n, N, t, s) => `Lecture ${n} sur ${N}. ${t}.${s ? ` De ${s}.` : ''}`,
    it: (n, N, t, s) => `Lettura ${n} di ${N}. ${t}.${s ? ` Da ${s}.` : ''}`,
    de: (n, N, t, s) => `Lesung ${n} von ${N}. ${t}.${s ? ` Von ${s}.` : ''}`,
  };
  // Nombres conocidos, para que se digan como se dicen y no letra por letra.
  const SITIOS = { 'wikipedia': 'Wikipedia', 'listindiario': 'Listín Diario', 'diariolibre': 'Diario Libre', 'elcaribe': 'El Caribe', 'hoy': 'periódico Hoy',
    'msn': 'MSN', 'youtube': 'YouTube', 'bbc': 'BBC', 'cnn': 'CNN', 'elpais': 'El País', 'infobae': 'Infobae', 'medium': 'Medium',
    'nesuxglobalbusinessrd': 'Nesux', 'litiobattery': 'Litio Battery', 'xataka': 'Xataka', 'espinof': 'Espinof' };
  /** El sitio dicho de forma natural: «Wikipedia», «Listín Diario»… o nada si no se puede pronunciar bien. */
  function sitioHablado(it) {
    let s = String(it.sitio || '').replace(/^📎\s*/, '').trim();
    if (it.archivo) return s ? 'un documento ' + s.split(' · ')[0] : '';      // «De un documento Word»
    if (s && !/\.[a-z]{2,}$/i.test(s)) return s.replace(/\s*·\s*/g, ', ');    // ya es un nombre (p. ej. «Espinof · MSN»)
    const partes = host(it.url).split('.').filter(x => !/^(www|m|es|en|amp)$/.test(x));
    for (const x of partes) if (SITIOS[x]) return SITIOS[x];
    const base = partes.length > 1 ? partes[partes.length - 2] : partes[0] || '';
    if (!base || base.length > 12 || /\d/.test(base)) return '';             // nombres largos pegados se oyen mal: mejor no decirlo
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const FOTO = { es: 'Imagen: ', en: 'Image: ', pt: 'Imagem: ', fr: 'Image : ', it: 'Immagine: ', de: 'Bild: ' };
  const FIN = { es: 'Terminaste tu cola de lectura.', en: 'You finished your reading queue.', pt: 'Você terminou sua fila de leitura.', fr: 'Vous avez terminé votre file de lecture.', it: 'Hai finito la tua coda di lettura.', de: 'Du hast deine Leseliste beendet.' };
  const destino = () => E.ajustes.idioma || 'orig';
  const necesitaTrad = it => destino() !== 'orig' && it.parrafos && (it.lang || 'es') !== destino();
  /** Texto a mostrar y leer: el traducido si corresponde y ya está listo; si no, el original. */
  function textoDe(it, verOrig) {
    if (!verOrig && necesitaTrad(it) && it.trad && it.trad.a === destino()) return { titulo: it.trad.titulo, parrafos: it.trad.parrafos, lang: destino(), traducido: true };
    return { titulo: it.titulo, parrafos: it.parrafos || [], lang: it.lang || 'es', traducido: false };
  }
  const traduciendo = new Map();
  function asegurarTraduccion(it) {
    if (!necesitaTrad(it) || (it.trad && it.trad.a === destino())) return Promise.resolve();
    const a = destino(), k = it.id + '|' + a;
    if (traduciendo.has(k)) return traduciendo.get(k);
    const pr = fetch('/api/traducir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, parrafos: [it.titulo].concat(it.parrafos.map(p => p.t || '…')) }) })
      .then(r => r.json()).then(d => {
        if (d.error) throw new Error(d.error);
        const [tit, ...resto] = d.parrafos;
        it.trad = { a, titulo: tit || it.titulo, parrafos: it.parrafos.map((p, i) => p.img ? { t: p.t ? (resto[i] || p.t) : '', h: 0, img: p.img } : { t: resto[i] || p.t, h: p.h }) };
        guardar(); if (viendoId === it.id) mostrar(it.id); pintar();
      }).catch(e => { toast('No se pudo traducir: ' + (e.message || 'error')); })
      .finally(() => traduciendo.delete(k));
    traduciendo.set(k, pr); return pr;
  }

  /** Estado de cada lectura, a la vista: Leída, Leyendo, A medias o Pendiente. */
  function insignia(it) {
    if (it.estado === 'leido') return '<span class="est est-leida">✓ Leída</span>';
    if (it.id === E.actualId && reproduciendo && !pausado) return '<span class="est est-leyendo">🔊 Leyendo</span>';
    if (it.pos) { const n = (it.parrafos || []).length || 1; return `<span class="est est-medias">◐ A medias · ${Math.min(99, Math.round(100 * it.pos / n))} %</span>`; }
    return '<span class="est est-pend">○ Pendiente</span>';
  }

  // ------------------------------------------------------------ pintar la cola
  function pintar() {
    const cola = $('cola'), vid = E.vista === 'videos', ver = E.cola.filter(it => esVideoIt(it) === vid);
    const nL = E.cola.filter(x => !esVideoIt(x) && x.estado !== 'leido').length, nV = E.cola.filter(x => esVideoIt(x) && x.estado !== 'leido').length;
    $('n-lec').textContent = nL ? '(' + nL + ')' : ''; $('n-vid').textContent = nV ? '(' + nV + ')' : '';
    document.querySelectorAll('#vista-cola button').forEach(b => b.classList.toggle('act', b.dataset.v === (vid ? 'videos' : 'lecturas')));
    $('cola-vacia').hidden = ver.length > 0;
    $('cola-vacia').textContent = vid ? 'No hay videos. Pega enlaces de YouTube, Vimeo, TikTok, Facebook o Instagram en ➕ Agregar.' : 'Tu cola está vacía. Agrega enlaces o un sitio completo para empezar a escuchar.';
    cola.innerHTML = ver.map((it, i) => {
      const est = it.tipo === 'video' && it.estado !== 'cargando' ? `${insigniaVideo(it)} ${esc(it.sitio || '')}${it.autor ? ' · ' + esc(it.autor) : ''}${it.dur ? ' · ' + fmtDur(it.dur) : ''}`
        : it.estado === 'cargando' ? '<span class="cargando"></span> ' + esc(it.progreso || 'Preparando…')
        : it.estado === 'error' ? `<span class="err">⚠ ${esc(it.error)}</span>${it.archivo ? '' : ` <button class="txt" data-reintentar="${it.id}">🔄 Reintentar</button>`}`
        : it.estado === 'portada' ? `<span class="aviso-portada">📰 Portada del sitio · <button class="txt" data-portada="${it.id}">Elegir artículos</button> <button class="txt" data-portada-leer="${it.id}">Leerla igual</button></span>`
        : `${insignia(it)} ${esc(it.sitio || host(it.url))} · ${fmtMin(min(it.palabras || 0))}`;
      return `<li class="item${it.id === E.actualId ? ' actual' : ''}${it.estado === 'leido' ? ' leido' : ''}" draggable="true" data-id="${it.id}">
        <span class="num">${i + 1}</span>
        <div class="item-txt" data-ver="${it.id}">${it.tipo === 'video' && it.mini ? `<img class="mini" src="${esc(it.mini)}" alt="" loading="lazy">` : ''}<div class="item-tit">${esc((it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url))}</div><div class="item-sub">${est}</div></div>
        <div class="item-acc">
          <button data-play="${it.id}" title="Escuchar desde aquí">▶</button>
          <button data-sube="${it.id}" title="Subir">↑</button>
          <button data-baja="${it.id}" title="Bajar">↓</button>
          ${it.tipo === 'video' ? `<button data-visto="${it.id}" title="${it.estado === 'leido' ? 'Marcar como no visto' : 'Marcar como visto'}"${it.estado === 'leido' ? ' class="visto-on"' : ''}>✓</button>` : ''}
          <button data-quitar="${it.id}" title="Quitar">✕</button>
        </div></li>`;
    }).join('');
    const t = tiempos(), pend = E.cola.filter(x => x.estado !== 'leido' && x.estado !== 'error' && x.estado !== 'portada').length;
    const fin = new Date(Date.now() + t.falta * 60000).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' });
    if (vid) { $('resumen').innerHTML = ver.length ? `<div><b>${nV}</b><span>videos por ver</span></div><div><b>${ver.length - nV}</b><span>vistos</span></div>` : ''; pintarReproductor(); return; }
    $('resumen').innerHTML = E.cola.length ? `<div><b>${pend}</b><span>por escuchar</span></div><div><b>${fmtMin(t.total)}</b><span>tiempo total</span></div><div><b>${fmtMin(t.falta)}</b><span>faltan · fin ${esc(fin)}</span></div>` : '';
    pintarReproductor();
  }
  function pintarReproductor() {
    const it = item(E.actualId), t = tiempos();
    $('b-play').textContent = reproduciendo && !pausado ? '⏸' : '▶';
    $('b-vel').textContent = String(vel()).replace('.', ',') + '×';
    if (!it) { $('rep-tit').textContent = 'ReadPage'; $('rep-sub').textContent = E.cola.length ? 'Pulsa ▶ para empezar' : 'Agrega lecturas para empezar'; $('rep-barra').style.width = '0'; return; }
    const enVideo = it.tipo === 'video';
    $('b-ant').innerHTML = enVideo ? '⏪<span class="et"> 10 s</span>' : '⏮<span class="et"> Párrafo</span>';
    $('b-sig').innerHTML = enVideo ? '<span class="et">10 s </span>⏩' : '<span class="et">Párrafo </span>⏭';
    $('b-ant').title = enVideo ? 'Atrasar 10 segundos' : 'Párrafo anterior'; $('b-sig').title = enVideo ? 'Adelantar 10 segundos' : 'Párrafo siguiente';
    $('b-ant-lec').title = enVideo ? 'Video anterior' : 'Lectura anterior'; $('b-sig-lec').title = enVideo ? 'Siguiente video' : 'Siguiente lectura';
    if (it.tipo === 'video') {
      const vs = E.cola.filter(esVideoIt);
      $('rep-tit').textContent = it.titulo || bonita(it.url);
      $('rep-sub').textContent = `🎬 Video ${vs.indexOf(it) + 1} de ${vs.length}${it.autor ? ' · ' + it.autor : ''}`;
      return;
    }
    const n = indice(it.id) + 1, tot = it.parrafos ? it.parrafos.length : 0;
    $('rep-tit').textContent = (it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url);
    $('rep-sub').textContent = `Lectura ${n} de ${E.cola.length} · faltan ${fmtMin(t.actual)} de esta · ${fmtMin(t.falta)} en total`;
    $('rep-barra').style.width = tot ? Math.round(100 * (it.pos || 0) / tot) + '%' : '0';
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = new MediaMetadata({ title: (it.parrafos ? textoDe(it).titulo : it.titulo) || '', artist: it.sitio || '', album: 'ReadPage', artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] }); } catch (_) {} }
  }

  // ------------------------------------------------------------ mostrar el texto
  let verOriginal = false;
  function mostrar(id) {
    const it = item(id); if (id !== viendoId) verOriginal = false; viendoId = id;
    if (!it) { $('lector-cab').innerHTML = '<p class="vacio">Elige una lectura de la cola y pulsa ▶.</p>'; $('texto').innerHTML = ''; return; }
    const tx = it.parrafos ? textoDe(it, verOriginal) : { titulo: it.titulo, parrafos: [] };
    const etTrad = it.parrafos && necesitaTrad(it) ? (it.trad && it.trad.a === destino()
      ? `<button class="txt" id="b-original">${verOriginal ? '🌐 Ver traducción' : '📄 Ver original'}</button>`
      : '<span><span class="cargando"></span> Traduciendo…</span>') : '';
    $('lector-cab').innerHTML = `<h1>${esc(tx.titulo || bonita(it.url))}</h1><div class="meta"><span>${esc(it.sitio || host(it.url))}</span>${it.autor ? `<span>${esc(it.autor)}</span>` : ''}<span>${it.tipo === 'video' ? '🎬 ' + (it.dur ? fmtDur(it.dur) : 'Video') : fmtMin(min(it.palabras || 0)) + ' de lectura'}</span>${it.archivo ? '' : `<a href="${esc(it.url)}" target="_blank" rel="noopener">Abrir original ↗</a>`}${etTrad}</div>`;
    const bo = $('b-original'); if (bo) bo.onclick = () => { verOriginal = !verOriginal; mostrar(it.id); };
    $('video-caja').hidden = !(vp && it.id === vpId); $('video-nota').hidden = !(vp && it.id === vpId && $('video-nota').textContent);
    if (it.tipo === 'video') {
      $('texto').innerHTML = it.id === vpId ? '' : `<p class="vacio">${it.mini ? `<img src="${esc(it.mini)}" alt="" style="max-width:100%;border-radius:12px;display:block;margin:0 auto 10px">` : ''}<button class="prim" data-play="${it.id}">▶ Ver este video</button></p>`;
      return;
    }
    if (it.estado === 'cargando') { $('texto').innerHTML = `<p class="vacio"><span class="cargando"></span> ${esc(it.progreso || 'Preparando el texto…')}</p>`; return; }
    if (it.estado === 'error') { $('texto').innerHTML = `<p class="vacio">⚠ ${esc(it.error)}</p>`; return; }
    $('texto').innerHTML = '<p class="pista">Doble clic o doble toque en un párrafo para leer desde ahí.</p>' +
      tx.parrafos.map((p, i) => p.img
        ? `<figure data-i="${i}" class="foto"><img src="${esc(p.img)}" alt="${esc(p.t)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('figure').classList.add('rota')">${p.t ? `<figcaption>${esc(p.t)}</figcaption>` : ''}</figure>`
        : `<p data-i="${i}" class="${p.h ? 'h' : ''}">${esc(p.t)}</p>`).join('');
    marcar(it.id === E.actualId ? it.pos || 0 : -1, false);
  }
  function marcar(i, desplazar = true) {
    document.querySelectorAll('#texto .leyendo').forEach(p => p.classList.remove('leyendo'));
    const p = document.querySelector(`#texto [data-i="${i}"]`); if (!p) return;
    p.classList.add('leyendo');
    if (desplazar) {
      const r = p.getBoundingClientRect();
      if (r.top < 120 || r.bottom > window.innerHeight - 170) p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ------------------------------------------------------------ reproducción
  function listoSiguiente(desde) {
    if (soloIds) return siguienteDeSolo(false);
    for (let k = desde; k < E.cola.length; k++) { const it = E.cola[k]; if (it.tipo !== 'video' && it.estado === 'listo' && !(it.pos >= (it.parrafos || []).length)) return it; }
    return null;
  }
  function reproducir(id, desdeParrafo, sinPresentar) {
    { const v = id ? item(id) : (E.vista === 'videos' ? (esVideoIt(item(E.actualId)) ? item(E.actualId) : siguienteVideo(0)) : null);
      if (v && v.tipo === 'video') return reproducirVideo(v);
      if (!id && E.vista === 'videos') return toast('No hay videos pendientes.'); }
    if (!hayVoz) { toast('Este navegador no tiene lectura por voz.'); return; }
    let it = id ? item(id) : item(E.actualId);
    if (!it || it.estado === 'leido') it = listoSiguiente(it ? indice(it.id) : 0) || listoSiguiente(0);
    if (!it) { toast(E.cola.some(x => x.estado === 'cargando') ? 'Esperando a que se prepare el texto…' : 'No hay lecturas pendientes.'); return; }
    if (it.estado === 'cargando') { toast('Todavía se está preparando esa lectura.'); return; }
    if (it.estado === 'error') { toast('Esa lectura no se pudo preparar.'); return; }
    if (necesitaTrad(it) && !(it.trad && it.trad.a === destino())) {
      toast('Traduciendo la lectura…');
      const objetivo = it;
      asegurarTraduccion(objetivo).then(() => { if (objetivo.trad && objetivo.trad.a === destino()) reproducir(objetivo.id, desdeParrafo, sinPresentar); });
      return;
    }
    callar();
    const nueva = E.actualId !== it.id;
    E.actualId = it.id; if (desdeParrafo != null) it.pos = desdeParrafo;
    reproduciendo = true; pausado = false; mantenerPantalla(true);
    if (viendoId !== it.id) mostrar(it.id);
    guardar(); pintar();
    const presentar = !sinPresentar && E.ajustes.presentar && (nueva || desdeParrafo === 0) && (it.pos || 0) === 0;
    if (presentar) {
      const n = indice(it.id) + 1, tx = textoDe(it);
      const lp = destino() !== 'orig' ? destino() : 'es';                 // la presentación va en el idioma elegido (o en español)
      const txt = (FRASES[lp] || FRASES.es)(n, E.cola.length, tx.titulo, sitioHablado(it), durHablada(min(it.palabras || 0)));
      for (let k = it.pos || 0; k < (it.pos || 0) + 3 && k < tx.parrafos.length; k++) { const b = tx.parrafos[k]; if (b && b.t) anticipar(b.t, 'lec', tx.lang); }   // los 3 primeros se preparan mientras se presenta
      hablar(txt, 'pres', lp, () => leerParrafo(it));
    } else leerParrafo(it);
  }
  function leerParrafo(it) {
    if (E.actualId !== it.id) return;
    const i = it.pos || 0, tx = textoDe(it);
    if (i >= tx.parrafos.length) { terminar(it); return; }
    marcar(i); pintarReproductor();
    const blq = tx.parrafos[i], seguir = () => { it.pos = i + 1; guardar(); leerParrafo(it); };
    if (i >= tx.parrafos.length - 2) prepararSiguiente(it);                    // faltan 2 párrafos: la siguiente lectura se deja lista
    for (let k = i + 1; k <= i + 4 && k < tx.parrafos.length; k++) {            // los 4 siguientes se preparan mientras suena este (un párrafo corto ya no deja silencio)
      const b = tx.parrafos[k]; if (b.t) anticipar(b.img ? (FOTO[tx.lang] || FOTO.es) + b.t : b.t, 'lec', tx.lang);
    }
    if (blq.img) {
      const fig = document.querySelector(`#texto [data-i="${i}"]`);
      if (!blq.t || (fig && fig.classList.contains('rota'))) { const mio = turno; setTimeout(() => { if (mio === turno && reproduciendo && !pausado) seguir(); }, 1800); return; }
      hablar((FOTO[tx.lang] || FOTO.es) + blq.t, 'lec', tx.lang, seguir);
      return;
    }
    hablar(blq.t, 'lec', tx.lang, seguir);
  }
  // ¿Queda alguna lectura que todavía se está preparando (bajando el texto)?
  const preparando = () => E.cola.some(x => x.tipo !== 'video' && x.estado === 'cargando');
  let esperaSig = null;
  function esperarSiguiente(desde, intentos) {
    clearTimeout(esperaSig);
    const sig = listoSiguiente(desde) || listoSiguiente(0);
    if (sig) { reproducir(sig.id, 0); return; }
    if (preparando() && intentos < 90 && reproduciendo) {        // hasta 90 s esperando a que el texto llegue
      if (intentos === 0) toast('⏳ Preparando la siguiente lectura…');
      esperaSig = setTimeout(() => esperarSiguiente(desde, intentos + 1), 1000);
      return;
    }
    reproduciendo = false; mantenerPantalla(false); pintar();
    const lf = destino() !== 'orig' ? destino() : 'es';
    hablar(FIN[lf] || FIN.es, 'pres', lf, null);
  }
  /** Deja lista la siguiente lectura mientras termina la actual: su traducción (si hace falta) y la voz de su
      presentación y de su primer párrafo. Así el paso de una a otra es inmediato, sin silencios. */
  let preparadaId = null;
  function prepararSiguiente(it) {
    const sig = listoSiguiente(indice(it.id) + 1) || listoSiguiente(0);
    if (!sig || sig.id === it.id || preparadaId === sig.id + '|' + destino()) return;
    preparadaId = sig.id + '|' + destino();
    const seguir = () => {
      try {
        const tx = textoDe(sig), lp = destino() !== 'orig' ? destino() : 'es';
        if (E.ajustes.presentar && (sig.pos || 0) === 0) anticipar((FRASES[lp] || FRASES.es)(indice(sig.id) + 1, E.cola.length, tx.titulo, sitioHablado(sig), durHablada(min(sig.palabras || 0))), 'pres', lp);
        const p0 = tx.parrafos[sig.pos || 0]; if (p0 && p0.t) anticipar(p0.t, 'lec', tx.lang);
      } catch (_) {}
    };
    if (necesitaTrad(sig) && !(sig.trad && sig.trad.a === destino())) asegurarTraduccion(sig).then(seguir).catch(() => {});
    else seguir();
  }
  function terminar(it) {
    anotar(it, 100);
    it.estado = 'leido'; it.pos = 0; guardar();
    const sig = listoSiguiente(indice(it.id) + 1) || listoSiguiente(0);   // también las que quedaron sin leer más arriba
    if (sig) { reproducir(sig.id, 0); return; }
    if (preparando()) { esperarSiguiente(indice(it.id) + 1, 0); return; }
    reproduciendo = false; mantenerPantalla(false); pintar();
    const lf = destino() !== 'orig' ? destino() : 'es';
    hablar(FIN[lf] || FIN.es, 'pres', lf, null);
  }
  function pausarOSeguir() {
    if (vp && esVideoIt(item(E.actualId))) { alternarVideo(); return; }
    if (!reproduciendo) { reproducir(); return; }
    if (pausado) {
      pausado = false;
      if (audioEnCurso && A.src && A.paused && !A.ended) A.play().catch(() => reproducir(E.actualId));   // sigue justo donde iba
      else reproducir(E.actualId);                                                                       // retoma desde el párrafo actual
    } else {
      pausado = true;
      if (audioEnCurso) { pausaNuestra = true; A.pause(); } else callar();
      mantenerPantalla(false);
    }
    pintarReproductor(); pintar();
  }
  function saltarParrafo(d) {
    if (vp && esVideoIt(item(E.actualId))) return moverVideo(d * 10);
    const it = item(E.actualId); if (!it || !it.parrafos) return;
    it.pos = Math.max(0, Math.min(it.parrafos.length - 1, (it.pos || 0) + d));
    guardar();
    if (reproduciendo && !pausado) { callar(); leerParrafo(it); } else { if (audioEnCurso) callar(); marcar(it.pos); pintarReproductor(); }
  }
  function siguienteLectura() {
    const it = item(E.actualId); if (!it) return reproducir();
    if (it.tipo === 'video') return finVideo(it.id, true);
    callar(); if (it.estado !== 'leido') anotar(it, Math.round(100 * (it.pos || 0) / Math.max(1, (it.parrafos || []).length)));
    it.estado = 'leido'; it.pos = 0; guardar();
    const sig = listoSiguiente(indice(it.id) + 1) || listoSiguiente(0);
    if (sig) reproducir(sig.id, 0);
    else if (preparando()) esperarSiguiente(indice(it.id) + 1, 0);
    else { reproduciendo = false; pintar(); toast('No hay más lecturas en la cola.'); }
  }

  function lecturaAnterior() {
    const k = E.actualId ? indice(E.actualId) : E.cola.length, deVideo = esVideoIt(item(E.actualId)) || (!E.actualId && E.vista === 'videos');
    let ant = null;
    for (let j = k - 1; j >= 0; j--) { const x = E.cola[j]; if ((x.tipo === 'video') === deVideo && (x.estado === 'listo' || x.estado === 'leido')) { ant = x; break; } }
    if (!ant) return toast(k > 0 || E.actualId ? 'Esta es la primera lectura de la cola.' : 'No hay lecturas anteriores.');
    callar(); ant.estado = 'listo'; ant.pos = 0; guardar();
    reproducir(ant.id, 0);
  }

  // ------------------------------------------------------------ historial (lo leído) y papelera (lo borrado)
  // Copia liviana: de las páginas web se guarda solo el enlace (el texto se vuelve a bajar al restaurar);
  // de los archivos sí se guarda el texto, porque el archivo ya no está.
  const copia = it => { const c = Object.assign({}, it); delete c.trad; delete c.progreso; if (!c.archivo) { delete c.parrafos; delete c.portada; c.estado = 'cargando'; } return c; };
  /** Anota en el historial una lectura terminada (o saltada, con el % que se escuchó). */
  function anotar(it, pct) {
    E.historial = E.historial || [];
    E.historial.unshift({ cuando: new Date().toISOString(), pct, titulo: (it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url), sitio: it.sitio || host(it.url), url: it.url, archivo: !!it.archivo, it: copia(it) });
    if (E.historial.length > 500) E.historial.length = 500;
  }
  function alPapelera(items) {
    E.papelera = E.papelera || [];
    items.forEach(it => E.papelera.unshift({ cuando: new Date().toISOString(), it: copia(it) }));
    const limite = Date.now() - 60 * 86400000;                       // se guardan 60 días (y hasta 300)
    E.papelera = E.papelera.filter(x => Date.parse(x.cuando) > limite).slice(0, 300);
  }
  /** Vuelve a poner una lectura en la cola (desde el historial o la papelera). */
  function reponer(it) {
    const n = Object.assign(copia(it), { id: nuevoId(), pos: 0 });
    if (n.archivo) n.url = 'archivo:' + n.id;
    else if (E.cola.some(x => x.url === n.url)) return false;
    if (n.estado === 'leido' || n.estado === 'cargando') n.estado = n.parrafos ? 'listo' : 'cargando';
    E.cola.push(n);
    if (n.estado === 'cargando' && !n.archivo) encolarCarga(n);
    return true;
  }
  const fechaHora = iso => {
    const d = new Date(iso), hoy = new Date(), ayer = new Date(Date.now() - 86400000);
    const dia = d.toDateString() === hoy.toDateString() ? 'Hoy' : d.toDateString() === ayer.toDateString() ? 'Ayer' : d.toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() !== hoy.getFullYear() ? 'numeric' : undefined });
    return { dia, hora: d.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit' }) };
  };
  let restaurar = new Set();
  function pintarHistorial() {
    const H = E.historial || [], P = E.papelera || [];
    let dia = '';
    $('dh-lista-l').innerHTML = H.length ? H.map((h, k) => {
      const f = fechaHora(h.cuando), cab = f.dia !== dia ? `<li class="dia">${esc(f.dia)}</li>` : ''; dia = f.dia;
      const est = h.pct >= 100 ? '<span class="est est-leida">✓ Completa</span>' : `<span class="est est-medias">◐ ${h.pct || 0} %</span>`;
      return `${cab}<li><span class="hora">${esc(f.hora)}</span><div><b>${esc(h.titulo)}</b><span class="est-linea">${est} ${esc(h.sitio || '')}</span></div><button type="button" class="txt" data-rehist="${k}" title="Volver a la cola">↺</button></li>`;
    }).join('') : '<li class="vacio">Todavía no has terminado ninguna lectura.</li>';
    $('dh-cuenta-l').textContent = H.length ? `${H.length} lectura${H.length > 1 ? 's' : ''}` : '';
    dia = '';
    $('dh-lista-p').innerHTML = P.length ? P.map((x, k) => {
      const f = fechaHora(x.cuando), cab = f.dia !== dia ? `<li class="dia">Borradas · ${esc(f.dia)}</li>` : ''; dia = f.dia;
      return `${cab}<li><input type="checkbox" data-rp="${k}" ${restaurar.has(k) ? 'checked' : ''}><span class="hora">${esc(f.hora)}</span><div><b>${esc((x.it.parrafos ? textoDe(x.it).titulo : x.it.titulo) || bonita(x.it.url))}</b><span class="est-txt">${esc(x.it.sitio || host(x.it.url))}</span></div></li>`;
    }).join('') : '<li class="vacio">La papelera está vacía.</li>';
    const n = restaurar.size;
    $('dh-cuenta-p').textContent = P.length ? `${n} de ${P.length}` : '';
    $('dh-restaurar').disabled = !n;
    $('dh-restaurar').textContent = !n ? 'Marca lo que quieres recuperar' : n === P.length ? `↺ Restaurar todo (${n})` : `↺ Restaurar ${n} seleccionada${n > 1 ? 's' : ''}`;
    $('dh-vaciar').hidden = !P.length;
  }
  function verPestanaHist(t) {
    document.querySelectorAll('#dh-tabs button').forEach(b => b.classList.toggle('act', b.dataset.h === t));
    $('dh-leidas').hidden = t !== 'leidas'; $('dh-papelera').hidden = t !== 'papelera';
  }
  $('b-historial').addEventListener('click', () => { restaurar = new Set(); pintarHistorial(); verPestanaHist((E.papelera || []).length && !(E.historial || []).length ? 'papelera' : 'leidas'); $('d-historial').showModal(); });
  document.querySelectorAll('#dh-tabs button').forEach(b => b.addEventListener('click', () => verPestanaHist(b.dataset.h)));
  $('dh-lista-l').addEventListener('click', e => {
    const b = e.target.closest('[data-rehist]'); if (!b) return;
    const h = E.historial[+b.dataset.rehist]; if (!h) return;
    if (reponer(h.it || { url: h.url, titulo: h.titulo, estado: 'cargando' })) { guardar(); pintar(); toast('Volvió a tu cola: ' + h.titulo); } else toast('Esa lectura ya está en tu cola.');
  });
  $('dh-lista-p').addEventListener('change', e => { const k = e.target.dataset.rp; if (k == null) return; e.target.checked ? restaurar.add(+k) : restaurar.delete(+k); pintarHistorial(); });
  $('dh-todas').addEventListener('click', () => { restaurar = new Set((E.papelera || []).map((_, k) => k)); pintarHistorial(); });
  $('dh-ninguna').addEventListener('click', () => { restaurar = new Set(); pintarHistorial(); });
  $('dh-restaurar').addEventListener('click', () => {
    const P = E.papelera || [], elegidas = [...restaurar].sort((a, b) => b - a);   // de la más vieja a la más nueva, para respetar el orden
    let n = 0; elegidas.forEach(k => { if (P[k] && reponer(P[k].it)) n++; });
    E.papelera = P.filter((_, k) => !restaurar.has(k)); restaurar = new Set();
    guardar(); pintar(); pintarHistorial();
    toast(n ? `Se restauraron ${n} lectura${n > 1 ? 's' : ''} a tu cola.` : 'Esas lecturas ya estaban en tu cola.');
    if (!E.papelera.length) $('d-historial').close();
  });
  let confVaciar = false;
  $('dh-vaciar').addEventListener('click', () => {
    if (!confVaciar) { confVaciar = true; $('dh-vaciar').textContent = 'Toca otra vez: se borra para siempre'; setTimeout(() => { confVaciar = false; $('dh-vaciar').textContent = 'Vaciar papelera'; }, 4000); return; }
    E.papelera = []; restaurar = new Set(); confVaciar = false; $('dh-vaciar').textContent = 'Vaciar papelera'; guardar(); pintarHistorial(); toast('Papelera vaciada.');
  });
  let confHist = false;
  $('dh-borrar-hist').addEventListener('click', () => {
    if (!confHist) { confHist = true; $('dh-borrar-hist').textContent = 'Toca otra vez para borrar el historial'; setTimeout(() => { confHist = false; $('dh-borrar-hist').textContent = 'Borrar historial'; }, 4000); return; }
    E.historial = []; confHist = false; $('dh-borrar-hist').textContent = 'Borrar historial'; guardar(); pintarHistorial(); toast('Historial borrado.');
  });

  // ------------------------------------------------------------ eventos: cola
  $('cola').addEventListener('click', e => {
    const b = e.target.closest('button'), ver = e.target.closest('[data-ver]');
    if (b && b.dataset.play) { soloIds = null; const it = item(b.dataset.play); if (it && it.estado === 'leido') { it.estado = 'listo'; it.pos = 0; } reproducir(b.dataset.play); irA('lector'); return; }
    if (b && (b.dataset.sube || b.dataset.baja)) { const id = b.dataset.sube || b.dataset.baja, i = indice(id), paso = b.dataset.sube ? -1 : 1, tv = esVideoIt(item(id)); let j = i + paso; while (j >= 0 && j < E.cola.length && esVideoIt(E.cola[j]) !== tv) j += paso; if (j < 0 || j >= E.cola.length) return; const [x] = E.cola.splice(i, 1); E.cola.splice(j, 0, x); guardar(); pintar(); return; }
    if (b && b.dataset.reintentar) { reintentar(item(b.dataset.reintentar)); guardar(); pintar(); return; }
    if (b && b.dataset.visto) { const it = item(b.dataset.visto); if (!it) return; if (it.estado === 'leido') { it.estado = 'listo'; toast('Marcado como no visto.'); } else { marcarVisto(it); toast('✓ Marcado como visto.'); } guardar(); pintar(); return; }
    if (b && b.dataset.quitar) { const id = b.dataset.quitar; if (id === E.actualId) { callar(); reproduciendo = false; E.actualId = null; mantenerPantalla(false); } alPapelera(E.cola.splice(indice(id), 1)); if (viendoId === id) mostrar(null); guardar(); pintar(); toast('Se quitó de la cola. Puedes recuperarla en 🕘 Historial → Papelera.'); return; }
    if (b && b.dataset.portada) { const it = item(b.dataset.portada); if (it) buscarSitio(it.url); return; }
    if (b && b.dataset.portadaLeer) { const it = item(b.dataset.portadaLeer); if (it && it.portada) { const d = it.portada; delete it.portada; it.portadaOk = true; Object.assign(it, { estado: 'listo', lang: (d.lang || 'es').slice(0, 2), autor: d.autor, parrafos: d.parrafos, palabras: d.palabras, error: '' }); guardar(); pintar(); asegurarTraduccion(it); } return; }
    if (ver) { mostrar(ver.dataset.ver); irA('lector'); }
  });
  // Arrastrar para reordenar (computadora).
  let arrastrado = null;
  $('cola').addEventListener('dragstart', e => { const li = e.target.closest('.item'); if (!li) return; arrastrado = li.dataset.id; li.classList.add('arrastrando'); e.dataTransfer.effectAllowed = 'move'; });
  $('cola').addEventListener('dragover', e => { e.preventDefault(); document.querySelectorAll('.item.sobre').forEach(x => x.classList.remove('sobre')); const li = e.target.closest('.item'); if (li && li.dataset.id !== arrastrado) li.classList.add('sobre'); });
  $('cola').addEventListener('drop', e => { e.preventDefault(); const li = e.target.closest('.item'); if (!li || !arrastrado) return; const i = indice(arrastrado), j = indice(li.dataset.id); const [x] = E.cola.splice(i, 1); E.cola.splice(j, 0, x); guardar(); pintar(); });
  $('cola').addEventListener('dragend', () => { arrastrado = null; pintar(); });
  // Limpiar: todo, solo lo escuchado o lo que se marque. Lo demás se queda guardado.
  let aQuitar = new Set(), confirmando = false;
  function pintarLimpiar() {
    $('dl-lista').innerHTML = E.cola.map((it, i) => {
      const est = it.estado === 'leido' ? '✓ escuchada' : it.estado === 'error' ? '⚠ con error' : it.estado === 'cargando' ? 'preparándose' : (it.pos ? 'a medias' : 'sin escuchar');
      return `<li><input type="checkbox" data-q="${it.id}" ${aQuitar.has(it.id) ? 'checked' : ''}><span class="num">${i + 1}</span><div><b>${esc((it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url))}</b><span class="est-txt">${esc(it.sitio || host(it.url))} · ${est}</span></div></li>`;
    }).join('');
    const n = aQuitar.size, todas = n && n === E.cola.length;
    $('dl-cuenta').textContent = `${n} de ${E.cola.length}`;
    confirmando = false;
    $('dl-quitar').disabled = !n;
    $('dl-quitar').textContent = !n ? 'Marca lo que quieres quitar' : todas ? '🗑️ Vaciar toda la cola' : `Quitar ${n} seleccionada${n > 1 ? 's' : ''}`;
  }
  $('b-vaciar').addEventListener('click', () => {
    if (!E.cola.length) return toast('Tu cola ya está vacía.');
    aQuitar = new Set(E.cola.filter(x => x.estado === 'leido').map(x => x.id));    // de entrada, marcadas las ya escuchadas
    pintarLimpiar(); $('d-limpiar').showModal();
  });
  $('dl-lista').addEventListener('change', e => { const id = e.target.dataset.q; if (!id) return; e.target.checked ? aQuitar.add(id) : aQuitar.delete(id); pintarLimpiar(); });
  $('dl-todas').addEventListener('click', () => { aQuitar = new Set(E.cola.map(x => x.id)); pintarLimpiar(); });
  $('dl-leidas').addEventListener('click', () => { aQuitar = new Set(E.cola.filter(x => x.estado === 'leido').map(x => x.id)); pintarLimpiar(); if (!aQuitar.size) toast('No hay lecturas escuchadas.'); });
  $('dl-ninguna').addEventListener('click', () => { aQuitar = new Set(); pintarLimpiar(); });
  $('dl-quitar').addEventListener('click', () => {
    const n = aQuitar.size; if (!n) return;
    if (!confirmando) { confirmando = true; $('dl-quitar').textContent = `Toca otra vez para confirmar (${n === E.cola.length ? 'se vacía toda la cola' : 'se quitan ' + n})`; return; }
    if (aQuitar.has(E.actualId)) { callar(); reproduciendo = false; pausado = false; E.actualId = null; mantenerPantalla(false); }
    alPapelera(E.cola.filter(x => aQuitar.has(x.id)));
    E.cola = E.cola.filter(x => !aQuitar.has(x.id));
    if (viendoId && !item(viendoId)) mostrar(E.cola[0] ? E.cola[0].id : null);
    guardar(); pintar(); pintarReproductor(); $('d-limpiar').close();
    toast((E.cola.length ? `Se quitaron ${n} lectura${n > 1 ? 's' : ''}.` : 'La cola quedó vacía.') + ' Puedes recuperarlas en 🕘 Historial → Papelera.');
  });

  // Doble clic / doble toque en un párrafo: leer desde ahí.
  let ultDesde = 0;
  function desdeAqui(p) {
    if (!p || p.dataset.i == null || !viendoId) return;
    const ahora = Date.now(); if (ahora - ultDesde < 700) return;      // el doble toque del celular también dispara «doble clic»: una sola orden
    ultDesde = ahora;
    try { getSelection().removeAllRanges(); } catch (_) {}
    const it = item(viendoId); if (it && it.estado === 'leido') it.estado = 'listo';
    marcar(Number(p.dataset.i));                                         // se ve al instante dónde va a leer
    reproducir(viendoId, Number(p.dataset.i), true);                     // directo al párrafo, sin presentación
  }
  $('texto').addEventListener('dblclick', e => desdeAqui(e.target.closest('[data-i]')));
  $('texto').addEventListener('click', e => { const b = e.target.closest('[data-play]'); if (!b) return; soloIds = null; const it = item(b.dataset.play); if (it && it.estado === 'leido') { it.estado = 'listo'; it.pos = 0; } reproducir(b.dataset.play); });
  let tq = 0, tqEl = null;
  let tx0 = 0, ty0 = 0;
  $('texto').addEventListener('touchstart', e => { const t = e.touches[0]; tx0 = t.clientX; ty0 = t.clientY; }, { passive: true });
  $('texto').addEventListener('touchend', e => {
    const c = e.changedTouches[0]; if (Math.abs(c.clientX - tx0) > 12 || Math.abs(c.clientY - ty0) > 12) { tq = 0; return; }   // fue un desplazamiento
    const p = e.target.closest('[data-i]'), t = Date.now();
    if (p && p === tqEl && t - tq < 400) { e.preventDefault(); desdeAqui(p); tq = 0; return; }
    tq = t; tqEl = p;
  }, { passive: false });

  // ------------------------------------------------------------ eventos: agregar
  document.querySelectorAll('#p-agregar .seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#p-agregar .seg button').forEach(x => x.classList.toggle('act', x === b));
    ['links', 'archivos', 'sitio'].forEach(t => { $('t-' + t).hidden = b.dataset.t !== t; });
  }));
  // 📋 Pegar automático: botón → lee clipboard → detecta → agrega → fin
  let modalPegar = null;
  $('b-agregar').addEventListener('click', () => {
    if (!modalPegar) {
      modalPegar = document.createElement('dialog');
      const html = esMobil
        ? `<div style="padding:15px"><textarea id="ta-pegar" style="width:100%;height:80px;padding:10px;font-size:14px;border:1px solid var(--borde);border-radius:8px;background:var(--bg3);color:var(--txt)" placeholder="Pega aquí..." autofocus></textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><button id="btn-lectura" style="padding:10px;border:1px solid var(--borde);background:var(--bg3);color:var(--txt);border-radius:8px;font-weight:800">📚 Lectura</button><button id="btn-video" style="padding:10px;border:1px solid var(--borde);background:var(--bg3);color:var(--txt);border-radius:8px;font-weight:800">🎬 Video</button></div></div>`
        : `<textarea id="ta-pegar" style="width:100%;height:80px;padding:10px;font-size:14px;border:1px solid var(--borde);border-radius:8px;background:var(--bg3);color:var(--txt)" placeholder="Pega aquí..." autofocus></textarea>`;
      modalPegar.innerHTML = html;
      modalPegar.style.cssText = 'border:1px solid var(--borde);border-radius:12px;padding:15px;background:var(--bg2);color:var(--txt);max-width:400px;width:min(400px,calc(100vw-30px))';
      document.body.appendChild(modalPegar);
      const ta = modalPegar.querySelector('#ta-pegar');

      const procesar = async (forzarTipo) => {
        if (!ta.value?.trim()) return;
        let urls = sacarUrls(ta.value);
        if (!urls.length) return;
        if (forzarTipo) {
          const tipos = await Promise.all(urls.map(u => detectarTipo(u)));
          urls = urls.filter((u, i) => forzarTipo === 'lectura' ? tipos[i].tipo !== 'video' : tipos[i].tipo === 'video');
        }
        if (!urls.length) { toast('No hay ' + (forzarTipo === 'lectura' ? 'lecturas' : 'videos')); return; }
        const { n, listas } = await agregarTodo(urls);
        if (listas && !n) return;
        toast(n ? `${n} agregad${n > 1 ? 'as' : 'a'} a la cola.` : 'Ya estaban en la cola.');
        modalPegar.close();
        irA('cola');
      };

      if (esMobil) {
        ta.addEventListener('input', () => procesar(null));
        modalPegar.querySelector('#btn-lectura').addEventListener('click', () => procesar('lectura'));
        modalPegar.querySelector('#btn-video').addEventListener('click', () => procesar('video'));
      } else {
        ta.addEventListener('input', () => procesar(null));
      }
      modalPegar.addEventListener('close', () => { ta.value = ''; });
    }
    modalPegar.showModal();
    modalPegar.querySelector('#ta-pegar').focus();
  });
  $('in-archivos').accept = window.RPArchivos ? window.RPArchivos.ACEPTA : '';
  $('in-archivos').addEventListener('change', e => { agregarArchivos(e.target.files); e.target.value = ''; });
  $('in-camara').addEventListener('change', e => { agregarArchivos(e.target.files); e.target.value = ''; });
  $('b-camara').addEventListener('click', () => $('in-camara').click());
  // Arrastrar y soltar archivos en cualquier parte de la app.
  let arrastres = 0;
  const conArchivos = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', e => { if (!conArchivos(e)) return; e.preventDefault(); arrastres++; document.body.classList.add('soltando'); });
  window.addEventListener('dragover', e => { if (conArchivos(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!conArchivos(e)) return; if (--arrastres <= 0) { arrastres = 0; document.body.classList.remove('soltando'); } });
  window.addEventListener('drop', e => { if (!conArchivos(e)) return; e.preventDefault(); arrastres = 0; document.body.classList.remove('soltando'); agregarArchivos(e.dataTransfer.files); });
  // 📋 Pegar imagen: lee la imagen copiada. Si el navegador no deja leer el portapapeles, aparece un recuadro para pegarla a mano.
  const tactil = matchMedia('(pointer: coarse)').matches;
  $('zona-pegar').dataset.ayuda = tactil ? '📋 Mantén presionado aquí y toca «Pegar»' : '📋 Clic derecho aquí → Pegar (o Ctrl+V)';
  // En el recuadro solo se aceptan imágenes pegadas: cualquier texto escrito se borra.
  $('zona-pegar').addEventListener('keydown', e => { if (!(e.ctrlKey || e.metaKey) && e.key.length === 1) e.preventDefault(); });
  const imagenAArchivo = (blob, tipo) => new File([blob], 'Imagen pegada ' + new Date().toLocaleTimeString().replace(/:/g, '.') + '.' + ((tipo || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg'), { type: tipo || 'image/png' });
  $('b-pegar-img').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('sin acceso');
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const tipo = it.types.find(t => t.startsWith('image/'));
        if (tipo) { agregarArchivos([imagenAArchivo(await it.getType(tipo), tipo)]); irA('cola'); return; }
      }
      toast('No hay ninguna imagen copiada. Copia una imagen o captura y vuelve a tocar «Pegar imagen».');
    } catch (_) {
      const z = $('zona-pegar'); z.innerHTML = ''; z.focus(); z.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast(tactil ? 'Mantén presionado el recuadro de abajo y toca «Pegar».' : 'Haz clic derecho en el recuadro de abajo y elige «Pegar» (o Ctrl+V).');
    }
  });
  $('zona-pegar').addEventListener('paste', e => {
    e.preventDefault();
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => /^image\//.test(f.type));
    if (fs.length) { agregarArchivos(fs); $('zona-pegar').blur(); }
    else toast('Lo que pegaste no es una imagen. Copia una imagen o captura de pantalla.');
  });
  $('zona-pegar').addEventListener('input', () => {           // algunos teléfonos pegan la imagen como <img> en vez de archivo
    const im = $('zona-pegar').querySelector('img'); $('zona-pegar').innerHTML = '';
    if (!im || !im.src) return;
    fetch(im.src).then(r => r.blob()).then(b => { agregarArchivos([imagenAArchivo(b, b.type)]); $('zona-pegar').blur(); })
      .catch(() => toast('No se pudo tomar esa imagen. Prueba guardándola y usando «Toca para elegir archivos».'));
  });
  // Pegar una imagen (captura de pantalla) con Ctrl+V.
  document.addEventListener('paste', e => {
    if (e.target && e.target.id === 'zona-pegar') return;
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (fs.length) { e.preventDefault(); agregarArchivos(fs); }
  });
  let paginas = [];
  $('b-sitio').addEventListener('click', () => {
    const u = $('in-sitio').value.trim(); if (!u) return toast('Escribe la dirección del sitio.');
    buscarSitio(sacarUrls(u)[0] || u);
  });
  // 📋 Pegar (sitio web): trae la dirección copiada y busca sus páginas al momento, sin tocar el recuadro.
  $('b-pegar-sitio').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      const u = sacarUrls(t || '')[0] || (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test((t || '').trim()) ? (t || '').trim() : '');
      if (!u) return toast(t && t.trim() ? 'Lo copiado no es la dirección de un sitio (ej.: https://listindiario.com).' : 'No hay nada copiado.');
      $('in-sitio').value = u; buscarSitio(u);
    } catch (_) {
      $('in-sitio').focus();
      toast(tactil ? 'Mantén presionado el recuadro y toca «Pegar»: la búsqueda empieza sola.' : 'Haz clic derecho en el recuadro y elige «Pegar» (o Ctrl+V): la búsqueda empieza sola.');
    }
  });
  // Si se pega a mano en el recuadro, también busca solo.
  $('in-sitio').addEventListener('paste', () => setTimeout(() => {
    const v = $('in-sitio').value.trim(), u = sacarUrls(v)[0] || v;
    if (u && !$('b-sitio').disabled) buscarSitio(u);
  }, 30));
  $('in-sitio').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('b-sitio').click(); } });
  async function buscarSitio(u, aviso) {
    const b = $('b-sitio'); b.disabled = true; b.textContent = '⏳ Buscando páginas…';
    toast(aviso || '⏳ Buscando las noticias y páginas del sitio…');
    try {
      const r = await fetch('/api/sitio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
      const d = await r.json(); if (d.error) throw new Error(d.error);
      paginas = d.paginas.map(p => ({ ...p, sel: d.paginas.length <= 20 }));          // con muchas (un periódico), ninguna marcada de entrada
      $('ds-tit').textContent = `${d.sitio} · ${d.paginas.length} página${d.paginas.length === 1 ? '' : 's'}${d.total > d.paginas.length ? ` (de ${d.total})` : ''}`;
      $('ds-buscar').value = ''; pintarPaginas(); $('d-sitio').showModal();
    } catch (e) { toast(e.message || 'No se pudo revisar ese sitio.'); }
    finally { b.disabled = false; b.textContent = '🔎 Buscar sus páginas'; }
  }
  function pintarPaginas() {
    const q = $('ds-buscar').value.trim().toLowerCase();
    $('ds-lista').innerHTML = paginas.map((p, i) => (!q || (p.titulo + ' ' + p.url).toLowerCase().includes(q)) ?
      `<li><input type="checkbox" data-k="${i}" ${p.sel ? 'checked' : ''}><div><b>${esc(p.titulo || bonita(p.url))}</b><small>${esc(bonita(p.url))}</small></div></li>` : '').join('');
    $('ds-cuenta').textContent = `${paginas.filter(p => p.sel).length} seleccionadas`;
  }
  $('ds-lista').addEventListener('change', e => { const k = e.target.dataset.k; if (k != null) { paginas[k].sel = e.target.checked; $('ds-cuenta').textContent = `${paginas.filter(p => p.sel).length} seleccionadas`; } });
  $('ds-buscar').addEventListener('input', pintarPaginas);
  $('ds-todas').addEventListener('click', () => { const q = $('ds-buscar').value.trim().toLowerCase(); paginas.forEach(p => { if (!q || (p.titulo + ' ' + p.url).toLowerCase().includes(q)) p.sel = true; }); pintarPaginas(); });
  $('ds-ninguna').addEventListener('click', () => { paginas.forEach(p => p.sel = false); pintarPaginas(); });
  $('ds-agregar').addEventListener('click', async () => {
    const sel = paginas.filter(p => p.sel); if (!sel.length) return toast('Marca al menos una página.');
    const n = await agregarUrls(sel.map(p => p.url), sel.map(p => p.titulo));
    const portadas = E.cola.filter(x => x.estado === 'portada').map(x => x.id);
    if (portadas.length) { E.cola = E.cola.filter(x => !portadas.includes(x.id)); guardar(); pintar(); }
    $('d-sitio').close(); toast(`${n} página${n === 1 ? '' : 's'} agregada${n === 1 ? '' : 's'} a la cola.`); irA('cola');
  });

  // ------------------------------------------------------------ compartir listas
  // Compartir: todas o las que se marquen, en el orden de la cola.
  let aCompartir = new Set();
  const compartibles = () => E.cola.filter(x => x.estado !== 'error' && x.estado !== 'cargando');
  function pintarCompartir() {
    const lista = compartibles();
    $('dc-lista').innerHTML = lista.map((it, i) => `<li><input type="checkbox" data-c="${it.id}" ${aCompartir.has(it.id) ? 'checked' : ''}><span class="num">${i + 1}</span><div><b>${esc((it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url))}</b><span class="est-linea">${insignia(it)} ${esc(it.sitio || host(it.url))}</span></div></li>`).join('');
    const sel = lista.filter(x => aCompartir.has(x.id)), docs = sel.filter(x => x.archivo).length, n = sel.length;
    $('dc-cuenta').textContent = `${n} de ${lista.length}`;
    $('dc-info').textContent = !n ? 'Marca al menos una lectura.' : `Se compartirán ${n} lectura${n > 1 ? 's' : ''} en este orden.` + (docs ? ` Los ${docs === 1 ? 'textos del archivo van' : 'textos de los ' + docs + ' archivos van'} dentro del enlace.` : '');
    $('dc-crear').disabled = !n;
    $('dc-crear').textContent = !n ? 'Marca qué compartir' : n === lista.length ? `🔗 Crear enlace con todas (${n})` : `🔗 Crear enlace con ${n} lectura${n > 1 ? 's' : ''}`;
  }
  $('dc-lista').addEventListener('change', e => { const id = e.target.dataset.c; if (!id) return; e.target.checked ? aCompartir.add(id) : aCompartir.delete(id); pintarCompartir(); });
  $('dc-todas').addEventListener('click', () => { aCompartir = new Set(compartibles().map(x => x.id)); pintarCompartir(); });
  $('dc-pend').addEventListener('click', () => { aCompartir = new Set(compartibles().filter(x => x.estado !== 'leido').map(x => x.id)); pintarCompartir(); if (!aCompartir.size) toast('No hay lecturas pendientes.'); });
  $('dc-ninguna').addEventListener('click', () => { aCompartir = new Set(); pintarCompartir(); });
  $('b-compartir').addEventListener('click', () => {
    const items = compartibles();
    if (!items.length) return toast('Agrega lecturas a la cola para poder compartirla.');
    aCompartir = new Set(items.map(x => x.id));                                  // de entrada, todas marcadas
    $('dc-elegir').hidden = false; pintarCompartir();
    $('dc-res').hidden = true; $('dc-crear').hidden = false; $('d-compartir').showModal(); $('dc-nombre').focus();
  });
  $('dc-crear').addEventListener('click', async () => {
    const items = compartibles().filter(x => aCompartir.has(x.id)).map(x => x.archivo
      ? { archivo: true, titulo: x.titulo, tipo: String(x.sitio || '').replace(/^📎\s*/, '').split(' · ')[0], lang: x.lang, parrafos: x.parrafos }
      : { url: x.url, titulo: x.titulo });
    if (!items.length) return toast('Marca al menos una lectura.');
    const b = $('dc-crear'); b.disabled = true;
    try {
      const r = await fetch('/api/lista', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: $('dc-nombre').value, items }) });
      const d = await r.json(); if (d.error) throw new Error(d.error);
      $('dc-link').value = location.origin + '/l/' + d.id; $('dc-res').hidden = false; b.hidden = true; $('dc-elegir').hidden = true;
      $('dc-info').textContent = `✅ Enlace listo con ${items.length} lectura${items.length > 1 ? 's' : ''}. Cópialo o envíalo por WhatsApp, correo o donde quieras.`;
      $('dc-enviar').hidden = !navigator.share;
    } catch (e) { toast(e.message || 'No se pudo crear el enlace.'); } finally { b.disabled = false; }
  });
  $('dc-copiar').addEventListener('click', () => { const v = $('dc-link').value; (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('Enlace copiado. Pégalo en WhatsApp, correo o donde quieras.'), () => { $('dc-link').select(); document.execCommand('copy'); toast('Enlace copiado.'); }); });
  $('dc-enviar').addEventListener('click', () => { navigator.share({ title: 'ReadPage · ' + ($('dc-nombre').value || 'Lista de lectura'), text: 'Escucha esta lista de lecturas en ReadPage:', url: $('dc-link').value }).catch(() => {}); });

  let recibida = null;
  async function abrirListaCompartida(id) {
    try {
      const r = await fetch('/api/lista/' + encodeURIComponent(id)); const d = await r.json(); if (d.error) throw new Error(d.error);
      recibida = d;
      $('dr-tit').textContent = '🎧 ' + d.nombre;
      $('dr-info').textContent = d.items.length > 1 ? `Te compartieron ${d.items.length} lecturas. ¿Las agregas a tu cola?` : 'Te compartieron 1 lectura. ¿La agregas a tu cola?';
      $('dr-lista').innerHTML = d.items.map((x, i) => `<li><span class="num">${i + 1}</span><div><b>${esc(x.titulo || bonita(x.url))}</b><small>${x.archivo ? '📎 ' + esc(x.tipo || 'Documento') : esc(bonita(x.url))}</small></div></li>`).join('');
      $('d-recibida').showModal();
    } catch (e) { toast(e.message || 'No se pudo abrir la lista.'); }
    history.replaceState(null, '', '/');
  }
  $('dr-agregar').addEventListener('click', () => { if (!recibida) return; const n = agregarDeLista(recibida.items); $('d-recibida').close(); toast(`${n} lectura${n === 1 ? '' : 's'} agregada${n === 1 ? '' : 's'}.`); irA('cola'); });
  $('dr-reemplazar').addEventListener('click', () => { if (!recibida) return; callar(); reproduciendo = false; E.cola = []; E.actualId = null; mostrar(null); agregarDeLista(recibida.items); $('d-recibida').close(); toast('Tu cola ahora es la lista compartida.'); irA('cola'); });

  document.querySelectorAll('#vista-cola button').forEach(b => b.addEventListener('click', () => { E.vista = b.dataset.v; guardar(); pintar(); }));

  // ------------------------------------------------------------ manos libres (hablarle a ReadPage)
  // Escucha solo mientras está encendido (botón 🎙️) y la app está abierta. Obedece únicamente las frases que
  // empiezan con la palabra de activación; «callar» y «descansar» son frases cortas aparte. Las tres se configuran.
  const ML_DEF = { activar: 'Lector', callar: 'Silencio', descansar: 'Descansa', confirmar: true };
  function ml() { E.ajustes.ml = Object.assign({}, ML_DEF, E.ajustes.ml || {}); return E.ajustes.ml; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, mlOn = false, esperaOrden = 0, porConfirmar = null, soloIds = null, mlTimer = null;
  const norm = t => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
  /** Busca la palabra (o frase) como palabra completa; devuelve dónde termina, o -1. */
  function buscar(n, palabra) {
    const p = norm(palabra); if (!p) return -1;
    const m = new RegExp('(^| )' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').exec(n);
    return m ? m.index + m[0].length : -1;
  }
  function pintarMl(txt, modo) {
    $('b-manos').classList.toggle('on', mlOn);
    $('ml-barra').hidden = !mlOn;
    if (!mlOn) return;
    $('ml-barra').classList.toggle('oyendo', modo === 'oyendo'); $('ml-barra').classList.toggle('pensando', modo === 'pensando');
    $('ml-txt').textContent = txt || `Di «${ml().activar}» y tu orden · «${ml().callar}» lo calla · «${ml().descansar}» lo apaga`;
  }
  // En Android el «escuchar» de Google pita cada vez que se reinicia (cada pocos segundos). Ahí se usa el
  // oído propio de ReadPage: el micrófono queda abierto en silencio y solo se envían las frases cortas.
  const ANDROID = /Android/i.test(navigator.userAgent);
  const oidoPropio = () => { const m = ml().motor || 'auto'; return m === 'propio' || (m === 'auto' && (ANDROID || !SR)); };
  let mic = null, enviando = 0;
  async function micEncender() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no permite usar el micrófono.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(2048, 1, 1), sr = ctx.sampleRate;
    const PRE = Math.ceil(0.4 * sr / 2048);                  // se guarda un poquito de antes, para no cortar el inicio
    let piso = 0.008, hablando = false, buf = [], pre = [], silencio = 0, dur = 0;
    proc.onaudioprocess = e => {
      if (!mlOn) return;
      const d = e.inputBuffer.getChannelData(0); let q = 0;
      for (let i = 0; i < d.length; i++) q += d[i] * d[i];
      const rms = Math.sqrt(q / d.length), fuerte = rms > Math.max(0.015, piso * 3.2), copia = new Float32Array(d), paso = d.length / sr;
      if (!hablando) {
        piso = piso * 0.97 + rms * 0.03;                       // se adapta al ruido del lugar
        pre.push(copia); if (pre.length > PRE) pre.shift();
        if (fuerte) { hablando = true; buf = pre.slice(); pre = []; silencio = 0; dur = 0; pintarMl('👂 …', 'oyendo'); }
      } else {
        buf.push(copia); dur += paso; silencio = fuerte ? 0 : silencio + paso;
        if (silencio > 0.75 || dur > 7.5) {
          const largo = dur - silencio, trozo = buf; hablando = false; buf = []; pintarMl();
          if (largo >= 0.35 && largo <= 6.5 && enviando < 2) enviarTrozo(trozo, sr);   // lo largo (radio, TV, la misma lectura) no se envía
        }
      }
    };
    src.connect(proc); proc.connect(ctx.destination);
    mic = { stream, ctx, src, proc };
  }
  function micApagar() {
    if (!mic) return;
    try { mic.proc.disconnect(); mic.src.disconnect(); } catch (_) {}
    mic.stream.getTracks().forEach(t => t.stop()); mic.ctx.close().catch(() => {}); mic = null;
  }
  /** Junta el audio, lo pasa a WAV de 16 kHz y lo manda a escribir. */
  function enviarTrozo(trozos, sr) {
    const n = trozos.reduce((a, t) => a + t.length, 0), todo = new Float32Array(n); let k = 0;
    trozos.forEach(t => { todo.set(t, k); k += t.length; });
    const r = sr / 16000, m = Math.floor(n / r), pcm = new Int16Array(m);
    for (let i = 0; i < m; i++) { const v = Math.max(-1, Math.min(1, todo[Math.floor(i * r)])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    const cab = new DataView(new ArrayBuffer(44)), esc4 = (o, t) => { for (let i = 0; i < 4; i++) cab.setUint8(o + i, t.charCodeAt(i)); };
    esc4(0, 'RIFF'); cab.setUint32(4, 36 + pcm.length * 2, true); esc4(8, 'WAVE'); esc4(12, 'fmt '); cab.setUint32(16, 16, true); cab.setUint16(20, 1, true); cab.setUint16(22, 1, true);
    cab.setUint32(24, 16000, true); cab.setUint32(28, 32000, true); cab.setUint16(32, 2, true); cab.setUint16(34, 16, true); esc4(36, 'data'); cab.setUint32(40, pcm.length * 2, true);
    const palabras = [ml().activar, ml().callar, ml().descansar].join(', ');
    enviando++;
    fetch('/api/escuchar', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Palabras': encodeURIComponent(palabras) }, body: new Blob([cab.buffer, pcm.buffer], { type: 'audio/wav' }) })
      .then(r => r.json()).then(d => { if (d.error) { if (/tope/i.test(d.error)) { mlApagar(); toast(d.error); } return; } if (d.texto) oir(d.texto); })
      .catch(() => {}).finally(() => { enviando--; });
  }

  async function mlEncender() {
    if (oidoPropio()) {
      mlOn = true; pintarMl();
      try { await micEncender(); toast(`🎙️ Manos libres encendido. Di «${ml().activar}» y tu orden.`); }
      catch (e) { mlOn = false; pintarMl(); toast(e && e.name === 'NotAllowedError' ? 'Permite el micrófono para usar manos libres.' : (e.message || 'No se pudo abrir el micrófono.')); }
      return;
    }
    if (!SR) { toast('Este navegador no puede escuchar. Usa Chrome o Edge.'); return; }
    mlOn = true; pintarMl();
    rec = new SR(); rec.lang = 'es-ES'; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) oir(e.results[i][0].transcript); };
    rec.onend = () => { if (mlOn) setTimeout(() => { if (mlOn) try { rec.start(); } catch (_) {} }, 250); };
    rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { mlApagar(); toast('Permite el micrófono para usar manos libres.'); } };
    try { rec.start(); } catch (_) {}
    toast(`🎙️ Manos libres encendido. Di «${ml().activar}» y tu orden.`);
  }
  function mlApagar() { mlOn = false; esperaOrden = 0; porConfirmar = null; try { rec && rec.abort(); } catch (_) {} rec = null; micApagar(); pintarMl(); }
  $('b-manos').addEventListener('click', () => { if (mlOn) { mlApagar(); toast('Manos libres apagado.'); } else mlEncender(); });
  $('ml-apagar').addEventListener('click', () => { mlApagar(); toast('Manos libres apagado.'); });
  function decirCorto(t, luego) { if (!t) { luego && luego(); return; } hablar(t, 'pres', 'es', luego || null); }
  function mostrarOido(t, modo) { pintarMl(t, modo); clearTimeout(mlTimer); mlTimer = setTimeout(() => pintarMl(), 6000); }

  /** Cada frase que se escuchó. */
  function oir(texto) {
    if (!mlOn) return;
    const n = norm(texto), corta = n.split(' ').length <= 3;
    const iA = buscar(n, ml().activar);
    // «Silencio» y «Descansa»: dichas solas (o después de la palabra de activación).
    if (buscar(n, ml().descansar) >= 0 && (corta || iA >= 0)) { mlApagar(); decirCorto('Dejo de escuchar.'); return; }
    if (buscar(n, ml().callar) >= 0 && (corta || iA >= 0)) { esperaOrden = 0; if (vp && esVideoIt(item(E.actualId))) { if (!pausado) alternarVideo(); } else { callar(); if (reproduciendo) { pausado = true; } } pintar(); mostrarOido('🤫 Callado. Di «' + ml().activar + ', sigue» para continuar.'); return; }
    let orden = null;
    if (iA >= 0) orden = n.slice(iA).trim();
    else if (esperaOrden > Date.now()) orden = n;
    if (orden === null) return;                                   // no era para ReadPage: se ignora
    if (!orden) { esperaOrden = Date.now() + 8000; mostrarOido('👂 Te escucho…', 'oyendo'); return; }
    esperaOrden = 0;
    ejecutarOrden(orden, texto);
  }

  /** Órdenes simples que se resuelven aquí mismo; el resto las entiende la IA. */
  function ordenRapida(o) {
    if (porConfirmar && porConfirmar.hasta > Date.now()) {
      if (/^(si|sí|dale|confirmo|ok|okay|hazlo|claro)\b/.test(o)) { const ids = porConfirmar.ids; porConfirmar = null; quitarIds(ids); decirCorto(ids.length === 1 ? 'Listo, la quité.' : `Listo, quité ${ids.length}.`); return true; }
      if (/^(no|cancela|deja)\b/.test(o)) { porConfirmar = null; decirCorto('Está bien, no quito nada.'); return true; }
    }
    if (/^(pausa|pausar|pausalo|para|detente|deten)$/.test(o)) { if (reproduciendo && !pausado) pausarOSeguir(); return true; }
    if (/^(sigue|seguir|continua|continuar|reanuda|dale play|play)$/.test(o)) { if (!reproduciendo || pausado) pausarOSeguir(); return true; }
    if (/^(siguiente|la siguiente|el siguiente|pasa|proxima|proximo)$/.test(o)) { siguienteLectura(); return true; }
    if (/^(anterior|la anterior|el anterior|atras|regresa)$/.test(o)) { lecturaAnterior(); return true; }
    if (/^(mas rapido|acelera|rapido)$/.test(o)) { cambiarVel(1); return true; }
    if (/^(mas lento|mas despacio|despacio|lento)$/.test(o)) { cambiarVel(-1); return true; }
    if (/^(videos|los videos|ver videos|pon los videos|pestana de videos)$/.test(o)) { E.vista = 'videos'; guardar(); pintar(); irA('cola'); return true; }
    if (/^(lecturas|las lecturas|noticias|pestana de lecturas)$/.test(o)) { E.vista = 'lecturas'; guardar(); pintar(); irA('cola'); return true; }
    return false;
  }
  function cambiarVel(d) {
    const orden = VELS.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const k = orden.findIndex(x => x[1] === E.iv), nk = Math.max(0, Math.min(orden.length - 1, k + d));
    if (nk === k) return;
    E.iv = orden[nk][1]; guardar(); pintar();
    if (vp && esVideoIt(item(E.actualId))) velVideo(); else if (audioEnCurso) { A.defaultPlaybackRate = vel(); A.playbackRate = vel(); }
    toast('Velocidad ' + String(vel()).replace('.', ',') + '×');
  }

  async function ejecutarOrden(orden, original) {
    mostrarOido('🎙️ «' + original.trim() + '»', 'oyendo');
    if (ordenRapida(orden)) return;
    const vistas = { lecturas: E.cola.filter(x => !esVideoIt(x)), videos: E.cola.filter(esVideoIt) };
    const cola = E.cola.filter(x => x.estado !== 'error' && x.estado !== 'cargando').map(x => {
      const lista = esVideoIt(x) ? vistas.videos : vistas.lecturas; let ruta = ''; try { ruta = new URL(x.url).pathname; } catch (_) {}
      return { id: x.id, n: lista.indexOf(x) + 1, tipo: esVideoIt(x) ? 'video' : 'lectura', titulo: (x.parrafos ? textoDe(x).titulo : x.titulo) || bonita(x.url), sitio: x.sitio || host(x.url), ruta, estado: x.estado === 'leido' ? 'visto' : 'pendiente', min: esVideoIt(x) ? Math.round((x.dur || 0) / 60) : min(x.palabras || 0) };
    });
    if (!cola.length) { decirCorto('Tu cola está vacía.'); return; }
    mostrarOido('🤔 Pensando: «' + original.trim() + '»', 'pensando');
    let d;
    try {
      const r = await fetch('/api/orden', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orden: original, vista: E.vista === 'videos' ? 'videos' : 'lecturas', cola }) });
      d = await r.json(); if (d.error) throw new Error(d.error);
    } catch (e) { pintarMl(); decirCorto('No pude entender la orden ahora.'); toast(e.message || 'No se pudo procesar la orden.'); return; }
    pintarMl();
    aplicarAcciones(d.acciones || [], d.decir || '');
  }

  function aplicarAcciones(acciones, decir) {
    if (!acciones.length) { decirCorto(decir || 'No entendí. Repítelo con otras palabras.'); return; }
    let hablado = false;
    for (const a of acciones) {
      const ids = (a.ids || []).filter(i => item(i));
      if (a.tipo === 'vista' && (a.valor === 'videos' || a.valor === 'lecturas')) { E.vista = a.valor; guardar(); pintar(); irA('cola'); }
      else if (a.tipo === 'ordenar' && ids.length) ordenarIds(ids);
      else if (a.tipo === 'quitar' && ids.length) {
        if (ml().confirmar !== false) { porConfirmar = { ids, hasta: Date.now() + 15000 }; esperaOrden = Date.now() + 15000; decirCorto(`¿Quito ${ids.length === 1 ? '«' + tituloCorto(item(ids[0])) + '»' : ids.length + ' elementos'}? Di sí o no.`); hablado = true; }
        else quitarIds(ids);
      }
      else if (a.tipo === 'titulares' && ids.length) {
        const txt = ids.map((i, k) => `${k + 1}. ${tituloCorto(item(i), 200)}.`).join(' ');
        if (reproduciendo && !pausado) pausarOSeguir();
        callar(); decirCorto((decir ? decir + ' ' : '') + txt); hablado = true;
      }
      else if (a.tipo === 'leer') {
        soloIds = ids.length ? ids : null;
        const primero = ids.length ? item(ids[0]) : null;
        if (primero) { E.vista = esVideoIt(primero) ? 'videos' : 'lecturas'; if (primero.estado === 'leido') { primero.estado = 'listo'; primero.pos = 0; } }
        const empezar = () => primero ? reproducir(primero.id, primero.tipo === 'video' ? undefined : (primero.pos || 0)) : reproducir();
        if (decir && !hablado) { callar(); decirCorto(decir, empezar); hablado = true; } else empezar();
      }
      else if (a.tipo === 'control') {
        const v = a.valor;
        if (v === 'pausa') { if (reproduciendo && !pausado) pausarOSeguir(); }
        else if (v === 'seguir') { if (!reproduciendo || pausado) pausarOSeguir(); }
        else if (v === 'siguiente') siguienteLectura();
        else if (v === 'anterior') lecturaAnterior();
        else if (v === 'mas_rapido') cambiarVel(1);
        else if (v === 'mas_lento') cambiarVel(-1);
        else if (v === 'adelantar') saltarParrafo(1);
        else if (v === 'atrasar') saltarParrafo(-1);
      }
    }
    if (!hablado && decir && !(reproduciendo && !pausado)) decirCorto(decir);
    else if (!hablado && decir) toast('🎙️ ' + decir);
  }
  const tituloCorto = (it, max = 90) => { const t = (it && ((it.parrafos ? textoDe(it).titulo : it.titulo) || bonita(it.url))) || ''; return t.length > max ? t.slice(0, max) + '…' : t; };
  /** Pone esos elementos primero dentro de su pestaña, en ese orden. */
  function ordenarIds(ids) {
    const tv = esVideoIt(item(ids[0])), lugares = [], deTab = [];
    E.cola.forEach((x, i) => { if (esVideoIt(x) === tv) { lugares.push(i); deTab.push(x); } });
    const primero = ids.map(item).filter(x => x && esVideoIt(x) === tv), resto = deTab.filter(x => !primero.includes(x));
    primero.concat(resto).forEach((x, k) => { E.cola[lugares[k]] = x; });
    E.vista = tv ? 'videos' : 'lecturas'; guardar(); pintar(); irA('cola');
  }
  function quitarIds(ids) {
    ids.forEach(id => {
      const k = indice(id); if (k < 0) return;
      if (id === E.actualId) { callar(); reproduciendo = false; E.actualId = null; mantenerPantalla(false); }
      alPapelera(E.cola.splice(k, 1)); if (viendoId === id) mostrar(null);
    });
    if (soloIds) soloIds = soloIds.filter(i => item(i));
    guardar(); pintar();
  }
  /** Con «solo lee estos»: el siguiente de esa lista; al terminarla, se vuelve a la cola normal. */
  function siguienteDeSolo(video) {
    const k = soloIds.indexOf(E.actualId);
    for (let j = k + 1; j < soloIds.length; j++) { const it = item(soloIds[j]); if (it && esVideoIt(it) === video && it.estado === 'listo') return it; }
    soloIds = null; return null;
  }

  // ------------------------------------------------------------ reproductor, ajustes, tema, pestañas
  $('b-play').addEventListener('click', pausarOSeguir);
  $('b-ant').addEventListener('click', () => saltarParrafo(-1));
  $('b-sig').addEventListener('click', () => saltarParrafo(1));
  $('b-sig-lec').addEventListener('click', siguienteLectura);
  $('b-ant-lec').addEventListener('click', lecturaAnterior);
  $('b-vel').addEventListener('click', () => { E.iv = (E.iv + 1) % VELS.length; guardar(); pintar(); if (vp && esVideoIt(item(E.actualId))) velVideo(); else if (audioEnCurso) { A.defaultPlaybackRate = vel(); A.playbackRate = vel(); } else if (reproduciendo && !pausado) { const it = item(E.actualId); callar(); if (it) leerParrafo(it); } });
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => { if (!reproduciendo || pausado) pausarOSeguir(); });
      navigator.mediaSession.setActionHandler('pause', () => { if (reproduciendo && !pausado) pausarOSeguir(); });
      navigator.mediaSession.setActionHandler('nexttrack', siguienteLectura);
      navigator.mediaSession.setActionHandler('previoustrack', lecturaAnterior);
      navigator.mediaSession.setActionHandler('seekforward', () => saltarParrafo(1));
      navigator.mediaSession.setActionHandler('seekbackward', () => saltarParrafo(-1));
    } catch (_) {}
  }
  $('b-ajustes').addEventListener('click', () => { llenarVoces(); $('aj-idioma').value = destino(); $('aj-presentar').checked = E.ajustes.presentar; $('aj-pantalla').checked = E.ajustes.pantalla; $('aj-ml-activar').value = ml().activar; $('aj-ml-callar').value = ml().callar; $('aj-ml-descansar').value = ml().descansar; $('aj-ml-confirmar').checked = ml().confirmar !== false; $('aj-ml-motor').value = ml().motor || 'auto'; $('aj-motor').value = E.ajustes.motor === 'navegador' ? 'navegador' : 'audio'; verMotor(); $('d-ajustes').showModal(); });
  function verMotor() {
    const nav = $('aj-motor').value === 'navegador';
    $('aj-voces-nav').hidden = !nav; $('aj-voz-srv').hidden = nav;
    if (vocesEs.length) $('aj-voz-es').innerHTML = vocesEs.filter(v => v.id !== 'narrador').map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}${v.id === 'claude' ? ' (recomendada)' : ''}</option>`).join('');
    $('aj-voz-es').value = E.ajustes.vozEs || 'claude';
    if (vocesEs.length) $('aj-voz-es-pres').innerHTML = vocesEs.filter(v => VOCES_HOMBRE.includes(v.id)).map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}${v.id === 'narrador' ? ' (recomendada)' : ''}</option>`).join('');
    $('aj-voz-es-pres').value = E.ajustes.presElegida && VOCES_HOMBRE.includes(E.ajustes.vozEsPres) && E.ajustes.vozEsPres || 'narrador';
    if (!nav && vozServidor && !vozServidor.length) $('aj-motor-ayuda').textContent = '⚠️ La voz de ReadPage no está disponible en este momento: se usará la del teléfono.';
  }
  $('aj-motor').addEventListener('change', e => { E.ajustes.motor = e.target.value; guardar(); verMotor(); });
  $('aj-voz-es-pres').addEventListener('change', e => {
    E.ajustes.vozEsPres = e.target.value; E.ajustes.presElegida = true; guardar();
    callar(); hablar('Lectura uno de tres. Así suena la voz que presenta cada lectura.', 'pres', 'es', null);
  });
  $('aj-voz-es').addEventListener('change', e => {
    E.ajustes.vozEs = e.target.value; guardar();
    callar(); hablar('Así suena esta voz leyendo tus páginas. Si te gusta, déjala elegida.', 'lec', 'es', null);
  });
  $('aj-vpres').addEventListener('change', e => { E.ajustes.vpres = e.target.value; guardar(); });
  $('aj-idioma').addEventListener('change', e => {
    E.ajustes.idioma = e.target.value; guardar();
    const seguia = reproduciendo && !pausado; if (seguia) { callar(); pausado = true; }
    E.cola.forEach(it => { if (it.estado === 'listo' || it.estado === 'leido') asegurarTraduccion(it); });
    if (viendoId) mostrar(viendoId); pintar();
    toast(e.target.value === 'orig' ? 'Se leerá cada página en su idioma original.' : 'Traduciendo las lecturas al idioma elegido…');
    if (seguia) { const it = item(E.actualId); if (it) asegurarTraduccion(it).then(() => { pausado = false; reproducir(it.id); }); }
  });
  $('aj-vlec').addEventListener('change', e => { E.ajustes.vlec = e.target.value; guardar(); });
  $('aj-presentar').addEventListener('change', e => { E.ajustes.presentar = e.target.checked; guardar(); });
  [['aj-ml-activar', 'activar'], ['aj-ml-callar', 'callar'], ['aj-ml-descansar', 'descansar']].forEach(([idc, k]) => {
    $(idc).addEventListener('change', e => { const v = e.target.value.trim(); ml()[k] = v || ML_DEF[k]; e.target.value = ml()[k]; guardar(); pintarMl(); });
  });
  $('aj-ml-confirmar').addEventListener('change', e => { ml().confirmar = e.target.checked; guardar(); });
  $('aj-ml-motor').addEventListener('change', e => { ml().motor = e.target.value; guardar(); if (mlOn) { mlApagar(); mlEncender(); } });
  $('aj-pantalla').addEventListener('change', e => { E.ajustes.pantalla = e.target.checked; guardar(); });
  $('aj-probar').addEventListener('click', () => { callar(); hablar('Hola, soy la voz de presentación de ReadPage.', 'pres', 'es', () => hablar('Y yo soy la voz que lee tus páginas.', 'lec', 'es', null)); });

  // Temas: los dos de Nesux VS Code (en la hoja de estilos) + los quince de la Trading Calculator.
  const TEMAS = [
    // nombre            fondo      panel      panel2     borde      texto      apagado    acento    claro
    ['VS Code oscuro', 0, 0, 0, 0, 0, 0, 0, 0],
    ['VS Code claro', 0, 0, 0, 0, 0, 0, 0, 1],
    ['Nesux oscuro',   '#0d1117', '#161b22', '#1c2330', '#30363d', '#e6edf3', '#8b949e', '#3aa585', 0],
    ['Dark+',          '#1e1e1e', '#252526', '#2d2d30', '#3e3e42', '#d4d4d4', '#858585', '#569cd6', 0],
    ['One Dark',       '#282c34', '#2f343d', '#353b45', '#3e4451', '#c3c9d4', '#7f8694', '#61afef', 0],
    ['Dracula',        '#282a36', '#2f3240', '#383b4a', '#44475a', '#f0f0ec', '#8f93a2', '#bd93f9', 0],
    ['Nord',           '#2e3440', '#343b49', '#3b4252', '#4c566a', '#eceff4', '#97a1b3', '#88c0d0', 0],
    ['Monokai',        '#272822', '#2f3129', '#383a32', '#49483e', '#f2f2ea', '#a6a28c', '#a6e22e', 0],
    ['Gruvbox',        '#282828', '#32302f', '#3c3836', '#504945', '#ebdbb2', '#a89984', '#8ec07c', 0],
    ['Solarized noche', '#002b36', '#073642', '#0b4250', '#17505f', '#eee8d5', '#93a1a1', '#2aa198', 0],
    ['Night Owl',      '#011627', '#0b2942', '#12334d', '#1d3b53', '#d6deeb', '#8b9db5', '#7fdbca', 0],
    ['Tomorrow noche', '#1d1f21', '#282a2e', '#2f3235', '#373b41', '#c5c8c6', '#969896', '#81a2be', 0],
    ['Ayu Mirage',     '#1f2430', '#242936', '#2b3140', '#343b4c', '#cbccc6', '#8a9199', '#5ccfe6', 0],
    ['Palenight',      '#292d3e', '#2f3446', '#363c50', '#444a63', '#c7cbdd', '#8b90a8', '#82aaff', 0],
    ['GitHub claro',   '#ffffff', '#f6f8fa', '#eef1f5', '#d0d7de', '#1f2328', '#636c76', '#1a7f57', 1],
    ['Quiet Light',    '#f5f5f5', '#ffffff', '#f0f0f0', '#dcdcdc', '#333333', '#777777', '#4b6fa8', 1],
    ['Solarized día',  '#fdf6e3', '#f5efdc', '#eee8d5', '#ddd6c1', '#073642', '#657b83', '#2a7d8c', 1],
  ];
  const VARS = ['--bg', '--bg2', '--bg3', '--borde', '--txt', '--muted', '--acento', '--suave', '--morado', '--app', '--verde', '--grad', '--lee', '--acento2', '--sobre'];
  function aplicarPaleta(nombre) {
    const t = TEMAS.find(x => x[0] === nombre) || TEMAS[0], h = document.documentElement, st = h.style;
    const [, bg, panel, panel2, borde, txt, muted, xc, claro] = t;
    h.dataset.theme = claro ? 'light' : 'dark'; h.dataset.paleta = t[0];
    VARS.forEach(v => st.removeProperty(v));
    if (bg) {                                   // los temas de la calculadora pisan los colores de la hoja de estilos
      const p = { '--bg': bg, '--bg2': panel, '--bg3': panel2, '--borde': borde, '--txt': txt, '--muted': muted, '--acento': xc, '--acento2': xc, '--app': xc, '--verde': xc,
        '--suave': `color-mix(in srgb, ${txt} 82%, ${muted})`, '--morado': `color-mix(in srgb, ${xc} 45%, ${borde})`,
        '--grad': `linear-gradient(135deg, ${xc}, color-mix(in srgb, ${xc} 72%, ${claro ? '#000' : '#fff'}))`, '--sobre': claro ? '#fff' : bg,
        '--lee': `color-mix(in srgb, ${xc} ${claro ? 14 : 18}%, transparent)` };
      Object.entries(p).forEach(([k, v]) => st.setProperty(k, v));
    }
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = bg || (claro ? '#F1F5F9' : '#0B1220');
    $('b-paleta-txt').textContent = t[0];
    try { localStorage.setItem('readpage.paleta', t[0]); } catch (_) {}
  }
  let paleta = null;
  try { paleta = localStorage.getItem('readpage.paleta'); if (!paleta) { const v = localStorage.getItem('readpage.tema'); paleta = v ? (v === 'light' ? 'VS Code claro' : 'VS Code oscuro') : null; } } catch (_) {}
  if (!paleta) paleta = matchMedia('(prefers-color-scheme: light)').matches ? 'VS Code claro' : 'VS Code oscuro';
  aplicarPaleta(paleta);
  $('b-paleta').addEventListener('click', () => {           // una pulsación pasa al siguiente tema; la elección se guarda
    const i = TEMAS.findIndex(x => x[0] === document.documentElement.dataset.paleta);
    aplicarPaleta(TEMAS[(i + 1) % TEMAS.length][0]);
  });
  // 🌓: cambio rápido entre claro y oscuro (vuelve a los colores de VS Code).
  $('b-tema').addEventListener('click', () => aplicarPaleta(document.documentElement.dataset.theme === 'light' ? 'VS Code oscuro' : 'VS Code claro'));

  // ------------------------------------------------------------ instalar la app
  let avisoInstalar = null;
  const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // Si ya está instalada (abierta desde su ícono), en vez de «App» se ve «✓ Instalada».
  function marcarInstalada() { const b = $('b-instalar'); b.classList.add('ya'); b.innerHTML = '✓ Instalada'; b.title = 'ReadPage ya está instalada en este equipo'; }
  if (instalada()) marcarInstalada();
  else if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then(apps => { if (apps && apps.length) marcarInstalada(); }).catch(() => {});
  }
  async function instalarYa() {
    if (!avisoInstalar) return;
    avisoInstalar.prompt();
    const r = await avisoInstalar.userChoice.catch(() => null); avisoInstalar = null;
    if ($('d-instalar').open) $('d-instalar').close();
    if (r && r.outcome === 'accepted') marcarInstalada();
  }
  // Chrome avisa que se puede instalar cuando ya se usó un rato la página: si los pasos están abiertos, aparece el botón directo.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); avisoInstalar = e;
    if ($('d-instalar').open && !$('di-ya')) {
      $('di-pasos').insertAdjacentHTML('afterbegin', '<button type="button" class="prim" id="di-ya">📲 Instalar ahora</button><p class="ayuda" style="text-align:center">o sigue los pasos de abajo</p>');
      $('di-ya').addEventListener('click', instalarYa);
    }
  });
  window.addEventListener('appinstalled', () => { marcarInstalada(); toast('¡ReadPage quedó instalada! Búscala en tus apps.'); });
  $('b-instalar').addEventListener('click', async () => {
    if ($('b-instalar').classList.contains('ya')) {
      const enApp = instalada();
      $('di-pasos').innerHTML = (enApp
        ? '<p class="ayuda" style="margin:0 0 8px">✅ Ya estás usando ReadPage como app.</p>'
        : '<p class="ayuda" style="margin:0 0 8px">✅ ReadPage ya está instalada en este teléfono. Ahora mismo la estás viendo en el navegador.</p>')
        + '<b>Dónde encontrarla</b><ol class="pasos">'
        + '<li>Desde la pantalla de inicio, <b>desliza hacia arriba</b> (o toca el botón de aplicaciones ⋮⋮⋮) para ver <b>todas tus apps</b>.</li>'
        + '<li>Arriba, en el buscador, escribe <b>ReadPage</b>. Su ícono es el azul con la hoja y las ondas de voz.</li>'
        + '<li>Para tenerla a mano: <b>mantén presionado</b> el ícono y arrástralo a la pantalla de inicio (o elige <b>«Agregar a inicio»</b>).</li>'
        + '</ol>'
        + (enApp ? '' : '<p class="ayuda">También desde Chrome: menú <b>⋮</b> → <b>«Abrir ReadPage»</b>.</p>')
        + '<p class="ayuda">Para mandarle una imagen o un texto: en <b>WhatsApp</b> o la <b>Galería</b> toca <b>Compartir → ReadPage</b>.</p>';
      $('d-instalar').showModal(); return;
    }
    if (avisoInstalar) return instalarYa();             // Chrome / Edge (Android y PC): ventana de instalación directa
    const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua), safariIos = ios && !/CriOS|FxiOS|EdgiOS/i.test(ua);
    $('di-pasos').innerHTML = ios ? (safariIos
      ? '<ol class="pasos"><li>Toca el botón <b>Compartir</b> (el cuadrado con la flecha ↑) en la barra de Safari.</li><li>Baja y toca <b>«Agregar a pantalla de inicio»</b>.</li><li>Toca <b>Agregar</b>. El ícono de ReadPage queda en tu pantalla.</li></ol>'
      : '<ol class="pasos"><li>En iPhone se instala desde <b>Safari</b>: copia esta dirección y ábrela allí.</li><li>Toca <b>Compartir</b> (↑) → <b>«Agregar a pantalla de inicio»</b> → <b>Agregar</b>.</li></ol>')
      : android
        ? '<ol class="pasos"><li>Toca los <b>tres puntos ⋮</b> de Chrome, arriba a la derecha (al lado de la dirección).</li><li>Baja en ese menú y toca <b>«Instalar aplicación»</b>. En algunos teléfonos dice <b>«Agregar a la pantalla principal»</b>: tócalo y luego elige <b>«Instalar»</b>.</li><li>Confirma con <b>Instalar</b>. El ícono de ReadPage aparece con tus apps.</li></ol><p class="ayuda">Si en el menú no aparece la opción, usa la app unos segundos (agrega o abre una lectura) y vuelve a tocar <b>App</b>: Chrome activa la instalación después de que usas la página. Tiene que ser en <b>Chrome</b>, no dentro de WhatsApp o Facebook.</p>'
        : '<ol class="pasos"><li>En <b>Edge</b> o <b>Chrome</b>, mira el ícono de instalar <b>⊕</b> al final de la barra de direcciones y haz clic.</li><li>O abre el menú <b>⋯</b> → <b>Aplicaciones</b> → <b>«Instalar ReadPage»</b>.</li><li>Queda en el menú Inicio y puedes anclarla a la barra de tareas.</li></ol>';
    $('d-instalar').showModal();
  });

  function irA(p) { document.body.dataset.p = p; document.querySelectorAll('#pestanas button').forEach(b => b.classList.toggle('act', b.dataset.p === p)); }
  document.querySelectorAll('#pestanas button').forEach(b => b.addEventListener('click', () => irA(b.dataset.p)));

  // ------------------------------------------------------------ inicio
  irA('cola');

  // ------------------------------------------------------------ botón «atrás» del teléfono
  // Chrome en Android SALTA los pasos de historial que una página agrega sin que la persona haya tocado nada.
  // Por eso el paso de «atrás» se agrega en el primer toque (y de nuevo tras cada «atrás»), no al abrir.
  // Así «atrás» cierra ventanas o vuelve a la Cola; si se toca dos veces seguidas sin tocar la app, sale.
  let hayPaso = false, saliendo = false;
  const ponerPaso = () => { if (hayPaso || saliendo) return; try { history.pushState({ rp: Date.now() }, '', location.href); hayPaso = true; } catch (_) {} };
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, ponerPaso, { capture: true, passive: true }));
  window.addEventListener('popstate', () => {
    if (saliendo) return;
    hayPaso = false;                                                     // se gastó: el próximo toque pone otro
    const abiertos = [...document.querySelectorAll('dialog[open]')];
    if (abiertos.length) { abiertos[abiertos.length - 1].close(); return; }
    if (document.body.dataset.p && document.body.dataset.p !== 'cola' && matchMedia('(max-width: 860px)').matches) { irA('cola'); return; }
    toast('Toca atrás otra vez para salir de ReadPage.');
  });
  E.cola.forEach(it => {
    if (it.estado !== 'cargando') return;
    if (it.archivo) { it.estado = 'error'; it.error = 'Se cerró antes de terminar: vuelve a subir el archivo.'; delete it.progreso; }
    else encolarCarga(it);
  });
  pintar();
  if (E.actualId && item(E.actualId)) mostrar(E.actualId); else if (E.cola[0]) mostrar(E.cola[0].id);
  BD.leer().then(g => {
    if (!g || !Array.isArray(g.cola) || (g.t || 0) <= (E.t || 0) || reproduciendo) { if (!g) guardar(); return; }
    E = Object.assign(E, g, { ajustes: Object.assign(E.ajustes, g.ajustes || {}) });
    E.cola.forEach(it => { if (it.estado === 'cargando' && it.archivo) { it.estado = 'error'; it.error = 'Se cerró antes de terminar: vuelve a subir el archivo.'; delete it.progreso; } else if (it.estado === 'cargando') encolarCarga(it); else if (it.estado === 'error' && !it.archivo && (errorDeRed(it.error) || (/error 40[13]|error 429/.test(it.error || '') && !it.reintento403))) { if (/error 40/.test(it.error || '')) it.reintento403 = true; reintentar(it); } });
    pintar(); if (E.actualId && item(E.actualId)) mostrar(E.actualId); else if (E.cola[0]) mostrar(E.cola[0].id);
  });
  setInterval(() => { if (!reproduciendo) pintar(); }, 60000);   // la hora de fin se mantiene al día
  const m = /^\/l\/([A-Za-z0-9]{4,12})\/?$/.exec(location.pathname);
  if (m) abrirListaCompartida(m[1]);
  // Abrir con enlaces compartidos desde el menú «Compartir» del teléfono (Android).
  // Archivos que llegaron con «Compartir → ReadPage» (los guardó el service worker).
  if (new URLSearchParams(location.search).get('compartido') && 'caches' in window) {
    caches.open('readpage-compartido').then(async c => {
      const fs = [];
      for (const k of await c.keys()) {
        const r = await c.match(k); if (!r) continue;
        const b = await r.blob(); fs.push(new File([b], decodeURIComponent(r.headers.get('X-Nombre') || 'archivo'), { type: b.type || r.headers.get('Content-Type') || '' }));
        await c.delete(k);
      }
      if (fs.length) agregarArchivos(fs);
    }).catch(() => toast('No se pudieron recibir los archivos compartidos.'));
  }
  const qs = new URLSearchParams(location.search), comp = [qs.get('url'), qs.get('text'), qs.get('title')].filter(Boolean).join(' ');
  // Una imagen con su pie de foto: se lee la imagen; el pie solo cuenta si trae enlaces.
  if (comp && !(qs.get('compartido') && !sacarUrls(comp).length)) recibirCompartido(qs.get('title'), qs.get('text'), qs.get('url'));
  if (comp) history.replaceState(null, '', '/');
  // Seguir leyendo lo que sonaba antes de la recarga (por ejemplo, al compartir un enlace desde WhatsApp o el navegador).
  (function seguirLectura() {
    let g = null; try { g = JSON.parse(localStorage.getItem('readpage.seguir') || 'null'); localStorage.removeItem('readpage.seguir'); } catch (_) {}
    if (!g || !g.id || Date.now() - (g.t || 0) > 180000 || !item(g.id)) return;
    setTimeout(() => {
      if (reproduciendo) return;
      const it = item(g.id); if (it) it.pos = g.pos || 0;
      mostrar(g.id);
    }, 100);
  })();
  // App instalada y ya abierta: un enlace de lista que se toque afuera llega a esta misma ventana.
  if ('launchQueue' in window) {
    try {
      window.launchQueue.setConsumer(p => {
        if (!p || !p.targetURL) return;
        const c = codigoLista(p.targetURL); if (c) return abrirListaCompartida(c);
        const q = new URL(p.targetURL).searchParams, t = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
        if (t) recibirCompartido(q.get('title'), q.get('text'), q.get('url'));
      });
    } catch (_) {}
  }
  if ('serviceWorker' in navigator) {
    // Cuando se publica una versión nueva, el service worker toma el control y la app se recarga sola (una vez).
    const yaHabia = !!navigator.serviceWorker.controller; let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!yaHabia || recargando) return; recargando = true; location.reload(); });
    navigator.serviceWorker.register('/sw.js').then(r => { r.update().catch(() => {}); }).catch(() => {});
  }
  // Navegadores internos de WhatsApp, Facebook, Instagram…: no traen voces. Se ofrece abrir en Chrome (o Safari).
  (function revisarNavegador() {
    const ua = navigator.userAgent, android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua);
    const interno = /; wv\)|FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Messenger|TikTok|Snapchat/i.test(ua);
    const mostrar = () => {
      $('aviso-nav').hidden = false;
      const b = $('b-chrome'), url = location.href;
      if (android) b.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
      else { b.textContent = ios ? 'Copiar enlace para Safari' : 'Copiar enlace'; b.addEventListener('click', e => { e.preventDefault(); (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Enlace copiado: pégalo en ' + (ios ? 'Safari.' : 'tu navegador.')), () => toast(url)); }); }
    };
    if (interno || !hayVoz) return mostrar();
    // En Chrome normal no se avisa de entrada (en Android las voces cargan tarde): solo si al leer la voz no arranca.
  })();
})();
