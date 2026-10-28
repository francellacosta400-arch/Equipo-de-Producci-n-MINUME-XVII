// Equipo de Producción MINUME XVII
// Sirve la página y guarda todo en la base de datos D1 (binding "DB").
// - Leer es público.
// - Crear y editar actividades de las regionales: abierto al equipo (si defines TEAM_KEY, pide esa clave).
// - Borrar actividades, editar agenda y roles, área privada y diseño: solo con ADMIN_KEY.
// - Cada cambio en una actividad se envía a la hoja de Google general (si defines SHEETS_URL y SHEETS_SECRET).

const REGIONAL = /^(0[1-9]|1[0-8])$/;
const ESTADOS = ['pendiente', 'proceso', 'listo'];
const TABLAS_ACT = ['produccion', 'maquillaje', 'vestuario', 'musica', 'escenografia', 'utileria'];
const ETIQUETAS_TABLA = { produccion: 'Producción', maquillaje: 'Maquillaje', vestuario: 'Vestuario', musica: 'Música', escenografia: 'Escenografía', utileria: 'Utilería' };
const TIPOS_TABLA = ['agenda', 'roles'];
const LOGOS = ['horiz', '2026', 'mark', 'gob', 'plerd', 'minume'];
const FONDOS = ['azul', 'cielo', 'noche', 'royal', 'violeta'];
const ACENTOS = ['aqua', 'rosa', 'cielo', 'rojo'];
const BOTONES = ['azul', 'royal', 'cielo', 'noche'];
const TITULO_GENERAL = 'XVII Modelo Internacional de las Naciones Unidas del Ministerio de Educación';
const MAX_ACTIVIDADES = 500;
const MAX_TABLAS = 60;
const MAX_CUERPO = 150000;
const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const fallo = (error, status, extra) => json({ ok: false, error, ...(extra || {}) }, status);
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function urlHoja(raw) {
  try {
    const t = String(raw || '').trim();
    if (t.length > 2000) return null;
    const u = new URL(t);
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/spreadsheets/')) return null;
    return u.href;
  } catch (e) { return null; }
}

// ---------- claves ----------
async function mismaClave(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function esAdmin(request, env) {
  const dada = request.headers.get('X-Admin-Key') || '';
  return !!(env.ADMIN_KEY && dada && (await mismaClave(dada, String(env.ADMIN_KEY))));
}
// Devuelve null si es admin, o la respuesta de error.
async function exigirAdmin(request, env) {
  if (!env.ADMIN_KEY) return fallo('Falta configurar la clave de administrador (ADMIN_KEY) en Cloudflare.', 503);
  if (!(await esAdmin(request, env))) return fallo('Clave incorrecta.', 401);
  return null;
}
// Equipo: abierto salvo que exista TEAM_KEY. El administrador siempre puede.
async function exigirEquipo(request, env) {
  if (!env.TEAM_KEY) return null;
  if (await esAdmin(request, env)) return null;
  const dada = request.headers.get('X-Team-Key') || '';
  if (dada && (await mismaClave(dada, String(env.TEAM_KEY)))) return null;
  return fallo('Escribe la clave del equipo para editar.', 401, { codigo: 'equipo' });
}

async function leerCuerpo(request, max) {
  const texto = await request.text();
  if (texto.length > max) return { error: fallo('Datos demasiado grandes.', 413) };
  try {
    const v = JSON.parse(texto);
    if (!v || typeof v !== 'object') return { error: fallo('Datos inválidos.', 400) };
    return { v };
  } catch (e) { return { error: fallo('Datos inválidos.', 400) }; }
}

// ---------- base de datos ----------
let lista = false;
async function preparar(env) {
  if (lista) return;
  const sql = [
    'CREATE TABLE IF NOT EXISTS actividades (id TEXT PRIMARY KEY, titulo TEXT NOT NULL, regionales TEXT NOT NULL, datos TEXT NOT NULL, creado INTEGER NOT NULL, actualizado INTEGER NOT NULL, autor TEXT NOT NULL DEFAULT \'\', version INTEGER NOT NULL DEFAULT 1)',
    'CREATE TABLE IF NOT EXISTS comentarios (id TEXT PRIMARY KEY, actividad_id TEXT NOT NULL, autor TEXT NOT NULL, texto TEXT NOT NULL, creado INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_com_act ON comentarios (actividad_id, creado)',
    'CREATE TABLE IF NOT EXISTS bitacora (id INTEGER PRIMARY KEY AUTOINCREMENT, actividad_id TEXT, titulo TEXT, regionales TEXT, accion TEXT NOT NULL, autor TEXT NOT NULL DEFAULT \'\', en INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tablas (id TEXT PRIMARY KEY, tipo TEXT NOT NULL, titulo TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT \'\', orden INTEGER NOT NULL, creado INTEGER NOT NULL, actualizado INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS tabla_filas (id TEXT PRIMARY KEY, tabla_id TEXT NOT NULL, orden INTEGER NOT NULL, a TEXT NOT NULL DEFAULT \'\', b TEXT NOT NULL DEFAULT \'\')',
    'CREATE INDEX IF NOT EXISTS idx_filas_tabla ON tabla_filas (tabla_id, orden)',
    'CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL, actualizado INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS hojas_privadas (id TEXT PRIMARY KEY, titulo TEXT NOT NULL, url TEXT NOT NULL, creado INTEGER NOT NULL)',
  ];
  for (const s of sql) await env.DB.prepare(s).run();
  lista = true;
}

async function leerAjuste(env, clave) {
  const f = await env.DB.prepare('SELECT valor FROM ajustes WHERE clave = ?').bind(clave).first();
  if (!f) return null;
  try { return JSON.parse(f.valor); } catch (e) { return null; }
}
function guardarAjuste(env, clave, valor) {
  return env.DB.prepare('INSERT INTO ajustes (clave, valor, actualizado) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado')
    .bind(clave, JSON.stringify(valor), Date.now()).run();
}
function bitacora(env, a) {
  return env.DB.prepare('INSERT INTO bitacora (actividad_id, titulo, regionales, accion, autor, en) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(a.id || '', a.titulo || '', JSON.stringify(a.regionales || []), a.accion, a.autor || '', Date.now()).run();
}

// ---------- actividades ----------
function limpiarRegionales(raw) {
  if (!Array.isArray(raw)) return null;
  const s = new Set();
  for (const r of raw) { const c = String(r); if (!REGIONAL.test(c)) return null; s.add(c); }
  if (!s.size) return null;
  return [...s].sort();
}
function limpiarDatos(raw, regs) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const tecnicos = {}, participantes = {}, tablas = {};
  for (const r of regs) {
    tecnicos[r] = txt(d.tecnicos && d.tecnicos[r], 120);
    const lista = d.participantes && Array.isArray(d.participantes[r]) ? d.participantes[r] : [];
    participantes[r] = lista.slice(0, 150).map((n) => txt(n, 120)).filter(Boolean);
  }
  for (const k of TABLAS_ACT) {
    const filas = d.tablas && Array.isArray(d.tablas[k]) ? d.tablas[k] : [];
    tablas[k] = filas.slice(0, 120).map((f) => {
      const o = f && typeof f === 'object' ? f : {};
      const estado = ESTADOS.includes(o.estado) ? o.estado : 'pendiente';
      return { elemento: txt(o.elemento, 150), responsable: txt(o.responsable, 120), estado, notas: txt(o.notas, 300) };
    }).filter((f) => f.elemento || f.responsable || f.notas);
  }
  return { tecnicos, personal: txt(d.personal, 200), participantes, tablas };
}
function filaActividad(f) {
  let regionales = [], datos = {};
  try { regionales = JSON.parse(f.regionales); } catch (e) {}
  try { datos = JSON.parse(f.datos); } catch (e) {}
  return { id: f.id, titulo: f.titulo, regionales, datos, creado: f.creado, actualizado: f.actualizado, autor: f.autor, version: f.version };
}
async function todasActividades(env) {
  const { results } = await env.DB.prepare('SELECT * FROM actividades ORDER BY creado, id').all();
  const com = await env.DB.prepare('SELECT id, actividad_id, autor, texto, creado FROM comentarios ORDER BY creado, id').all();
  const comentarios = {};
  for (const c of com.results || []) (comentarios[c.actividad_id] = comentarios[c.actividad_id] || []).push({ id: c.id, autor: c.autor, texto: c.texto, creado: c.creado });
  return { actividades: (results || []).map(filaActividad), comentarios };
}

// Resumen plano que recibe la hoja de Google.
function paraHoja(a, comentarios) {
  return {
    id: a.id, titulo: a.titulo, regionales: a.regionales, autor: a.autor, actualizado: a.actualizado,
    tecnicos: a.datos.tecnicos || {}, personal: a.datos.personal || '', participantes: a.datos.participantes || {},
    tablas: a.datos.tablas || {}, etiquetas: ETIQUETAS_TABLA,
    comentarios: (comentarios || []).map((c) => ({ autor: c.autor, texto: c.texto, creado: c.creado })),
  };
}
async function enviarAHoja(env, carga) {
  if (!env.SHEETS_URL) return { ok: false, mensaje: 'La hoja de Google todavía no está conectada (falta SHEETS_URL).' };
  let estado;
  try {
    const r = await fetch(env.SHEETS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secreto: env.SHEETS_SECRET || '', ...carga }), redirect: 'follow' });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    estado = j && j.ok ? { ok: true, mensaje: 'Sincronizado.' } : { ok: false, mensaje: (j && j.error) || ('La hoja respondió con un error (' + r.status + ').') };
  } catch (e) { estado = { ok: false, mensaje: 'No se pudo contactar a la hoja de Google.' }; }
  try { await guardarAjuste(env, 'sync', { ...estado, ultimo: Date.now() }); } catch (e) {}
  return estado;
}
function sincronizar(env, ctx, carga) {
  if (!env.SHEETS_URL) return;
  const p = enviarAHoja(env, carga);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

async function manejarActividades(request, env, ctx, partes) {
  // partes: ['actividades'] | ['actividades', id] | ['actividades', id, 'comentarios']
  const id = partes[1] || '';
  const sub = partes[2] || '';
  const m = request.method;

  if (!id) {
    if (m === 'GET') return json({ ok: true, ...(await todasActividades(env)) });
    if (m !== 'POST') return fallo('Método no permitido.', 405);
    const neg = await exigirEquipo(request, env); if (neg) return neg;
    const { v, error } = await leerCuerpo(request, MAX_CUERPO); if (error) return error;
    const titulo = txt(v.titulo, 120), autor = txt(v.autor, 60), regs = limpiarRegionales(v.regionales);
    if (!titulo) return fallo('Escribe el nombre del musical.', 400);
    if (!autor) return fallo('Escribe tu nombre para guardar.', 400);
    if (!regs) return fallo('Elige al menos una regional.', 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM actividades').first();
    if (n && n.n >= MAX_ACTIVIDADES) return fallo('Se llegó al máximo de actividades.', 400);
    const datos = limpiarDatos(v.datos, regs);
    const nuevo = crypto.randomUUID(), ahora = Date.now();
    await env.DB.prepare('INSERT INTO actividades (id, titulo, regionales, datos, creado, actualizado, autor, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .bind(nuevo, titulo, JSON.stringify(regs), JSON.stringify(datos), ahora, ahora, autor).run();
    await bitacora(env, { id: nuevo, titulo, regionales: regs, accion: 'creó', autor });
    const act = { id: nuevo, titulo, regionales: regs, datos, creado: ahora, actualizado: ahora, autor, version: 1 };
    sincronizar(env, ctx, { accion: 'guardar', actividad: paraHoja(act, []) });
    return json({ ok: true, actividad: act });
  }

  const fila = await env.DB.prepare('SELECT * FROM actividades WHERE id = ?').bind(id).first();

  if (sub === 'comentarios') {
    if (m !== 'POST') return fallo('Método no permitido.', 405);
    if (!fila) return fallo('Esa actividad ya no existe.', 404);
    const neg = await exigirEquipo(request, env); if (neg) return neg;
    const { v, error } = await leerCuerpo(request, 5000); if (error) return error;
    const autor = txt(v.autor, 60), texto = txt(v.texto, 1000);
    if (!autor) return fallo('Escribe tu nombre.', 400);
    if (!texto) return fallo('Escribe el comentario.', 400);
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM comentarios WHERE actividad_id = ?').bind(id).first();
    if (cnt && cnt.n >= 500) return fallo('Esta actividad llegó al máximo de comentarios.', 400);
    await env.DB.prepare('INSERT INTO comentarios (id, actividad_id, autor, texto, creado) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, autor, texto, Date.now()).run();
    const act = filaActividad(fila);
    await bitacora(env, { id, titulo: act.titulo, regionales: act.regionales, accion: 'comentó', autor });
    const todo = await todasActividades(env);
    sincronizar(env, ctx, { accion: 'guardar', actividad: paraHoja(act, todo.comentarios[id]) });
    return json({ ok: true, comentarios: todo.comentarios[id] || [] });
  }

  if (sub) return fallo('No encontrado.', 404);

  if (m === 'PUT') {
    if (!fila) return fallo('Esa actividad ya no existe.', 404);
    const neg = await exigirEquipo(request, env); if (neg) return neg;
    const { v, error } = await leerCuerpo(request, MAX_CUERPO); if (error) return error;
    const titulo = txt(v.titulo, 120), autor = txt(v.autor, 60), regs = limpiarRegionales(v.regionales);
    if (!titulo) return fallo('Escribe el nombre del musical.', 400);
    if (!autor) return fallo('Escribe tu nombre para guardar.', 400);
    if (!regs) return fallo('Elige al menos una regional.', 400);
    const datos = limpiarDatos(v.datos, regs);
    const ahora = Date.now();
    const res = await env.DB.prepare('UPDATE actividades SET titulo = ?, regionales = ?, datos = ?, actualizado = ?, autor = ?, version = version + 1 WHERE id = ? AND version = ?')
      .bind(titulo, JSON.stringify(regs), JSON.stringify(datos), ahora, autor, id, Number(v.version) || 0).run();
    if (!res.meta || !res.meta.changes) {
      const actual = await env.DB.prepare('SELECT * FROM actividades WHERE id = ?').bind(id).first();
      if (!actual) return fallo('Esa actividad ya no existe.', 404);
      return fallo('Otra persona guardó cambios en esta actividad mientras la editabas.', 409, { actividad: filaActividad(actual) });
    }
    await bitacora(env, { id, titulo, regionales: regs, accion: 'editó', autor });
    const act = { id, titulo, regionales: regs, datos, creado: fila.creado, actualizado: ahora, autor, version: (Number(v.version) || 0) + 1 };
    const todo = await todasActividades(env);
    sincronizar(env, ctx, { accion: 'guardar', actividad: paraHoja(act, todo.comentarios[id]) });
    return json({ ok: true, actividad: act });
  }

  if (m === 'DELETE') {
    const neg = await exigirAdmin(request, env); if (neg) return neg;
    if (!fila) return fallo('Esa actividad ya no existe.', 404);
    const act = filaActividad(fila);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM comentarios WHERE actividad_id = ?').bind(id),
      env.DB.prepare('DELETE FROM actividades WHERE id = ?').bind(id),
    ]);
    await bitacora(env, { id, titulo: act.titulo, regionales: act.regionales, accion: 'eliminó', autor: 'Administrador' });
    sincronizar(env, ctx, { accion: 'borrar', id });
    return json({ ok: true });
  }
  return fallo('Método no permitido.', 405);
}

async function borrarComentario(request, env, ctx, id) {
  if (request.method !== 'DELETE') return fallo('Método no permitido.', 405);
  const neg = await exigirAdmin(request, env); if (neg) return neg;
  const c = await env.DB.prepare('SELECT actividad_id FROM comentarios WHERE id = ?').bind(id).first();
  if (!c) return fallo('Ese comentario ya no existe.', 404);
  await env.DB.prepare('DELETE FROM comentarios WHERE id = ?').bind(id).run();
  const fila = await env.DB.prepare('SELECT * FROM actividades WHERE id = ?').bind(c.actividad_id).first();
  if (fila) {
    const todo = await todasActividades(env);
    sincronizar(env, ctx, { accion: 'guardar', actividad: paraHoja(filaActividad(fila), todo.comentarios[c.actividad_id]) });
  }
  return json({ ok: true });
}

// ---------- tablas de agenda y de roles ----------
async function leerTablas(env) {
  const t = await env.DB.prepare('SELECT id, tipo, titulo, fecha, orden, actualizado FROM tablas ORDER BY orden, creado').all();
  const f = await env.DB.prepare('SELECT tabla_id, a, b FROM tabla_filas ORDER BY orden, id').all();
  const por = {};
  for (const x of f.results || []) (por[x.tabla_id] = por[x.tabla_id] || []).push({ a: x.a, b: x.b });
  return (t.results || []).map((x) => ({ ...x, filas: por[x.id] || [] }));
}
function fechaValida(f) {
  if (f === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(f + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === f;
}
async function manejarTablas(request, env, partes) {
  const id = partes[1] || '';
  const m = request.method;
  if (!id) {
    if (m === 'GET') return json({ ok: true, tablas: await leerTablas(env) });
    if (m !== 'POST') return fallo('Método no permitido.', 405);
    const neg = await exigirAdmin(request, env); if (neg) return neg;
    const { v, error } = await leerCuerpo(request, 5000); if (error) return error;
    const tipo = String(v.tipo || ''), titulo = txt(v.titulo, 120), fecha = txt(v.fecha, 10);
    if (!TIPOS_TABLA.includes(tipo)) return fallo('Tipo de tabla inválido.', 400);
    if (!titulo) return fallo('Escribe el título de la actividad.', 400);
    if (!fechaValida(fecha)) return fallo('La fecha no es válida.', 400);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM tablas WHERE tipo = ?').bind(tipo).first();
    if (n && n.n >= MAX_TABLAS) return fallo('Se llegó al máximo de tablas.', 400);
    const nuevo = crypto.randomUUID(), ahora = Date.now();
    await env.DB.prepare('INSERT INTO tablas (id, tipo, titulo, fecha, orden, creado, actualizado) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(nuevo, tipo, titulo, fecha, ahora, ahora, ahora).run();
    return json({ ok: true, tablas: await leerTablas(env), id: nuevo });
  }
  const t = await env.DB.prepare('SELECT id, tipo FROM tablas WHERE id = ?').bind(id).first();
  if (m === 'PUT') {
    const neg = await exigirAdmin(request, env); if (neg) return neg;
    if (!t) return fallo('Esa tabla ya no existe.', 404);
    const { v, error } = await leerCuerpo(request, 100000); if (error) return error;
    const titulo = txt(v.titulo, 120), fecha = txt(v.fecha, 10);
    if (!titulo) return fallo('Escribe el título de la actividad.', 400);
    if (!fechaValida(fecha)) return fallo('La fecha no es válida.', 400);
    if (!Array.isArray(v.filas)) return fallo('Datos inválidos.', 400);
    if (v.filas.length > 200) return fallo('La tabla llegó al máximo de 200 filas.', 400);
    const filas = [];
    for (const f of v.filas) {
      const a = txt(f && f.a, 120), b = txt(f && f.b, 300);
      if (a || b) filas.push({ a, b });
    }
    const lote = [
      env.DB.prepare('UPDATE tablas SET titulo = ?, fecha = ?, actualizado = ? WHERE id = ?').bind(titulo, fecha, Date.now(), id),
      env.DB.prepare('DELETE FROM tabla_filas WHERE tabla_id = ?').bind(id),
    ];
    filas.forEach((f, i) => lote.push(env.DB.prepare('INSERT INTO tabla_filas (id, tabla_id, orden, a, b) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), id, i, f.a, f.b)));
    await env.DB.batch(lote);
    return json({ ok: true, tablas: await leerTablas(env) });
  }
  if (m === 'DELETE') {
    const neg = await exigirAdmin(request, env); if (neg) return neg;
    if (!t) return fallo('Esa tabla ya no existe.', 404);
    await env.DB.batch([env.DB.prepare('DELETE FROM tabla_filas WHERE tabla_id = ?').bind(id), env.DB.prepare('DELETE FROM tablas WHERE id = ?').bind(id)]);
    return json({ ok: true, tablas: await leerTablas(env) });
  }
  return fallo('Método no permitido.', 405);
}

// ---------- apariencia (público para leer, administrador para cambiar) ----------
function num(v, min, max, def) { const n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function limpiarPos(p, def) {
  const o = p && typeof p === 'object' ? p : {};
  return { x: num(o.x, 0, 100, def.x), y: num(o.y, 0, 100, def.y), w: num(o.w, 6, 90, def.w) };
}
function limpiarApariencia(v) {
  const logos = [];
  const vistos = new Set();
  for (const l of Array.isArray(v.logos) ? v.logos.slice(0, 12) : []) {
    const id = String(l && l.id);
    if (!LOGOS.includes(id) || vistos.has(id)) continue;
    vistos.add(id);
    logos.push({ id, visible: !!l.visible, d: limpiarPos(l.d, { x: 2, y: 20, w: 30 }), m: limpiarPos(l.m, { x: 4, y: 20, w: 60 }) });
  }
  const deco = v.deco && typeof v.deco === 'object' ? v.deco : {};
  return {
    nombre1: txt(v.nombre1, 60), nombre2: txt(v.nombre2, 60), lead: txt(v.lead, 300), tituloGeneral: txt(v.tituloGeneral, 200) || TITULO_GENERAL,
    fondo: FONDOS.includes(v.fondo) ? v.fondo : 'azul', acento: ACENTOS.includes(v.acento) ? v.acento : 'aqua', boton: BOTONES.includes(v.boton) ? v.boton : 'azul',
    deco: { polar: deco.polar !== false, estrellas: deco.estrellas !== false, puntos: deco.puntos !== false },
    logos,
  };
}
async function manejarAjustes(request, env) {
  if (request.method === 'GET') return json({ ok: true, apariencia: await leerAjuste(env, 'apariencia') });
  if (request.method !== 'PUT') return fallo('Método no permitido.', 405);
  const neg = await exigirAdmin(request, env); if (neg) return neg;
  const { v, error } = await leerCuerpo(request, 20000); if (error) return error;
  const ap = limpiarApariencia(v);
  await guardarAjuste(env, 'apariencia', ap);
  return json({ ok: true, apariencia: ap });
}

// ---------- área privada ----------
async function manejarPrivado(request, env, ctx, partes) {
  const neg = await exigirAdmin(request, env); if (neg) return neg;
  const sec = partes[1] || '';
  const m = request.method;

  if (!sec) {
    if (m !== 'GET') return fallo('Método no permitido.', 405);
    const h = await env.DB.prepare('SELECT id, titulo, url FROM hojas_privadas ORDER BY creado, id').all();
    return json({
      ok: true, hojas: h.results || [], hojaGeneral: (await leerAjuste(env, 'hoja_general')) || '',
      sync: (await leerAjuste(env, 'sync')) || null, hojaConectada: !!env.SHEETS_URL,
    });
  }
  if (sec === 'general') {
    if (m !== 'PUT') return fallo('Método no permitido.', 405);
    const { v, error } = await leerCuerpo(request, 3000); if (error) return error;
    const raw = String(v.url || '').trim();
    if (raw === '') { await guardarAjuste(env, 'hoja_general', ''); return json({ ok: true, hojaGeneral: '' }); }
    const u = urlHoja(raw);
    if (!u) return fallo('El enlace debe ser de Google Sheets (https://docs.google.com/spreadsheets/...).', 400);
    await guardarAjuste(env, 'hoja_general', u);
    return json({ ok: true, hojaGeneral: u });
  }
  if (sec === 'hojas') {
    const id = partes[2] || '';
    if (m === 'POST' && !id) {
      const { v, error } = await leerCuerpo(request, 5000); if (error) return error;
      const titulo = txt(v.titulo, 80), u = urlHoja(v.url);
      if (!titulo) return fallo('Escribe el nombre de la hoja.', 400);
      if (!u) return fallo('El enlace debe ser de Google Sheets.', 400);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM hojas_privadas').first();
      if (n && n.n >= 100) return fallo('Se llegó al máximo de hojas.', 400);
      await env.DB.prepare('INSERT INTO hojas_privadas (id, titulo, url, creado) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), titulo, u, Date.now()).run();
      const h = await env.DB.prepare('SELECT id, titulo, url FROM hojas_privadas ORDER BY creado, id').all();
      return json({ ok: true, hojas: h.results || [] });
    }
    if (m === 'DELETE' && id) {
      const r = await env.DB.prepare('DELETE FROM hojas_privadas WHERE id = ?').bind(id).run();
      if (!r.meta || !r.meta.changes) return fallo('Esa hoja ya no existe.', 404);
      const h = await env.DB.prepare('SELECT id, titulo, url FROM hojas_privadas ORDER BY creado, id').all();
      return json({ ok: true, hojas: h.results || [] });
    }
    return fallo('Método no permitido.', 405);
  }
  if (sec === 'sincronizar') {
    if (m !== 'POST') return fallo('Método no permitido.', 405);
    const todo = await todasActividades(env);
    const est = await enviarAHoja(env, { accion: 'reconstruir', actividades: todo.actividades.map((a) => paraHoja(a, todo.comentarios[a.id])) });
    return json({ ok: true, sync: { ...est, ultimo: Date.now() } });
  }
  return fallo('No encontrado.', 404);
}

function completitud(a) {
  const d = a.datos || {};
  const faltan = [];
  let total = 2, tiene = 0;
  if (a.titulo) tiene++; else faltan.push('Título');
  if (d.personal) tiene++; else faltan.push('Personal de producción');
  for (const r of a.regionales) {
    total += 2;
    if (d.tecnicos && d.tecnicos[r]) tiene++; else faltan.push('Técnico de la regional ' + r);
    if (d.participantes && d.participantes[r] && d.participantes[r].length) tiene++; else faltan.push('Participantes de la regional ' + r);
  }
  for (const k of TABLAS_ACT) {
    total++;
    if (d.tablas && d.tablas[k] && d.tablas[k].length) tiene++; else faltan.push(ETIQUETAS_TABLA[k]);
  }
  return { pct: Math.round((100 * tiene) / total), faltan };
}
async function metricas(request, env) {
  if (request.method !== 'GET') return fallo('Método no permitido.', 405);
  const neg = await exigirAdmin(request, env); if (neg) return neg;
  const { actividades, comentarios } = await todasActividades(env);
  const bit = await env.DB.prepare('SELECT actividad_id, titulo, regionales, accion, autor, en FROM bitacora ORDER BY id DESC LIMIT 3000').all();
  const tablas = await leerTablas(env);
  const porRegional = {};
  for (let i = 1; i <= 18; i++) porRegional[String(i).padStart(2, '0')] = { id: String(i).padStart(2, '0'), actividades: 0, ediciones: 0, ultimo: 0, promedio: 0, _suma: 0 };
  const acts = actividades.map((a) => {
    const c = completitud(a);
    for (const r of a.regionales) { const x = porRegional[r]; x.actividades++; x._suma += c.pct; if (a.actualizado > x.ultimo) x.ultimo = a.actualizado; }
    return { id: a.id, titulo: a.titulo, regionales: a.regionales, completitud: c.pct, faltan: c.faltan, actualizado: a.actualizado, autor: a.autor, comentarios: (comentarios[a.id] || []).length };
  });
  const hace7 = Date.now() - 7 * 86400000;
  let ediciones7d = 0;
  for (const b of bit.results || []) {
    let regs = []; try { regs = JSON.parse(b.regionales); } catch (e) {}
    if (b.accion !== 'eliminó') for (const r of regs) if (porRegional[r]) { porRegional[r].ediciones++; if (b.en > porRegional[r].ultimo) porRegional[r].ultimo = b.en; }
    if (b.en >= hace7) ediciones7d++;
  }
  const regionales = Object.values(porRegional).map((x) => ({ id: x.id, actividades: x.actividades, ediciones: x.ediciones, ultimo: x.ultimo, promedio: x.actividades ? Math.round(x._suma / x.actividades) : 0 }));
  const autores = {};
  for (const b of bit.results || []) { if (b.autor && b.autor !== 'Administrador') autores[b.autor] = (autores[b.autor] || 0) + 1; }
  return json({
    ok: true,
    resumen: {
      actividades: actividades.length,
      regionalesConActividad: regionales.filter((r) => r.actividades).length,
      tablasAgenda: tablas.filter((t) => t.tipo === 'agenda').length,
      tablasRoles: tablas.filter((t) => t.tipo === 'roles').length,
      comentarios: Object.values(comentarios).reduce((s, l) => s + l.length, 0),
      ediciones7d,
      completitudPromedio: acts.length ? Math.round(acts.reduce((s, a) => s + a.completitud, 0) / acts.length) : 0,
    },
    regionales, actividades: acts,
    autores: Object.entries(autores).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([nombre, cambios]) => ({ nombre, cambios })),
    reciente: (bit.results || []).slice(0, 20).map((b) => ({ accion: b.accion, autor: b.autor, titulo: b.titulo, en: b.en })),
  });
}

async function version(env) {
  const r = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(actualizado), 0) AS m FROM actividades'),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(creado), 0) AS m FROM comentarios'),
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(actualizado), 0) AS m FROM tablas'),
    env.DB.prepare("SELECT COALESCE(MAX(actualizado), 0) AS m FROM ajustes WHERE clave = 'apariencia'"),
  ]);
  const f = (i) => (r[i].results && r[i].results[0]) || { n: 0, m: 0 };
  return json({ ok: true, v: { act: f(0).n + ':' + f(0).m + ':' + f(1).n + ':' + f(1).m, tab: f(2).n + ':' + f(2).m, aj: String(f(3).m) } });
}

async function manejarApi(request, env, ctx, url) {
  if (!env.DB) return fallo('Falta conectar la base de datos D1 (binding DB).', 503);
  await preparar(env);
  const partes = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const raiz = partes[0] || '';

  if (raiz === 'admin') {
    if (request.method !== 'GET') return fallo('Método no permitido.', 405);
    return (await exigirAdmin(request, env)) || json({ ok: true });
  }
  if (raiz === 'config') return json({ ok: true, claveEquipo: !!env.TEAM_KEY });
  if (raiz === 'equipo') {
    if (request.method !== 'GET') return fallo('Método no permitido.', 405);
    return (await exigirEquipo(request, env)) || json({ ok: true });
  }
  if (raiz === 'version') return request.method === 'GET' ? version(env) : fallo('Método no permitido.', 405);
  if (raiz === 'actividades') return manejarActividades(request, env, ctx, partes);
  if (raiz === 'comentarios' && partes[1]) return borrarComentario(request, env, ctx, partes[1]);
  if (raiz === 'tablas') return manejarTablas(request, env, partes);
  if (raiz === 'ajustes') return manejarAjustes(request, env);
  if (raiz === 'privado') return manejarPrivado(request, env, ctx, partes);
  if (raiz === 'metricas') return metricas(request, env);
  return fallo('No encontrado.', 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await manejarApi(request, env, ctx, url); }
      catch (e) { return fallo('Error del servidor.', 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
