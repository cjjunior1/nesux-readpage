/**
 * ReadPage · Nesux — servidor.
 *
 * 1) Sirve la app (carpeta public/).
 * 2) /api/extraer  → baja una página y devuelve SOLO su contenido legible
 *                    (título, sitio, idioma y párrafos), sin menús ni anuncios.
 * 3) /api/sitio    → encuentra las páginas de un sitio (sitemap o enlaces internos)
 *                    con su título, para elegir cuáles leer.
 * 4) /api/voz      → convierte un texto en audio MP3 con Piper (voces libres, en este
 *                    servidor). El audio sigue sonando con la pantalla del teléfono apagada.
 *
 * SEGURIDAD: el servidor descarga direcciones que manda cualquiera. Para que nadie
 * lo use para entrar a servicios internos (localhost, red privada), cada dirección
 * se resuelve y se rechaza si apunta a una IP privada, también en cada redirección.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { crearCuentas } from './cuentas.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(RAIZ, 'public');
// Variables de un archivo .env junto al servidor (por ejemplo, la clave de IA de las órdenes por voz).
try {
  for (const lin of fs.readFileSync(path.join(RAIZ, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(lin);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sin .env */ }
const PUERTO = Number(process.env.PORT || 3020);
const AGENTE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ReadPage/1.0';
const MAX_BYTES = 6 * 1024 * 1024;
const silencio = new VirtualConsole();          // jsdom no ensucia el registro con errores de CSS de las páginas

// ------------------------------------------------------------------ red segura
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return ipPrivada(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
}

async function revisarUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('La dirección no es válida.'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Solo se aceptan direcciones http o https.');
  if (url.username || url.password) throw new Error('Dirección no permitida.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('No se encontró ese sitio.'); });
  if (!ips.length || ips.some(i => ipPrivada(i.address))) throw new Error('Dirección no permitida.');
  return url;
}

/** Descarga con límites (tiempo, tamaño, redirecciones revisadas una por una). */
async function bajar(u, { limite = MAX_BYTES, tiempo = 15000 } = {}) {
  let url = await revisarUrl(u);
  for (let saltos = 0; saltos < 6; saltos++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), tiempo);
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': AGENTE, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es,en;q=0.8' } });
    } catch (e) { clearTimeout(t); throw new Error(e.name === 'AbortError' ? 'El sitio tardó demasiado en responder.' : 'No se pudo conectar con el sitio.'); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      clearTimeout(t); url = await revisarUrl(new URL(r.headers.get('location'), url).href); continue;
    }
    if (!r.ok) { clearTimeout(t); throw new Error(`El sitio respondió con error ${r.status}.`); }
    const tipo = r.headers.get('content-type') || '';
    const lector = r.body.getReader(); const partes = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await lector.read(); if (done) break;
        total += value.length; if (total > limite) { ctl.abort(); throw new Error('La página es demasiado grande.'); }
        partes.push(value);
      }
    } finally { clearTimeout(t); }
    const buf = Buffer.concat(partes);
    const m = /charset=([\w-]+)/i.exec(tipo) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4000).toString('latin1'));
    let texto;
    try { texto = new TextDecoder((m && m[1]) || 'utf-8').decode(buf); } catch { texto = buf.toString('utf8'); }
    return { texto, tipo, url: url.href };
  }
  throw new Error('Demasiadas redirecciones.');
}

function esUrlVideo(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const plataformas = ['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv', 'dailymotion.com', 'instagram.com', 'facebook.com', 'fb.watch', 'rumble.com', 'odysee.com', 'streamable.com', 'kick.com'];
  return plataformas.some(d => host === d || host.endsWith('.' + d)) ||
    /\.(mp4|webm|ogv|m4v|mov|avi|mkv|flv|m3u8|ts)$/i.test(url.pathname);
}

async function clasificarEnlace(u) {
  let url = await revisarUrl(u);
  for (let saltos = 0; saltos < 6; saltos++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': AGENTE, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es,en;q=0.8' } });
    } catch (e) {
      clearTimeout(t);
      throw new Error(e.name === 'AbortError' ? 'El sitio tardó demasiado en responder.' : 'No se pudo conectar con el sitio.');
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      await r.body?.cancel();
      clearTimeout(t);
      url = await revisarUrl(new URL(r.headers.get('location'), url).href);
      continue;
    }

    const tipoContenido = r.headers.get('content-type') || '';
    let html = '';
    try {
      if (!esUrlVideo(url) && /text\/html/i.test(tipoContenido) && r.body) {
        const lector = r.body.getReader();
        try {
          const parte = await lector.read();
          if (parte.value) html = Buffer.from(parte.value).subarray(0, 65536).toString('utf8');
        } finally {
          await lector.cancel();
        }
      } else {
        await r.body?.cancel();
      }
    } finally {
      clearTimeout(t);
    }
    const videoEnHtml = /<video\b|<meta[^>]+(?:property|name)=["']og:type["'][^>]*content=["']video/i.test(html);
    return { tipo: /^video\//i.test(tipoContenido) || esUrlVideo(url) || videoEnHtml ? 'video' : 'lectura', url: url.href };
  }
  throw new Error('Demasiadas redirecciones.');
}

// ------------------------------------------------------------------ extracción
const CACHE = new Map();
function guardarCache(k, v) { CACHE.set(k, v); if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value); }

function limpiar(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

// ------------------------------------------------------------------ sitios que arman el texto con JavaScript
/** MSN: la página llega vacía, pero su servicio público de contenido entrega el artículo completo. */
async function especial(u) {
  const x = new URL(u);
  if (/(^|\.)msn\.com$/i.test(x.hostname)) {
    const m = /\/(ar|vi|gm|ss)-([A-Za-z0-9]+)/.exec(x.pathname), loc = (/^\/([a-z]{2}-[a-z]{2})\//i.exec(x.pathname) || [])[1] || 'es-xl';
    if (!m) return null;
    const { texto } = await bajar(`https://assets.msn.com/content/view/v2/Detail/${loc}/${m[2]}`, { limite: 5 * 1024 * 1024 });
    const d = JSON.parse(texto);
    const esc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Galerías (ss-): cada diapositiva trae su foto, su título y su texto.
    if (!d.body && Array.isArray(d.slides) && d.slides.length) {
      d.body = d.slides.map(sl => {
        const im = sl.image && sl.image.url ? `<img src="${esc(sl.image.url)}?w=1000" alt="">` : '';
        return `<section>${im}${sl.title ? `<h2>${esc(sl.title)}</h2>` : ''}${sl.body || ''}</section>`;
      }).join('');
    }
    if (!d.body) return null;
    const autor = (d.authors || []).map(a => a.name).filter(Boolean).join(', ');
    // Las fotos vienen solo con su código: se arma la dirección y se usa su descripción.
    const desc = {}; (d.imageResources || []).forEach(im => { const id = String(im.cmsId || im.url || '').split('/').pop().replace(/\.img$/, ''); if (id) desc[id] = im.caption || im.title || im.attribution || ''; });
    d.body = String(d.body).replace(/<img\b[^>]*data-document-id="[^"]*?([A-Za-z0-9]+)"[^>]*>/g, (m, id) =>
      `<img src="https://img-s-msn-com.akamaized.net/tenant/amp/entityid/${id}.img?w=1000" alt="${esc(String(desc[id] || '').replace(/<[^>]+>/g, ''))}">`);
    const html = `<!doctype html><html lang="${esc((d.locale || loc).slice(0, 2))}"><head><title>${esc(d.title)}</title>`
      + `<meta property="og:site_name" content="${esc([d.provider && d.provider.name, 'MSN'].filter(Boolean).join(' · '))}">`
      + `<meta name="author" content="${esc(autor)}"></head><body><article><h1>${esc(d.title)}</h1>${d.body}</article></body></html>`;
    return { texto: html, tipo: 'text/html', url: x.origin + x.pathname, autor };
  }
  return null;
}

/** Respaldo: muchos periódicos traen el artículo entero en sus datos estructurados (JSON-LD «articleBody»). */
function deJsonLd(doc) {
  for (const sc of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let j; try { j = JSON.parse(sc.textContent); } catch { continue; }
    const pila = [j];
    while (pila.length) {
      const o = pila.pop();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o)) { pila.push(...o); continue; }
      if (typeof o.articleBody === 'string' && o.articleBody.length > 200) return { cuerpo: o.articleBody, titulo: o.headline, autor: [].concat(o.author || []).map(a => a && (a.name || a)).filter(x => typeof x === 'string').join(', ') };
      if (o['@graph']) pila.push(o['@graph']);
    }
  }
  return null;
}

// ------------------------------------------------------------------ bloques de texto e imágenes, en orden
const FUERA = 'nav,header,footer,aside,form,button,script,style,noscript,template,iframe,svg,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"],[hidden]';
const BLOQUE = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th,dt,dd';
/** Dirección de una imagen que vale la pena mostrar (no íconos, logos ni píxeles de rastreo). */
function imagenDe(img, base) {
  const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
  if (!src || /^data:/i.test(src) || /\.svg(\?|$)/i.test(src)) return null;
  const w = parseInt(img.getAttribute('width') || '0', 10), h = parseInt(img.getAttribute('height') || '0', 10);
  if ((w && w < 120) || (h && h < 80)) return null;
  const alt = limpiar(img.getAttribute('alt'));
  if (/logo|icon|avatar|pixel|spacer|emoji|gravatar/i.test(src + ' ' + alt)) return null;
  try { return { img: new URL(src, base).href, t: alt.slice(0, 300) }; } catch { return null; }
}
/** Recorre un documento y devuelve sus bloques en el orden en que aparecen: títulos, párrafos e imágenes. */
function bloquesDe(raiz, base, conDivs) {
  const sel = BLOQUE + ',img' + (conDivs ? ',div' : '');
  const todos = [...raiz.querySelectorAll(sel)].filter(e => !e.closest(FUERA));
  const conjunto = new Set(todos), out = [], vistas = new Set();
  for (const e of todos) {
    if (e.tagName === 'IMG') {
      const im = imagenDe(e, base);
      if (im && !vistas.has(im.img)) { vistas.add(im.img); out.push({ t: im.t, h: 0, img: im.img }); }
      continue;
    }
    // solo bloques «hoja»: si contiene otro bloque de texto, se usa el de adentro
    if ([...e.querySelectorAll(sel)].some(o => conjunto.has(o) && o.tagName !== 'IMG')) continue;
    const t = limpiar(e.textContent);
    if (t.length < 2 || (e.tagName === 'DIV' && t.length < 20)) continue;
    out.push({ t, h: /^H\d$/.test(e.tagName) ? 1 : 0 });
  }
  return out;
}

/** Respaldo para sitios que bloquean al servidor (error 403, 429…): un lector público trae la misma página.
 *  Solo se usa cuando la descarga normal falla; se le pasa la dirección pública del artículo y nada más. */
async function porRespaldo(u) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch('https://r.jina.ai/' + u, { signal: ctl.signal, headers: { 'X-Return-Format': 'html', 'User-Agent': AGENTE } });
    if (!r.ok) throw new Error('respaldo ' + r.status);
    const texto = await r.text();
    if (texto.length > 12 * 1024 * 1024 || !/<(p|h1|article)[\s>]/i.test(texto)) throw new Error('respaldo vacío');
    const canon = (/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i.exec(texto) || /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)/i.exec(texto) || [])[1];
    let url = u; try { if (canon) url = new URL(canon, u).href; } catch { /* se queda la original */ }
    return { texto, tipo: 'text/html', url };
  } finally { clearTimeout(t); }
}

/** Datos de un video (título, canal, miniatura) por oEmbed: YouTube, Vimeo y TikTok lo ofrecen público. */
async function datosVideo(u) {
  const x = new URL(u), h = x.hostname.replace(/^(www|m)\./, '');
  const oembed = /(^|\.)youtube\.com$|^youtu\.be$/.test(h) ? 'https://www.youtube.com/oembed?format=json&url='
    : /(^|\.)vimeo\.com$/.test(h) ? 'https://vimeo.com/api/oembed.json?url='
    : /(^|\.)tiktok\.com$/.test(h) ? 'https://www.tiktok.com/oembed?url=' : null;
  if (oembed) {
    try {
      const { texto } = await bajar(oembed + encodeURIComponent(u), { limite: 300 * 1024, tiempo: 10000 });
      const d = JSON.parse(texto);
      return { titulo: limpiar(d.title), autor: limpiar(d.author_name), miniatura: d.thumbnail_url || '', duracion: d.duration || 0, vid: String(d.embed_product_id || '') };
    } catch { /* se intenta con la página */ }
  }
  try {
    const { texto } = await bajar(u, { limite: 2 * 1024 * 1024, tiempo: 12000 });
    const meta = n => (new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)`, 'i').exec(texto) || [])[1] || '';
    return { titulo: limpiar(meta('og:title') || (/<title[^>]*>([^<]+)/i.exec(texto) || [])[1]), autor: limpiar(meta('og:site_name')), miniatura: meta('og:image'), duracion: 0 };
  } catch { return { titulo: '', autor: '', miniatura: '', duracion: 0 }; }
}

/** Manos libres: convierte una orden hablada en acciones sobre la cola (JSON). Usa la clave propia de las órdenes. */
async function entenderOrden(orden, cola, vista) {
  const clave = process.env.ORDENES_OPENAI_KEY;
  if (!clave) throw new Error('Las órdenes inteligentes no están configuradas.');
  const sistema = `Eres el asistente de voz de ReadPage, una app que lee artículos en voz alta y reproduce videos en cola.
Recibes una ORDEN dicha en español (puede venir mal escrita por el reconocimiento de voz) y la COLA actual.
Cada elemento de la cola tiene: id, n (su número dentro de su pestaña), tipo ("lectura" o "video"), titulo, sitio, ruta (la dirección), estado ("pendiente" o "visto").
La pestaña que el usuario está viendo es "${vista}". Si la orden dice un número («la 3»), se refiere al n de esa pestaña, salvo que diga «video» o «lectura».
Responde SOLO un JSON: {"acciones":[...], "decir":"frase corta en español para confirmar o preguntar"}.
Acciones posibles (usa solo ids que existan en la cola):
- {"tipo":"leer","ids":[...]}: reproducir solo esos, en ese orden (lecturas o videos). Con ids vacío: seguir con la cola normal.
- {"tipo":"titulares","ids":[...]}: decir en voz alta solo los títulos de esos elementos (en ese orden).
- {"tipo":"ordenar","ids":[...]}: poner esos primero, en ese orden, dentro de su pestaña.
- {"tipo":"quitar","ids":[...]}: quitarlos de la cola.
- {"tipo":"vista","valor":"lecturas"|"videos"}: cambiar de pestaña.
- {"tipo":"control","valor":"pausa"|"seguir"|"siguiente"|"anterior"|"mas_rapido"|"mas_lento"|"adelantar"|"atrasar"}.
Reglas: para un área o tema (deportes, política, economía, salud, tecnología, internacional, farándula…) decide por el título, el sitio y la ruta (muchas rutas dicen la sección, como /deportes/).
«Titulares» o «los títulos» = acción titulares. «Solo lee…» = leer con esos ids. «Las más cortas/largas» se decide por minutos.
Si no entiendes o no hay elementos que cumplan, responde acciones [] y en "decir" explica en pocas palabras.
"decir" debe ser corto (máximo 15 palabras) y natural, por ejemplo: "Te leo 3 titulares de deportes."`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + clave },
      body: JSON.stringify({ model: process.env.ORDENES_OPENAI_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: JSON.stringify({ orden, cola }) }] }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error('La IA no respondió.');
    const out = JSON.parse(d.choices[0].message.content);
    const ids = new Set(cola.map(x => x.id));
    out.acciones = (Array.isArray(out.acciones) ? out.acciones : []).map(a => ({ ...a, ids: Array.isArray(a.ids) ? a.ids.filter(i => ids.has(i)) : undefined }));
    out.decir = String(out.decir || '').slice(0, 200);
    return out;
  } finally { clearTimeout(t); }
}

/** Oído propio (manos libres sin pitido en Android): la app manda solo frases cortas (≤ 7 s) en WAV
 *  y aquí se pasan a texto. Tope diario por usuario para que el costo nunca se dispare. */
const OIDO_TOPE_SEG = Number(process.env.OIDO_TOPE_SEG || 1800);      // 30 minutos de audio al día por usuario
const oidoUso = new Map();                                            // id → { dia, seg }
async function transcribirOrden(wav, palabras, quien) {
  const clave = process.env.ORDENES_OPENAI_KEY;
  if (!clave) throw new Error('El oído de ReadPage no está configurado.');
  const seg = Math.max(0, (wav.length - 44) / 32000);                 // WAV 16 kHz, 16 bits, mono
  if (seg < 0.3 || seg > 8) return '';
  const dia = new Date().toISOString().slice(0, 10), u = oidoUso.get(quien);
  const uso = u && u.dia === dia ? u : { dia, seg: 0 };
  if (uso.seg + seg > OIDO_TOPE_SEG) throw new Error('Llegaste al tope diario del manos libres. Mañana se renueva.');
  uso.seg += seg; oidoUso.set(quien, uso);
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'orden.wav');
  fd.append('model', process.env.OIDO_MODELO || 'gpt-4o-mini-transcribe');
  fd.append('language', 'es');
  fd.append('prompt', 'Órdenes habladas a la app ReadPage. Palabras clave: ' + palabras + '.');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', signal: ctl.signal, headers: { Authorization: 'Bearer ' + clave }, body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('No se pudo escuchar la orden.');
    return limpiar(d.text);
  } finally { clearTimeout(t); }
}
function leerCrudo(req, max) {
  return new Promise((ok, mal) => {
    const partes = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { mal(new Error('Audio demasiado largo.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes))); req.on('error', mal);
  });
}

async function extraer(u) {
  if (CACHE.has(u)) return CACHE.get(u);
  let esp = null; try { esp = await especial(u); } catch { /* si falla, se intenta la página normal */ }
  let bajada = esp;
  if (!bajada) {
    try { bajada = await bajar(u); } catch (e) {
      // Sitio que bloquea o no responde al servidor: se intenta con el respaldo; si también falla, se muestra el error original.
      if (!/error (401|403|406|429|451|503)|tardó demasiado|No se pudo conectar/.test(e.message)) throw e;
      try { bajada = await porRespaldo(u); } catch { throw e; }
    }
  }
  const { texto, tipo, url } = bajada;
  if (!/html|xml/i.test(tipo) && !/<html/i.test(texto.slice(0, 2000))) throw new Error('Ese enlace no es una página web (puede ser un PDF o una imagen).');
  const dom = new JSDOM(texto, { url, virtualConsole: silencio });
  const doc = dom.window.document;
  const lang = (doc.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase();
  const sitio = limpiar(doc.querySelector('meta[property="og:site_name"]')?.content) || new URL(url).hostname.replace(/^www\./, '');
  const art = new Readability(doc.cloneNode(true), { charThreshold: 300 }).parse();
  const h1 = limpiar(doc.querySelector('h1')?.textContent);
  let titulo = (h1.length >= 4 && h1.length <= 140 && h1) || limpiar(art?.title) || limpiar(doc.title) || url;
  let parrafos = [];
  if (art?.content) {
    const d2 = new JSDOM(`<body>${art.content}</body>`, { url, virtualConsole: silencio }).window.document;
    parrafos = bloquesDe(d2.body, url, false);
  }
  // Páginas que no son un artículo (landings, páginas de curso…): Readability toma una sola sección.
  // Si capta menos de la mitad del texto de la página, se lee la página completa, en orden.
  const cuenta = ps => ps.reduce((n, p) => n + (p.img ? 0 : p.t.split(/\s+/).length), 0);
  const raiz = doc.querySelector('main, [role="main"], article') || doc.body;
  if (raiz) {
    const completa = bloquesDe(raiz, url, true);
    if (cuenta(completa) > 40 && cuenta(parrafos) < cuenta(completa) * 0.5) parrafos = completa;
  }
  let autorLd = '';
  if (parrafos.reduce((n, p) => n + (p.img ? 0 : p.t.length), 0) < 400) {          // casi vacío: probar los datos estructurados
    const ld = deJsonLd(doc);
    if (ld) {
      parrafos = ld.cuerpo.replace(/\r/g, '').split(/\n\s*\n|\n(?=[A-ZÁÉÍÓÚÑ¿¡"«])/).map(limpiar).filter(t => t.length > 1).map(t => ({ t, h: 0 }));
      if (ld.titulo && titulo === url) titulo = limpiar(ld.titulo);
      autorLd = ld.autor || '';
    }
  }
  if (!parrafos.length) {
    const cuerpo = (doc.body?.textContent || '').split(/\n\s*\n/).map(limpiar).filter(x => x.length > 40);
    parrafos = cuerpo.map(t => ({ t, h: 0 }));
  }
  // Quitar repeticiones exactas seguidas (menús que se cuelan).
  parrafos = parrafos.filter((p, i) => p.img || i === 0 || p.t !== parrafos[i - 1].t);
  // El título repetido como primer bloque no se lee dos veces.
  { const k = parrafos.slice(0, 4).findIndex(p => !p.img && p.t === titulo); if (k >= 0) parrafos.splice(k, 1); }
  if (!parrafos.length) throw new Error('No se encontró texto para leer en esa página.');
  if (!parrafos.some(p => !p.img)) throw new Error('No se encontró texto para leer en esa página.');
  const palabras = parrafos.reduce((s, p) => s + (p.t ? p.t.split(/\s+/).length : 0), 0);
  const res = { url, titulo, sitio, lang: lang || 'es', autor: limpiar(art?.byline) || limpiar(esp && esp.autor) || limpiar(autorLd) || '', parrafos, palabras };
  guardarCache(u, res);
  return res;
}

// ------------------------------------------------------------------ páginas de un sitio
const NO_PAGINA = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|rar|mp3|mp4|webm|avi|mov|css|js|json|xml|txt|docx?|xlsx?|pptx?)(\?|#|$)/i;

async function locsDeSitemap(u, origen, vistos = new Set(), prof = 0) {
  if (prof > 2 || vistos.has(u) || vistos.size > 12) return [];
  vistos.add(u);
  let texto;
  try { ({ texto } = await bajar(u, { limite: 8 * 1024 * 1024 })); } catch { return []; }
  const locs = [...texto.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  if (/<sitemapindex/i.test(texto)) {
    let out = [];
    for (const l of locs.slice(0, 10)) out = out.concat(await locsDeSitemap(l, origen, vistos, prof + 1));
    return out;
  }
  return locs.filter(l => { try { return new URL(l).host === origen.host; } catch { return false; } });
}

async function rastrear(inicio, max = 150) {
  const cola = [inicio.href], vistas = new Set([norm(inicio.href)]), out = [];
  while (cola.length && out.length < max) {
    const u = cola.shift(); out.push(u);
    if (out.length > 40) continue;                                // solo se exploran enlaces de las primeras páginas
    let texto, url;
    try { ({ texto, url } = await bajar(u, { tiempo: 10000 })); } catch { continue; }
    const doc = new JSDOM(texto, { url, virtualConsole: silencio }).window.document;
    for (const a of doc.querySelectorAll('a[href]')) {
      let h; try { h = new URL(a.getAttribute('href'), url); } catch { continue; }
      h.hash = '';
      if (h.host !== inicio.host || NO_PAGINA.test(h.pathname)) continue;
      const k = norm(h.href); if (vistas.has(k)) continue;
      vistas.add(k); cola.push(h.href);
    }
  }
  return out;
}
function norm(u) { return u.replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, ''); }

async function tituloDe(u) {
  try {
    const { texto } = await bajar(u, { limite: 400 * 1024, tiempo: 5000 });
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(texto);
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(texto);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(texto);
    const h1t = h1 ? limpiar(h1[1].replace(/<[^>]+>/g, ' ')) : '';
    // El encabezado visible (H1) distingue mejor las páginas que un <title> repetido en todo el sitio.
    const t = limpiar((h1t.length >= 4 && h1t.length <= 140 && h1t) || (og && og[1]) || (m && m[1]) || '');
    return t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  } catch { return ''; }
}

/* Lo más rápido: los enlaces de la propia portada, con el texto del enlace como título (una sola descarga).
   En un periódico eso son justo las noticias del día. */
function enlacesDePortada(texto, url, origen) {
  const doc = new JSDOM(texto, { url, virtualConsole: silencio }).window.document;
  const out = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    if (a.closest('nav, header, footer, aside, [role=navigation], .menu, .nav, .footer')) continue;
    let h; try { h = new URL(a.getAttribute('href'), url); } catch { continue; }
    h.hash = '';
    if (h.host.replace(/^www\./, '') !== origen.host.replace(/^www\./, '') || NO_PAGINA.test(h.pathname)) continue;
    const camino = h.pathname.replace(/\/+$/, '');
    // Parece un artículo: camino con varias partes o palabras con guiones o un número largo
    if (!(camino.split('/').length >= 3 || /[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(camino) || /\d{4,}/.test(camino))) continue;
    const t = limpiar((a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' '));
    if (t.length < 18 || t.split(' ').length < 4) continue;      // «Leer más», «Deportes»… no son títulos
    const k = norm(h.href), ya = out.get(k);
    if (!ya || t.length > ya.titulo.length) out.set(k, { url: h.href, titulo: t.slice(0, 180) });
  }
  return [...out.values()];
}
const CACHE_SITIO = new Map();

async function paginasDelSitio(u) {
  const clave = String(u).trim().toLowerCase();
  const enCache = CACHE_SITIO.get(clave);
  if (enCache && Date.now() - enCache.t < 10 * 60 * 1000) return enCache.d;            // 10 minutos
  const d = await paginasDelSitioSinCache(u);
  CACHE_SITIO.set(clave, { t: Date.now(), d });
  if (CACHE_SITIO.size > 50) CACHE_SITIO.delete(CACHE_SITIO.keys().next().value);
  return d;
}

async function paginasDelSitioSinCache(u) {
  let inicio = await revisarUrl(/^https?:\/\//i.test(u) ? u : 'https://' + u);
  // Enlaces cortos o de redirección (share.google, bit.ly…): se sigue hasta el sitio de verdad.
  let portada = null;
  try { const r = await bajar(inicio.href, { limite: 3 * 1024 * 1024, tiempo: 12000 }); portada = r; if (r.url && r.url !== inicio.href) inicio = await revisarUrl(r.url); } catch { /* se intenta con lo que hay */ }
  const origen = new URL(inicio.origin);
  // 0) Rápido: las noticias/páginas que enlaza la portada, con su título (sin bajar cada una).
  if (portada && portada.texto) {
    const rapidas = enlacesDePortada(portada.texto, portada.url || inicio.href, origen);
    if (rapidas.length >= 6) return { sitio: origen.host.replace(/^www\./, ''), fuente: 'portada', total: rapidas.length, paginas: rapidas.slice(0, 150) };
  }
  let urls = [];
  // 1) sitemaps declarados en robots.txt, 2) /sitemap.xml y /sitemap_index.xml
  try {
    const { texto } = await bajar(origen.origin + '/robots.txt', { limite: 300 * 1024, tiempo: 8000 });
    for (const m of texto.matchAll(/^\s*sitemap:\s*(\S+)/gim)) urls = urls.concat(await locsDeSitemap(m[1], origen));
  } catch { /* sin robots.txt */ }
  if (!urls.length) for (const s of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    urls = await locsDeSitemap(origen.origin + s, origen); if (urls.length) break;
  }
  let fuente = 'sitemap';
  if (!urls.length) { urls = await rastrear(inicio); fuente = 'enlaces'; }
  // Únicas, solo páginas, y las del mismo camino primero si se pidió una sección.
  const vistos = new Set(); urls = urls.filter(x => { const k = norm(x); if (vistos.has(k) || NO_PAGINA.test(new URL(x).pathname)) return false; vistos.add(k); return true; });
  const seccion = inicio.pathname.replace(/\/+$/, '');
  if (seccion) urls.sort((a, b) => (new URL(b).pathname.startsWith(seccion) ? 1 : 0) - (new URL(a).pathname.startsWith(seccion) ? 1 : 0));
  const total = urls.length; urls = urls.slice(0, 100);
  // Títulos en paralelo (de 16 en 16).
  const paginas = urls.map(url => ({ url, titulo: '' }));
  let i = 0;
  await Promise.all(Array.from({ length: 16 }, async () => { while (i < paginas.length) { const p = paginas[i++]; p.titulo = await tituloDe(p.url); } }));
  return { sitio: origen.host.replace(/^www\./, ''), fuente, total, paginas };
}

// ------------------------------------------------------------------ traductor
/* Traduce una lista de párrafos al idioma elegido.
   Por defecto usa el traductor gratuito de Google (sin clave). Si en el entorno hay
   OPENAI_API_KEY, usa la IA (gpt-4o-mini), que traduce mejor. */
const IDIOMAS = { es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', it: 'italiano', de: 'alemán' };
const CACHE_TRAD = new Map();

async function googleTrad(texto, a) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' + a, {
      method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': AGENTE },
      body: 'q=' + encodeURIComponent(texto),
    });
    if (!r.ok) throw new Error('El traductor no respondió (' + r.status + ').');
    const d = await r.json();
    return { texto: (d[0] || []).map(x => x[0]).join(''), de: d[2] || '' };
  } finally { clearTimeout(t); }
}

async function openaiTrad(parrafos, a) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL_TRAD || 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: `Traduce al ${IDIOMAS[a]} cada elemento del arreglo "p". Responde solo JSON {"p":[...]} con la misma cantidad de elementos, en el mismo orden. Conserva números, unidades y nombres propios.` },
                 { role: 'user', content: JSON.stringify({ p: parrafos }) }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Error del traductor IA.');
  const out = JSON.parse(d.choices[0].message.content).p;
  if (!Array.isArray(out) || out.length !== parrafos.length) throw new Error('Traducción incompleta.');
  return out;
}

async function traducir(parrafos, a) {
  if (!IDIOMAS[a]) throw new Error('Idioma no disponible.');
  parrafos = (Array.isArray(parrafos) ? parrafos : []).slice(0, 400).map(x => String(x || '').slice(0, 5000));
  const clave = a + '|' + parrafos.join('\u0001');
  if (CACHE_TRAD.has(clave)) return CACHE_TRAD.get(clave);
  let out = [], de = '';
  if (process.env.OPENAI_API_KEY) {
    for (let i = 0; i < parrafos.length; i += 40) out = out.concat(await openaiTrad(parrafos.slice(i, i + 40), a));
  } else {
    // Lotes de hasta ~4,500 caracteres separados por una marca que el traductor respeta.
    const SEP = '\n\n§§\n\n';
    let lote = [];
    const vaciar = async () => {
      if (!lote.length) return;
      const r = await googleTrad(lote.join(SEP), a); de = de || r.de;
      let partes = r.texto.split(/\s*§§\s*/).map(x => x.trim());
      if (partes.length !== lote.length) {                       // si se mezclaron, uno por uno
        partes = []; for (const p of lote) { partes.push((await googleTrad(p, a)).texto.trim()); }
      }
      out = out.concat(partes); lote = [];
    };
    let largo = 0;
    for (const p of parrafos) {
      if (largo + p.length > 4500 && lote.length) { await vaciar(); largo = 0; }
      lote.push(p); largo += p.length + 10;
    }
    await vaciar();
  }
  const res = { parrafos: out, de };
  CACHE_TRAD.set(clave, res); if (CACHE_TRAD.size > 200) CACHE_TRAD.delete(CACHE_TRAD.keys().next().value);
  return res;
}

// ------------------------------------------------------------------ listas compartidas (enlace corto)
const DATOS = path.join(RAIZ, 'data'); fs.mkdirSync(DATOS, { recursive: true });
const ARCH_LISTAS = path.join(DATOS, 'listas.json');
let LISTAS = {}; try { LISTAS = JSON.parse(fs.readFileSync(ARCH_LISTAS, 'utf8')); } catch { /* primera vez */ }
const ALFA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoId() { let id; do { id = Array.from({ length: 7 }, () => ALFA[Math.floor(Math.random() * ALFA.length)]).join(''); } while (LISTAS[id]); return id; }
function crearLista({ nombre, items }) {
  const limpios = (Array.isArray(items) ? items : []).slice(0, 150).map(x => x && x.archivo
    ? { // documento subido: viaja su texto ya convertido
      archivo: true, titulo: limpiar(x.titulo).slice(0, 200) || 'Documento', tipo: limpiar(x.tipo).slice(0, 30),
      lang: /^[a-z]{2}$/.test(x.lang) ? x.lang : 'es',
      parrafos: (Array.isArray(x.parrafos) ? x.parrafos : []).slice(0, 20000).map(p => ({ t: limpiar(p && p.t).slice(0, 5000), h: !!(p && p.h) })).filter(p => p.t),
    }
    : { url: String((x && x.url) || '').trim().slice(0, 2000), titulo: limpiar(x && x.titulo).slice(0, 200) },
  ).filter(x => x.archivo ? x.parrafos.length : /^https?:\/\//i.test(x.url));
  if (!limpios.length) throw new Error('La lista no tiene lecturas válidas.');
  const id = nuevoId();
  LISTAS[id] = { nombre: limpiar(nombre).slice(0, 80) || 'Lista de lectura', items: limpios, creada: new Date().toISOString() };
  fs.writeFileSync(ARCH_LISTAS, JSON.stringify(LISTAS));
  return { id };
}

// ------------------------------------------------------------------ voz del servidor (Piper → MP3)
const PIPER = process.env.PIPER_BIN || '/opt/piper/piper/piper';
const VOCES_DIR = process.env.PIPER_VOCES || '/opt/piper/voces';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
// Catálogo de voces. «esc» es el ritmo: >1 habla más despacio. Se midió cada voz y se ajustó a un paso claro
// (~13,5 letras por segundo en español). Daniela, por ejemplo, habla a 20 y quedaba muy rápida.
const CATALOGO = {
  // Narrador: la voz de Claude, más grave y pausada (como un locutor), para distinguir la presentación del texto.
  narrador:     { m: 'es_MX-claude-high', esc: 1.22, l: 'es', nombre: 'Narrador · voz grave · México', af: 'asetrate=22050*0.88,aresample=22050,atempo=1.136' },
  claude:       { m: 'es_MX-claude-high', esc: 1.15, l: 'es', nombre: 'Claude · hombre · México' },
  ald:          { m: 'es_MX-ald-medium', esc: 1.10, l: 'es', nombre: 'Ald · hombre · México' },
  daniela:      { m: 'es_AR-daniela-high', esc: 1.50, l: 'es', nombre: 'Daniela · mujer · Argentina' },
  'sharvard-f': { m: 'es_ES-sharvard-medium', s: 1, esc: 1.26, l: 'es', nombre: 'Sharvard · mujer · España' },
  'sharvard-m': { m: 'es_ES-sharvard-medium', s: 0, esc: 1.24, l: 'es', nombre: 'Sharvard · hombre · España' },
  davefx:       { m: 'es_ES-davefx-medium', esc: 1.28, l: 'es', nombre: 'Davefx · hombre · España' },
  lessac:   { m: 'en_US-lessac-high', esc: 1.08, l: 'en' }, ryan:    { m: 'en_US-ryan-high', esc: 1.08, l: 'en' },
  faber:    { m: 'pt_BR-faber-medium', esc: 1.10, l: 'pt' }, cadu:    { m: 'pt_BR-cadu-medium', esc: 1.10, l: 'pt' },
  siwis:    { m: 'fr_FR-siwis-medium', esc: 1.10, l: 'fr' }, tom:     { m: 'fr_FR-tom-medium', esc: 1.10, l: 'fr' },
  serena:   { m: 'it_IT-serena-high', esc: 1.10, l: 'it' }, paola:   { m: 'it_IT-paola-medium', esc: 1.10, l: 'it' },
  thorsten: { m: 'de_DE-thorsten-high', esc: 1.10, l: 'de' },
};
// Voz de lectura y de presentación por idioma (en español, la de lectura se puede elegir en Ajustes).
const VOCES = {
  es: { lec: 'claude', pres: 'narrador' },
  en: { lec: 'lessac', pres: 'ryan' },
  pt: { lec: 'faber', pres: 'cadu' },
  fr: { lec: 'siwis', pres: 'tom' },
  it: { lec: 'serena', pres: 'paola' },
  de: { lec: 'thorsten', pres: 'thorsten' },
};
const DIR_VOZ = path.join(DATOS, 'voz'); fs.mkdirSync(DIR_VOZ, { recursive: true });
const hayPiper = () => fs.existsSync(PIPER);
const motores = new Map();
/** Un proceso de Piper por voz, siempre cargado: así cada párrafo sale en menos de un segundo. */
function motor(voz) {
  if (motores.has(voz)) return motores.get(voz);
  const c = CATALOGO[voz];
  const args = ['--model', path.join(VOCES_DIR, c.m + '.onnx'), '--json-input', '--sentence_silence', '0.35', '--length_scale', String(c.esc)];
  if (c.s != null) args.push('--speaker', String(c.s));
  const p = spawn(PIPER, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const m = { p, cola: [], buf: '' };
  p.stdout.on('data', d => {
    m.buf += d;
    let k; while ((k = m.buf.indexOf('\n')) >= 0) { const linea = m.buf.slice(0, k).trim(); m.buf = m.buf.slice(k + 1); if (!linea) continue; const t = m.cola.shift(); if (t) t.ok(linea); }
  });
  const caer = () => { motores.delete(voz); m.cola.splice(0).forEach(t => t.mal(new Error('El motor de voz se detuvo.'))); };
  p.on('exit', caer); p.on('error', caer);
  motores.set(voz, m); return m;
}
function sintetizar(voz, texto, wav) {
  return new Promise((ok, mal) => {
    const m = motor(voz), t = setTimeout(() => mal(new Error('La voz tardó demasiado.')), 90000);
    m.cola.push({ ok: x => { clearTimeout(t); ok(x); }, mal: e => { clearTimeout(t); mal(e); } });
    m.p.stdin.write(JSON.stringify({ text: texto, output_file: wav }) + '\n');
  });
}
function aMp3(wav, mp3, filtro) {
  return new Promise((ok, mal) => {
    const tmp = mp3 + '.tmp.mp3';
    const f = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-i', wav, '-af', (filtro ? filtro + ',' : '') + 'apad=pad_dur=0.25', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', tmp], { stdio: 'ignore' });
    f.on('error', mal);
    f.on('exit', c => { if (c === 0) { fs.renameSync(tmp, mp3); ok(); } else mal(new Error('No se pudo convertir el audio.')); });
  });
}
const enCamino = new Map();
/** Texto → dirección de un MP3 (se guarda: lo ya generado no se vuelve a hacer). */
async function voz({ t, l, r, v: elegida }) {
  if (!hayPiper()) { const e = new Error('La voz del servidor no está disponible.'); e.codigo = 503; throw e; }
  const texto = limpiar(t).slice(0, 5000);
  if (!texto) throw new Error('No hay texto.');
  const V = VOCES[String(l || '').slice(0, 2)];
  if (!V) { const e = new Error('Ese idioma no tiene voz en el servidor.'); e.codigo = 422; throw e; }
  let v = V[r === 'pres' ? 'pres' : 'lec'];
  if (CATALOGO[elegida] && CATALOGO[elegida].l === String(l).slice(0, 2)) v = elegida;     // la voz que eligió la persona (lectura o narración)
  if (r === 'pres' && /mujer/.test(CATALOGO[v].nombre || '')) v = V.pres;                  // la narración es siempre con voz de hombre
  const c = CATALOGO[v];
  const h = crypto.createHash('sha1').update(c.m + '|' + (c.s ?? '') + '|' + c.esc + '|' + (c.af || '') + '|' + texto).digest('hex');
  const mp3 = path.join(DIR_VOZ, h + '.mp3'), url = '/voz/' + h + '.mp3';
  if (fs.existsSync(mp3)) { const ahora = new Date(); fs.utimes(mp3, ahora, ahora, () => {}); return { url }; }
  if (!enCamino.has(h)) {
    enCamino.set(h, (async () => {
      const wav = path.join(os.tmpdir(), 'rp-' + h + '.wav');
      try { await sintetizar(v, texto, wav); await aMp3(wav, mp3, c.af); } finally { fs.unlink(wav, () => {}); }
    })().finally(() => enCamino.delete(h)));
  }
  await enCamino.get(h);
  return { url };
}
/** Sirve un MP3 con soporte de rangos (Safari en iPhone lo exige para reproducir audio). */
function servirAudio(req, res, archivo) {
  fs.stat(archivo, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const base = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      let a = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]), b = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
      if (a < 0) a = 0; if (b >= st.size) b = st.size - 1;
      if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      return fs.createReadStream(archivo, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    fs.createReadStream(archivo).pipe(res);
  });
}
if (hayPiper()) setTimeout(() => { try { motor(VOCES.es.lec); motor(VOCES.es.pres); } catch { /* sin voz */ } }, 3000);   // Claude queda lista desde el arranque
// Limpieza: si los audios guardados pasan de 3 GB, se borran los menos usados.
setInterval(() => {
  try {
    const fs_ = fs.readdirSync(DIR_VOZ).filter(f => f.endsWith('.mp3')).map(f => { const st = fs.statSync(path.join(DIR_VOZ, f)); return { f, t: st.mtimeMs, b: st.size }; });
    let total = fs_.reduce((s, x) => s + x.b, 0);
    if (total < 3e9) return;
    fs_.sort((a, b) => a.t - b.t);
    for (const x of fs_) { if (total < 2.5e9) break; fs.unlinkSync(path.join(DIR_VOZ, x.f)); total -= x.b; }
  } catch { /* sin carpeta */ }
}, 3600000).unref();

// ------------------------------------------------------------------ límite de uso por IP
const USO = new Map();
function permitido(ip) {
  const ahora = Date.now(), v = (USO.get(ip) || []).filter(t => ahora - t < 60000);
  v.push(ahora); USO.set(ip, v);
  if (USO.size > 5000) USO.clear();
  return v.length <= 90;
}

// ------------------------------------------------------------------ servidor HTTP
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

async function leerCuerpo(req, max = 1500000) {
  let s = ''; for await (const c of req) { s += c; if (s.length > max) throw new Error('Es demasiado grande para enviarlo (máximo ' + Math.round(max / 1e6) + ' MB).'); }
  return s ? JSON.parse(s) : {};
}

// Cuentas con aprobación: sin una cuenta aprobada no se usa la app (ver cuentas.js).
const cuentas = crearCuentas(RAIZ);

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!permitido(ip)) return json(res, 429, { error: 'Demasiadas solicitudes seguidas. Espera un minuto.' });
      if (url.pathname === '/api/cuenta') return cuentas.apiCuenta(req, res, req.method === 'POST' ? await leerCuerpo(req, 20000) : null, json, ip);
      if (url.pathname === '/api/admin') return cuentas.apiAdmin(req, res, req.method === 'POST' ? await leerCuerpo(req, 20000) : null, json, ip);
      // El resto de la API es solo para cuentas aprobadas.
      if (url.pathname !== '/api/salud' && !cuentas.aprobado(req)) return json(res, 401, { error: 'Inicia sesión en ReadPage.', sinSesion: true });
      if (req.method === 'POST' && url.pathname === '/api/extraer') {
        const { url: u } = await leerCuerpo(req);
        const d = await extraer(String(u || '').trim());
        // Portada de un sitio (p. ej. un periódico): son titulares sueltos, no un texto para leer.
        const cortos = d.parrafos.filter(p => p.t.split(/\s+/).length < 6).length;
        const portada = new URL(d.url).pathname.replace(/\/+$/, '') === '' && (d.parrafos.length < 5 || cortos / d.parrafos.length > 0.35);
        return json(res, 200, portada ? { ...d, portada: true } : d);
      }
      if (req.method === 'POST' && url.pathname === '/api/clasificar') {
        const { url: u } = await leerCuerpo(req, 20000);
        return json(res, 200, await clasificarEnlace(String(u || '').trim()));
      }
      if (req.method === 'POST' && url.pathname === '/api/escuchar') {
        const wav = await leerCrudo(req, 300000);
        const palabras = decodeURIComponent(String(req.headers['x-palabras'] || '')).slice(0, 120);
        const quien = (cuentas.aprobado(req) || {}).id || ip;
        return json(res, 200, { texto: await transcribirOrden(wav, palabras, quien) });
      }
      if (req.method === 'POST' && url.pathname === '/api/orden') {
        const b = await leerCuerpo(req, 400000);
        const cola = (Array.isArray(b.cola) ? b.cola : []).slice(0, 300).map(x => ({ id: String(x.id || ''), n: Number(x.n) || 0, tipo: x.tipo === 'video' ? 'video' : 'lectura',
          titulo: String(x.titulo || '').slice(0, 160), sitio: String(x.sitio || '').slice(0, 60), ruta: String(x.ruta || '').slice(0, 160), estado: x.estado === 'visto' ? 'visto' : 'pendiente', min: Number(x.min) || 0 }));
        return json(res, 200, await entenderOrden(String(b.orden || '').slice(0, 300), cola, b.vista === 'videos' ? 'videos' : 'lecturas'));
      }
      if (req.method === 'POST' && url.pathname === '/api/video') {
        const { url: u } = await leerCuerpo(req);
        await revisarUrl(String(u || '').trim());
        return json(res, 200, await datosVideo(String(u).trim()));
      }
      if (req.method === 'POST' && url.pathname === '/api/sitio') {
        const { url: u } = await leerCuerpo(req);
        return json(res, 200, await paginasDelSitio(String(u || '').trim()));
      }
      if (req.method === 'POST' && url.pathname === '/api/traducir') { const b = await leerCuerpo(req, 4000000); return json(res, 200, await traducir(b.parrafos, String(b.a || 'es'))); }
      if (req.method === 'POST' && url.pathname === '/api/lista') return json(res, 200, crearLista(await leerCuerpo(req, 8000000)));
      const ml = /^\/api\/lista\/([A-Za-z0-9]{4,12})$/.exec(url.pathname);
      if (ml) return LISTAS[ml[1]] ? json(res, 200, LISTAS[ml[1]]) : json(res, 404, { error: 'Esa lista no existe o fue borrada.' });
      if (url.pathname === '/api/salud') return json(res, 200, { ok: true, voz: hayPiper() ? Object.keys(VOCES) : [],
        vocesEs: hayPiper() ? Object.entries(CATALOGO).filter(([, c]) => c.l === 'es').map(([id, c]) => ({ id, nombre: c.nombre })) : [] });
      if (req.method === 'POST' && url.pathname === '/api/voz') {
        try { return json(res, 200, await voz(await leerCuerpo(req, 60000))); }
        catch (e) { return json(res, e.codigo || 400, { error: e.message || 'No se pudo generar la voz.' }); }
      }
      return json(res, 404, { error: 'No existe.' });
    }
    const mv = /^\/voz\/([0-9a-f]{40})\.mp3$/.exec(url.pathname);
    if (mv) return servirAudio(req, res, path.join(DIR_VOZ, mv[1] + '.mp3'));
    // «Compartir → ReadPage» antes de que el service worker esté activo: se abre la app con el texto/enlace.
    if (req.method === 'POST' && url.pathname === '/compartir' && !cuentas.aprobado(req)) { res.writeHead(303, { Location: '/' }); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/compartir') {
      let q = ''; try { const ct = req.headers['content-type'] || ''; if (/urlencoded/.test(ct)) { let b = ''; for await (const c of req) { b += c; if (b.length > 100000) break; } q = b; } } catch { /* sin datos */ }
      res.writeHead(303, { Location: '/' + (q ? '?' + q : '') }); return res.end();
    }
    // Archivos de la app.
    let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
    if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
    // Sin cuenta aprobada, en vez de la app se muestra la página de acceso (inscripción e ingreso).
    const conAcceso = !!cuentas.aprobado(req);
    if (rel === '/index.html' && !conAcceso) rel = '/acceso.html';
    if (rel === '/favicon.ico') rel = '/icons/favicon.png';
    const archivo = path.normalize(path.join(PUBLICO, rel));
    if (!archivo.startsWith(PUBLICO)) { res.writeHead(403); return res.end(); }
    fs.readFile(archivo, (err, data) => {
      if (err && /\.[a-z0-9]{1,8}$|\/\./i.test(rel)) {
        // Un archivo que no existe (o uno oculto como /.env) es un 404, no la app.
        // Si piden estilos o scripts que no son nuestros, es una copia vieja de otra página guardada en el
        // navegador (la de «en construcción» de SiteGround): se le ordena borrar su caché de este sitio.
        const h = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
        if (/\.(css|js)$/i.test(rel)) h['Clear-Site-Data'] = '"cache"';
        res.writeHead(404, h); return res.end('No existe.');
      }
      if (err) { // la app es de una sola página: las rutas sin archivo (/l/<id>…) cargan el inicio
        return fs.readFile(path.join(PUBLICO, conAcceso ? 'index.html' : 'acceso.html'), 'utf8', (e2, d2) => {
          if (e2) { res.writeHead(404); return res.end(); }
          // Enlace de una lista: la vista previa (WhatsApp, Facebook…) muestra su nombre y cuántas lecturas trae.
          const ml = /^\/l\/([A-Za-z0-9]{4,12})\/?$/.exec(rel), L = ml && LISTAS[ml[1]];
          if (L) {
            const e = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const n = L.items.length, tit = `🎧 ${L.nombre} · ${n} lectura${n === 1 ? '' : 's'}`;
            const desc = L.items.slice(0, 4).map((x, i) => `${i + 1}. ${x.titulo || x.url || 'Documento'}`).join(' · ') + (n > 4 ? ` · y ${n - 4} más` : '');
            d2 = d2.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${e(tit)}">`)
              .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${e('Escúchalas en ReadPage: ' + desc)}">`)
              .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="https://readpage.nesuxglobalbusinessrd.com${e(rel)}">`)
              .replace(/<title>[^<]*<\/title>/, `<title>${e(tit)} · ReadPage</title>`);
          }
          res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-cache' }); res.end(d2);
        });
      }
      const ext = path.extname(archivo).toLowerCase();
      const cache = ext === '.html' || archivo.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': TIPOS[ext] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: e.message || 'No se pudo procesar.' });
  }
});

servidor.listen(PUERTO, '127.0.0.1', () => console.log(`ReadPage en http://127.0.0.1:${PUERTO}`));
