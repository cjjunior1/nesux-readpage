/**
 * ReadPage — cuentas con aprobación (igual que la Academy de Nutrilife).
 *
 * Quien quiere usar ReadPage se inscribe (nombre, WhatsApp, correo, contraseña) y queda
 * PENDIENTE hasta que el administrador lo aprueba en /admin. Sin aprobación no hay acceso
 * a la app ni a sus funciones (extraer páginas, traducir, voz, listas).
 *
 * Datos en data/cuentas/:
 *   usuarios.json        cuentas (contraseña cifrada con scrypt) y su estado
 *   bitacora/<id>.jsonl  lo que pasa con cada cuenta (solo se agregan líneas)
 * Sesión: cookie firmada con HMAC; no se puede falsificar sin el secreto del servidor.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function crearCuentas(RAIZ) {
  const DIR = path.join(RAIZ, 'data', 'cuentas');
  fs.mkdirSync(path.join(DIR, 'bitacora'), { recursive: true });
  const F = path.join(DIR, 'usuarios.json');

  const secreto = (nombre, env) => {
    if (env && process.env[env]) return process.env[env];
    const f = path.join(DIR, nombre);
    try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* se crea */ }
    const s = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(f, s, { mode: 0o600 }); return s;
  };
  const SECRETO = () => secreto('.secreto-sesion', 'READPAGE_SECRETO');
  const claveAdmin = () => secreto('.clave-admin', 'READPAGE_ADMIN_CLAVE');

  const usuarios = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return []; } };
  const guardar = u => { const t = F + '.tmp'; fs.writeFileSync(t, JSON.stringify(u, null, 1)); fs.renameSync(t, F); };
  const publico = ({ hash, sal, ...u }) => (void hash, void sal, u);
  const cifrar = (clave, sal) => crypto.scryptSync(String(clave), sal, 64).toString('hex');
  const normCorreo = c => String(c || '').trim().toLowerCase();
  const normTel = t => String(t || '').replace(/\D/g, '');
  const anotar = (id, tipo, datos = {}) => fs.appendFileSync(path.join(DIR, 'bitacora', id.replace(/[^a-f0-9]/g, '') + '.jsonl'), JSON.stringify({ t: new Date().toISOString(), tipo, ...datos }) + '\n');

  function registrar(d, estado = 'pendiente') {
    const nombre = String(d.nombre || '').trim().slice(0, 80), correo = normCorreo(d.correo).slice(0, 120), whatsapp = normTel(d.whatsapp).slice(0, 20), clave = String(d.clave || '');
    if (nombre.length < 2) throw new Error('Escribe tu nombre completo.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) throw new Error('El correo no es válido.');
    if (whatsapp.length < 10) throw new Error('Escribe tu número de WhatsApp con código de área.');
    if (clave.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
    const lista = usuarios();
    if (lista.some(u => u.correo === correo)) throw new Error('Ya existe una inscripción con ese correo.');
    if (lista.some(u => u.whatsapp === whatsapp)) throw new Error('Ya existe una inscripción con ese WhatsApp.');
    const sal = crypto.randomBytes(16).toString('hex');
    const u = { id: crypto.randomBytes(8).toString('hex'), nombre, whatsapp, correo, sal, hash: cifrar(clave, sal), estado, creado: new Date().toISOString() };
    if (estado === 'aprobado') u.aprobado = u.creado;
    lista.push(u); guardar(lista); anotar(u.id, 'inscripcion', { nombre, correo, whatsapp, estado });
    return publico(u);
  }
  function verificar(usuario, clave) {
    const c = normCorreo(usuario), t = normTel(usuario);
    const u = usuarios().find(x => x.correo === c || (t.length >= 10 && x.whatsapp === t));
    if (!u) return null;
    const a = Buffer.from(u.hash, 'hex'), b = Buffer.from(cifrar(clave, u.sal), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
  }
  function cambiarEstado(id, estado) {
    const lista = usuarios(), u = lista.find(x => x.id === id);
    if (!u) throw new Error('No existe esa inscripción.');
    u.estado = estado; if (estado === 'aprobado') u.aprobado = new Date().toISOString();
    guardar(lista); anotar(id, 'estado-cuenta', { estado }); return publico(u);
  }

  /**
   * El usuario cambia su perfil: nombre, WhatsApp y correo quedan PENDIENTES hasta que el administrador
   * los apruebe; la contraseña es la excepción y se cambia al instante. Siempre pide la contraseña actual.
   */
  function solicitarCambio(id, d) {
    const lista = usuarios(), u = lista.find(x => x.id === id);
    if (!u) throw new Error('No existe esa cuenta.');
    const a = Buffer.from(u.hash, 'hex'), b = Buffer.from(cifrar(String(d.claveActual || ''), u.sal), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Tu contraseña actual no es correcta.');
    const c = { fecha: new Date().toISOString() };
    const nombre = String(d.nombre ?? '').trim().slice(0, 80), correo = normCorreo(d.correo).slice(0, 120), whatsapp = normTel(d.whatsapp).slice(0, 20);
    if (nombre && nombre !== u.nombre) { if (nombre.length < 2) throw new Error('Escribe tu nombre completo.'); c.nombre = nombre; }
    if (correo && correo !== u.correo) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) throw new Error('El correo no es válido.');
      if (lista.some(x => x.id !== id && x.correo === correo)) throw new Error('Ese correo ya pertenece a otra cuenta.');
      c.correo = correo;
    }
    if (whatsapp && whatsapp !== u.whatsapp) {
      if (whatsapp.length < 10) throw new Error('Escribe el WhatsApp con código de área.');
      if (lista.some(x => x.id !== id && x.whatsapp === whatsapp)) throw new Error('Ese WhatsApp ya pertenece a otra cuenta.');
      c.whatsapp = whatsapp;
    }
    const clave = !!d.claveNueva;
    if (clave) {
      if (String(d.claveNueva).length < 8) throw new Error('La contraseña nueva debe tener al menos 8 caracteres.');
      u.sal = crypto.randomBytes(16).toString('hex'); u.hash = cifrar(d.claveNueva, u.sal);
    }
    const datos = !!(c.nombre || c.correo || c.whatsapp);
    if (!datos && !clave) throw new Error('No cambiaste ningún dato.');
    if (datos) u.cambio = c;
    guardar(lista);
    if (clave) anotar(id, 'clave-cambiada');
    if (datos) anotar(id, 'cambio-solicitado', { nombre: c.nombre, correo: c.correo, whatsapp: c.whatsapp });
    return { usuario: publico(u), clave, datos };
  }
  /** El administrador aprueba (se aplican los datos nuevos) o rechaza (se descartan) el cambio pendiente. */
  function resolverCambio(id, aprobar) {
    const lista = usuarios(), u = lista.find(x => x.id === id);
    if (!u || !u.cambio) throw new Error('No hay un cambio pendiente.');
    const c = u.cambio;
    if (aprobar) {
      if (c.correo && lista.some(x => x.id !== id && x.correo === c.correo)) throw new Error('Ese correo ya lo usa otra cuenta.');
      if (c.whatsapp && lista.some(x => x.id !== id && x.whatsapp === c.whatsapp)) throw new Error('Ese WhatsApp ya lo usa otra cuenta.');
      anotar(id, 'cambio-aprobado', { antes: { nombre: u.nombre, correo: u.correo, whatsapp: u.whatsapp }, nombre: c.nombre, correo: c.correo, whatsapp: c.whatsapp });
      if (c.nombre) u.nombre = c.nombre;
      if (c.correo) u.correo = c.correo;
      if (c.whatsapp) u.whatsapp = c.whatsapp;
    } else anotar(id, 'cambio-rechazado', { nombre: c.nombre, correo: c.correo, whatsapp: c.whatsapp });
    delete u.cambio; guardar(lista);
    return publico(u);
  }

  // ── cookies firmadas
  const firmar = x => crypto.createHmac('sha256', SECRETO()).update(x).digest('base64url');
  const ficha = (id, dias) => { const v = `${id}.${Date.now() + dias * 864e5}`; return `${v}.${firmar(v)}`; };
  const leerFicha = f => {
    if (!f) return null;
    const [id, exp, sig] = f.split('.');
    if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
    const e = firmar(`${id}.${exp}`);
    return sig.length === e.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(e)) ? id : null;
  };
  const leerCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const seguro = req => String(req.headers['x-forwarded-proto'] || '').includes('https');
  const cookie = (req, nombre, valor, dias) => `${nombre}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(dias * 86400)}${seguro(req) ? '; Secure' : ''}`;
  const COOKIE = 'rp_sesion', COOKIE_ADMIN = 'rp_admin';

  const alumno = req => { const id = leerFicha(leerCookies(req)[COOKIE]); return id ? usuarios().find(u => u.id === id) || null : null; };
  const aprobado = req => { const u = alumno(req); return u && u.estado === 'aprobado' ? u : null; };
  const esAdmin = req => leerFicha(leerCookies(req)[COOKIE_ADMIN]) === 'admin';

  // Freno contra intentos repetidos (por IP).
  const intentos = new Map();
  const permitido = (ip, max = 20) => { const a = Date.now(), v = (intentos.get(ip) || []).filter(t => a - t < 10 * 60000); v.push(a); intentos.set(ip, v); if (intentos.size > 5000) intentos.clear(); return v.length <= max; };

  /** POST/GET /api/cuenta — inscripción, ingreso, salida y «quién soy». */
  async function apiCuenta(req, res, cuerpo, json, ip) {
    if (req.method === 'GET') { const u = alumno(req); return json(res, 200, { usuario: u ? publico(u) : null }); }
    const b = cuerpo || {};
    try {
      if (b.accion === 'registro') { if (!permitido(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' }); return json(res, 200, { ok: true, usuario: registrar(b) }); }
      if (b.accion === 'entrar') {
        if (!permitido(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
        const u = verificar(b.usuario, b.clave);
        if (!u) return json(res, 401, { error: 'Correo, WhatsApp o contraseña incorrectos.' });
        if (u.estado === 'rechazado') return json(res, 403, { error: 'Tu inscripción no fue aprobada.' });
        res.setHeader('Set-Cookie', cookie(req, COOKIE, ficha(u.id, 60), 60));
        const lista = usuarios(), x = lista.find(y => y.id === u.id); x.ultimoAcceso = new Date().toISOString(); guardar(lista); anotar(u.id, 'acceso');
        return json(res, 200, { ok: true, usuario: publico(u) });
      }
      if (b.accion === 'salir') { res.setHeader('Set-Cookie', cookie(req, COOKIE, '', 0)); return json(res, 200, { ok: true }); }
      if (b.accion === 'cambio') {
        const u = aprobado(req); if (!u) return json(res, 401, { error: 'Inicia sesión en ReadPage.' });
        if (!permitido(ip)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
        return json(res, 200, { ok: true, ...solicitarCambio(u.id, b) });
      }
      return json(res, 400, { error: 'Acción desconocida.' });
    } catch (e) { return json(res, 400, { error: e.message || 'No se pudo completar.' }); }
  }

  /** GET/POST /api/admin — panel: inscripciones, aprobar, rechazar, bitácora. */
  async function apiAdmin(req, res, cuerpo, json, ip) {
    const b = cuerpo || {};
    if (req.method === 'POST' && b.accion === 'entrar') {
      if (!permitido('admin:' + ip, 10)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
      const a = Buffer.from(String(b.clave || '')), c = Buffer.from(claveAdmin());
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return json(res, 401, { error: 'Clave incorrecta.' });
      res.setHeader('Set-Cookie', cookie(req, COOKIE_ADMIN, ficha('admin', 1), 1)); return json(res, 200, { ok: true });
    }
    if (!esAdmin(req)) return json(res, 401, { error: 'Sin acceso.' });
    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id');
      if (id) {
        const u = usuarios().find(x => x.id === id); if (!u) return json(res, 404, { error: 'No existe.' });
        let bit = []; try { bit = fs.readFileSync(path.join(DIR, 'bitacora', id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* sin bitácora */ }
        return json(res, 200, { usuario: publico(u), bitacora: bit });
      }
      const lista = usuarios().map(publico).sort((a, b) => (a.estado === 'pendiente' ? -1 : 0) - (b.estado === 'pendiente' ? -1 : 0) || b.creado.localeCompare(a.creado));
      return json(res, 200, { usuarios: lista });
    }
    if (b.accion === 'salir') { res.setHeader('Set-Cookie', cookie(req, COOKIE_ADMIN, '', 0)); return json(res, 200, { ok: true }); }
    if (['aprobar', 'rechazar', 'pendiente'].includes(b.accion) && b.id) {
      try { return json(res, 200, { ok: true, usuario: cambiarEstado(b.id, b.accion === 'aprobar' ? 'aprobado' : b.accion === 'rechazar' ? 'rechazado' : 'pendiente') }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (['aprobar-cambio', 'rechazar-cambio'].includes(b.accion) && b.id) {
      try { return json(res, 200, { ok: true, usuario: resolverCambio(b.id, b.accion === 'aprobar-cambio') }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    return json(res, 400, { error: 'Acción desconocida.' });
  }

  return { registrar, aprobado, alumno, apiCuenta, apiAdmin, usuarios };
}
