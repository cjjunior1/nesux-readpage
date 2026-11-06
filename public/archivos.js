/* ReadPage · Nesux — convierte archivos a texto para leerlos en voz.
   Todo ocurre en el equipo de la persona: el archivo no se sube a ningún servidor.
   PDF (pdf.js), Word .docx (mammoth), EPUB (jszip), TXT / Markdown / HTML / subtítulos / RTF,
   e imágenes o PDF escaneados con reconocimiento de texto (Tesseract, español + inglés). */
(function () {
  'use strict';
  const LIBS = {
    pdf: '/vendor/pdf.min.js', pdfw: '/vendor/pdf.worker.min.js',
    docx: '/vendor/mammoth.browser.min.js', zip: '/vendor/jszip.min.js',
    ocr: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  };
  const MAX_MB = 80;
  const cargadas = {};
  function cargarLib(src) {
    return cargadas[src] || (cargadas[src] = new Promise((ok, mal) => {
      const s = document.createElement('script'); s.src = src; s.onload = ok;
      s.onerror = () => { delete cargadas[src]; mal(new Error('No se pudo cargar el lector de este tipo de archivo (revisa tu conexión).')); };
      document.head.appendChild(s);
    }));
  }

  // ------------------------------------------------------------ texto → párrafos
  const limpio = t => String(t || '').replace(/\s+/g, ' ').trim();
  /** Parte un texto en párrafos: las líneas seguidas se unen y una línea en blanco separa. */
  function aParrafos(texto, md) {
    const out = []; let buf = [];
    const cerrar = () => {
      if (!buf.length) return;
      const t = limpio(buf.join(' ')); buf = [];
      if (t && !/^[\d\s.\-–|/]{1,8}$/.test(t)) out.push({ t, h: false });     // fuera números de página sueltos
    };
    String(texto).replace(/\r\n?/g, '\n').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').split('\n').forEach(l => {
      const s = l.trim();
      if (!s) return cerrar();
      if (md) {
        const m = /^#{1,6}\s+(.*)$/.exec(s);
        if (m) { cerrar(); out.push({ t: limpio(m[1].replace(/[*_`]/g, '')), h: true }); return; }
        if (/^([-*+]|\d+[.)])\s+/.test(s)) cerrar();
        buf.push(s.replace(/^[-*+>]\s+/, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''));
        return;
      }
      buf.push(s);
    });
    cerrar(); return partirLargos(out);
  }
  /** Los bloques enormes (texto sin líneas en blanco) se parten por oraciones para poder resaltarlos. */
  function partirLargos(ps) {
    const out = [];
    ps.forEach(p => {
      if (p.h || p.t.length <= 1200) return out.push(p);
      let cur = '';
      (p.t.match(/[^.!?…]+[.!?…]+["»”')\]]*\s*|[^.!?…]+$/g) || [p.t]).forEach(o => {
        if (cur && (cur + o).length > 700) { out.push({ t: cur.trim(), h: false }); cur = ''; }
        cur += o;
      });
      if (cur.trim()) out.push({ t: cur.trim(), h: false });
    });
    return out;
  }
  /** Párrafos de un documento HTML (también lo usan Word y EPUB). */
  function deHtml(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('script,style,noscript,nav,svg,math').forEach(e => e.remove());
    const out = [];
    d.body && d.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,td,th').forEach(e => {
      if (e.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote,td')) return;      // solo los bloques finales
      const t = limpio(e.textContent); if (t) out.push({ t, h: /^H\d$/.test(e.tagName) });
    });
    const titulo = limpio((d.querySelector('h1') || {}).textContent) || limpio((d.querySelector('title') || {}).textContent);
    return { titulo, parrafos: out.length ? partirLargos(out) : aParrafos(d.body ? d.body.textContent : '') };
  }

  // ------------------------------------------------------------ idioma (para la voz y el traductor)
  const MARCAS = {
    es: 'el los las del por una con para que se es y está como pero más también', en: 'the and of to is in that it for you with are this was have',
    pt: 'não uma com os do da em são ao também mais pelo pela você', fr: 'le les des et est une pour dans pas qui sur avec cette sont',
    it: 'il che di per non una sono della gli nel anche questo come', de: 'der die und das ist nicht ein ich zu mit den sie auch auf',
  };
  function detectarIdioma(t) {
    const w = ' ' + String(t).toLowerCase().slice(0, 30000).replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ') + ' ';
    let mejor = 'es', max = 0;
    for (const [k, lista] of Object.entries(MARCAS)) {
      let c = 0; lista.split(' ').forEach(p => { c += w.split(' ' + p + ' ').length - 1; });
      if (c > max) { max = c; mejor = k; }
    }
    return mejor;
  }

  // ------------------------------------------------------------ OCR (imágenes y PDF escaneados)
  let trabajador = null, avanceOcr = () => {};
  async function ocr(imagen, avance) {
    await cargarLib(LIBS.ocr);
    avanceOcr = avance;
    if (!trabajador) trabajador = window.Tesseract.createWorker('spa+eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') avanceOcr(`Reconociendo el texto… ${Math.round(m.progress * 100)} %`);
        else if (/loading/i.test(m.status)) avanceOcr('Preparando el lector de imágenes (solo la primera vez)…');
      },
    }).catch(e => { trabajador = null; throw e; });
    const w = await trabajador;
    const { data } = await w.recognize(imagen);
    return data.text || '';
  }

  // ------------------------------------------------------------ cada tipo
  async function leerPdf(file, avance) {
    await cargarLib(LIBS.pdf);
    const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfw;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let titulo = ''; try { const md = await doc.getMetadata(); titulo = limpio(md.info && md.info.Title); } catch (_) {}
    if (/\.(html?|docx?|pdf|txt|odt)$|^(untitled|sin t[ií]tulo|documento\d*)$|microsoft word|^\W*$/i.test(titulo)) titulo = '';   // metadatos de relleno
    let texto = '', escaneadas = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      avance(`Leyendo página ${n} de ${doc.numPages}…`);
      const pg = await doc.getPage(n), tc = await pg.getTextContent();
      let t = '', y = null, alto = 0;
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const yy = it.transform[5], h = Math.abs(it.transform[3]) || 10;
        if (y !== null && Math.abs(yy - y) > h * 0.5) t += Math.abs(y - yy) > Math.max(h, alto) * 1.75 ? '\n\n' : '\n';
        t += it.str;
        if (it.str.trim()) { y = yy; alto = h; }
      }
      if (t.replace(/\s/g, '').length < 25) {                       // página escaneada: se convierte a texto con OCR
        escaneadas++;
        const vp = pg.getViewport({ scale: 2 }), c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        t = await ocr(c, p => avance(`Página ${n} de ${doc.numPages} (escaneada) · ${p}`));
      }
      texto += t + '\n\n';
    }
    return { titulo, parrafos: aParrafos(texto), nota: escaneadas ? `${escaneadas} página${escaneadas > 1 ? 's' : ''} escaneada${escaneadas > 1 ? 's' : ''} con OCR` : '' };
  }
  async function leerDocx(file) {
    await cargarLib(LIBS.docx);
    const r = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    return deHtml(r.value);
  }
  async function leerEpub(file, avance) {
    await cargarLib(LIBS.zip);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const xml = s => new DOMParser().parseFromString(s, 'application/xml');
    const cont = xml(await zip.file('META-INF/container.xml').async('string'));
    const ruta = cont.querySelector('rootfile').getAttribute('full-path'), base = ruta.includes('/') ? ruta.replace(/[^/]+$/, '') : '';
    const opf = xml(await zip.file(ruta).async('string'));
    const titulo = limpio((opf.getElementsByTagName('dc:title')[0] || {}).textContent);
    const man = {}; opf.querySelectorAll('manifest > item').forEach(i => { man[i.getAttribute('id')] = i.getAttribute('href'); });
    const orden = [...opf.querySelectorAll('spine > itemref')].map(i => man[i.getAttribute('idref')]).filter(Boolean);
    const parrafos = [];
    for (let k = 0; k < orden.length; k++) {
      avance(`Leyendo capítulo ${k + 1} de ${orden.length}…`);
      const f = zip.file(decodeURIComponent(base + orden[k]).replace(/#.*$/, ''));
      if (f) parrafos.push(...deHtml(await f.async('string')).parrafos);
    }
    return { titulo, parrafos };
  }
  function deRtf(s) {
    return s.replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? +n + 65536 : +n))
      .replace(/\\par[d]?\b/g, '\n\n').replace(/\\line\b/g, '\n').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  }
  function deSubtitulos(s) {
    return s.split(/\r?\n/).filter(l => !/^\s*\d+\s*$/.test(l) && !/-->/.test(l) && !/^WEBVTT/.test(l)).map(l => l.replace(/<[^>]+>/g, '')).join('\n');
  }

  const ext = n => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const TIPOS = { pdf: 'PDF', docx: 'Word', epub: 'Libro EPUB', txt: 'Texto', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML', rtf: 'RTF', srt: 'Subtítulos', vtt: 'Subtítulos', csv: 'Texto', json: 'Texto', xml: 'Texto' };
  const esImagen = f => /^image\//.test(f.type) || /^(png|jpe?g|webp|bmp|gif|tiff?|heic)$/.test(ext(f.name));
  const nombreBonito = n => limpio(String(n).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '));

  /** Lee un archivo y devuelve { titulo, parrafos:[{t,h}], lang, tipo, palabras, nota }. */
  async function leer(file, avance = () => {}) {
    if (file.size > MAX_MB * 1024 * 1024) throw new Error(`El archivo pasa de ${MAX_MB} MB.`);
    const e = ext(file.name); let r, tipo = TIPOS[e];
    if (e === 'doc') throw new Error('Los .doc antiguos no se pueden leer: guárdalo como .docx o PDF.');
    if (esImagen(file)) {
      if (e === 'heic') throw new Error('Las fotos HEIC no se pueden leer aquí: compártela como JPG.');
      tipo = 'Imagen'; avance('Reconociendo el texto de la imagen…');
      r = { titulo: '', parrafos: aParrafos(await ocr(file, avance)) };
      if (r.parrafos[0] && r.parrafos[0].t.length <= 90) r.titulo = r.parrafos[0].t;      // en fotos y capturas, la primera línea es el título
    } else if (e === 'pdf' || file.type === 'application/pdf') { tipo = 'PDF'; r = await leerPdf(file, avance); }
    else if (e === 'docx') r = await leerDocx(file);
    else if (e === 'epub') r = await leerEpub(file, avance);
    else {
      const s = await file.text();
      if (e === 'html' || e === 'htm' || /^\s*<(!doctype|html)/i.test(s)) { tipo = 'HTML'; r = deHtml(s); }
      else if (e === 'rtf' || /^\{\\rtf/.test(s)) { tipo = 'RTF'; r = { titulo: '', parrafos: aParrafos(deRtf(s)) }; }
      else if (e === 'srt' || e === 'vtt') r = { titulo: '', parrafos: aParrafos(deSubtitulos(s)) };
      else if (/^(txt|md|markdown|csv|json|xml|log)$/.test(e) || /^text\//.test(file.type) || !/[\x00-\x08]/.test(s.slice(0, 2000))) {
        tipo = tipo || 'Texto'; r = { titulo: '', parrafos: aParrafos(s, e === 'md' || e === 'markdown') };
      } else throw new Error('Este tipo de archivo no se puede leer. Prueba con PDF, Word (.docx), EPUB, texto o una imagen.');
    }
    const parrafos = r.parrafos.filter(p => p.t);
    if (!parrafos.length) throw new Error(tipo === 'Imagen' ? 'No encontré texto en la imagen. Prueba con una foto más nítida y derecha.' : 'No encontré texto para leer en este archivo.');
    const todo = parrafos.map(p => p.t).join(' ');
    return {
      titulo: r.titulo || nombreBonito(file.name) || 'Documento', parrafos, tipo: tipo || 'Archivo', nota: r.nota || '',
      lang: detectarIdioma(todo), palabras: todo.split(/\s+/).filter(Boolean).length,
    };
  }

  window.RPArchivos = { leer, ACEPTA: '.pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm,.rtf,.srt,.vtt,.csv,.json,image/*' };
})();
