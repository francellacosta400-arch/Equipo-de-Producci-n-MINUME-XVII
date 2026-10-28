/**
 * EQUIPO DE PRODUCCIÓN MINUME XVII - Google Sheet general
 *
 * Qué hace: cada vez que alguien crea o edita una actividad en la web, la web envía los datos
 * a este script y el script los escribe en este Google Sheet:
 *   - una pestaña por actividad (por ejemplo "R01.18 Enredados")
 *   - una pestaña "Resumen" con una fila por actividad
 * Solo escribe de la web hacia el Sheet. Lo que cambies a mano en estas pestañas se pierde
 * la próxima vez que alguien edite esa actividad en la web.
 *
 * Cómo se instala: mira la guía LEEME.txt, Paso 4.
 */

// Cambia esta clave por una tuya (mínimo 12 caracteres) y escribe la MISMA en el área privada de la web.
const CLAVE = 'CAMBIA-ESTA-CLAVE';

const AZUL_OSCURO = '#0a0464';
const AZUL = '#002193';
const CIELO = '#00b5ff';
const GRIS = '#eef3fc';
const ZONA_HORARIA = 'America/Santo_Domingo';
const COLUMNAS = 6;
const SECCIONES = [
  ['produccion', 'Producción'], ['maquillaje', 'Maquillaje'], ['vestuario', 'Vestuario'],
  ['musica', 'Música'], ['escenografia', 'Escenografía'], ['utileria', 'Utilería'],
];
const ESTADOS = {
  pendiente: { texto: 'Pendiente', color: '#ffd9d9' },
  proceso: { texto: 'En proceso', color: '#fff2c2' },
  listo: { texto: 'Listo', color: '#c8f0d8' },
};
const REGIONALES = {
  '01': 'Barahona', '02': 'San Juan de la Maguana', '03': 'Azua', '04': 'San Cristóbal',
  '05': 'San Pedro de Macorís', '06': 'La Vega', '07': 'San Francisco de Macorís', '08': 'Santiago',
  '09': 'Mao', '10': 'Santo Domingo', '11': 'Puerto Plata', '12': 'Higüey', '13': 'Monte Cristi',
  '14': 'Nagua', '15': 'Distrito Nacional', '16': 'Cotuí', '17': 'Monte Plata', '18': 'Baoruco',
};
const CABECERA_RESUMEN = ['ID', 'Actividad', 'Regionales', 'Técnicos', 'Participantes', 'Avance', 'Actualizado', 'Abrir'];

// Para comprobar en el navegador que el script está publicado.
function doGet() {
  return salida({ ok: true, mensaje: 'La conexión con el Sheet está lista.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const dato = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (dato.secreto !== CLAVE) return salida({ ok: false, error: 'Clave del script incorrecta.' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (dato.accion === 'probar') return salida({ ok: true, nombre: ss.getName() });
    if (dato.accion === 'guardar') {
      guardarActividad(ss, dato.actividad, false);
    } else if (dato.accion === 'borrar') {
      borrarActividad(ss, String(dato.id || ''));
    } else if (dato.accion === 'reconstruir') {
      const lista = dato.actividades || [];
      lista.forEach(function (a) { guardarActividad(ss, a, true); });
      limpiarSobrantes(ss, lista.map(function (a) { return a.id; }));
    } else {
      return salida({ ok: false, error: 'Acción desconocida.' });
    }
    return salida({ ok: true, nombre: ss.getName() });
  } catch (err) {
    return salida({ ok: false, error: String((err && err.message) || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* nada */ }
  }
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- utilidades ----------
function nombreRegional(r) { return r + ' ' + (REGIONALES[r] || ''); }
function fechaCorta(ms) { return Utilities.formatDate(new Date(ms), ZONA_HORARIA, 'dd/MM/yyyy h:mm a'); }
function limpiarNombre(s) { return String(s).replace(/[\[\]\*\?\/\\:]/g, '-').replace(/\s+/g, ' ').trim(); }
function conteoAvance(act) {
  let total = 0, listos = 0;
  SECCIONES.forEach(function (s) {
    ((act.tablas && act.tablas[s[0]]) || []).forEach(function (f) { total++; if (f.estado === 'listo') listos++; });
  });
  return total ? listos / total : 0;
}
function totalParticipantes(act) {
  let n = 0;
  (act.regionales || []).forEach(function (r) { n += ((act.participantes && act.participantes[r]) || []).length; });
  return n;
}
function nombrePestana(ss, act, propia) {
  const regs = 'R' + (act.regionales || []).join('.');
  let nombre = limpiarNombre(regs + ' ' + (act.titulo || 'Actividad')).slice(0, 90);
  const otra = ss.getSheetByName(nombre);
  if (otra && (!propia || otra.getSheetId() !== propia.getSheetId())) {
    nombre = nombre.slice(0, 80) + ' (' + String(act.id).slice(0, 4) + ')';
  }
  return nombre;
}

// ---------- una actividad ----------
function guardarActividad(ss, act, forzar) {
  if (!act || !act.id) throw new Error('Falta la actividad.');
  const props = PropertiesService.getDocumentProperties();
  const revGuardada = Number(props.getProperty('rev:' + act.id) || 0);
  if (!forzar && revGuardada && Number(act.rev || act.actualizado || 0) < revGuardada) return;   // llegó una versión más vieja

  let hoja = null;
  const idHoja = props.getProperty('tab:' + act.id);
  if (idHoja) {
    ss.getSheets().forEach(function (h) { if (String(h.getSheetId()) === idHoja) hoja = h; });
  }
  const nombre = nombrePestana(ss, act, hoja);
  if (!hoja) hoja = ss.insertSheet(nombre); else if (hoja.getName() !== nombre) hoja.setName(nombre);
  props.setProperty('tab:' + act.id, String(hoja.getSheetId()));
  props.setProperty('rev:' + act.id, String(act.rev || act.actualizado || 0));

  dibujarActividad(hoja, act);
  actualizarResumen(ss, act, hoja);
}

function dibujarActividad(hoja, act) {
  const filas = [];       // matriz de valores
  const formatos = [];    // { fila, col, nf, nc, fondo, color, negrita, tam, unir, ajustar }
  function fila(vals) {
    const f = vals.slice(0, COLUMNAS);
    while (f.length < COLUMNAS) f.push('');
    filas.push(f);
    return filas.length;                      // número de fila (1 = primera)
  }
  function formato(f, col, nf, nc, o) { formatos.push(Object.assign({ fila: f, col: col, nf: nf, nc: nc }, o)); }
  function titulo(texto) { const n = fila([texto]); formato(n, 1, 1, COLUMNAS, { unir: true, fondo: AZUL, color: '#ffffff', negrita: true, tam: 12 }); }
  function cabecera(vals) { const n = fila(vals); formato(n, 1, 1, COLUMNAS, { fondo: GRIS, negrita: true }); }

  const n1 = fila([act.titulo || 'Actividad']);
  formato(n1, 1, 1, COLUMNAS, { unir: true, fondo: AZUL_OSCURO, color: '#ffffff', negrita: true, tam: 16 });
  const regs = (act.regionales || []).map(nombreRegional).join('  ·  ');
  const n2 = fila(['Regionales', regs]); formato(n2, 1, 1, 1, { negrita: true });
  const n3 = fila(['Última edición', act.actualizado ? fechaCorta(act.actualizado) : '']); formato(n3, 1, 1, 1, { negrita: true });
  fila([]);

  titulo('Técnicos regionales');
  cabecera(['Regional', 'Técnico regional']);
  (act.regionales || []).forEach(function (r) { fila([nombreRegional(r), (act.tecnicos && act.tecnicos[r]) || '']); });
  fila([]);

  titulo('Personal de producción responsable');
  const prod = act.produccion || [];
  if (prod.length) prod.forEach(function (p) { fila([p]); }); else fila(['Sin nombres todavía']);
  fila([]);

  (act.regionales || []).forEach(function (r) {
    titulo('Participantes · Regional ' + nombreRegional(r));
    const lista = (act.participantes && act.participantes[r]) || [];
    if (lista.length) lista.forEach(function (p, i) { fila([i + 1, p]); }); else fila(['', 'Sin participantes todavía']);
    fila([]);
  });

  SECCIONES.forEach(function (s) {
    titulo('Tabla de ' + s[1].toLowerCase());
    cabecera(['Elemento', 'Responsable', 'Estado', 'Notas']);
    const items = (act.tablas && act.tablas[s[0]]) || [];
    if (!items.length) fila(['Sin elementos todavía']);
    items.forEach(function (it) {
      const est = ESTADOS[it.estado] || ESTADOS.pendiente;
      const n = fila([it.item || '', it.responsable || '', est.texto, it.notas || '']);
      formato(n, 3, 1, 1, { fondo: est.color });
    });
    fila([]);
  });

  titulo('Comentarios');
  cabecera(['Fecha', 'Autor', 'Comentario']);
  const coms = act.comentarios || [];
  if (!coms.length) fila(['Sin comentarios todavía']);
  coms.forEach(function (c) {
    const n = fila([(c.cuando || c.creado) ? fechaCorta(c.cuando || c.creado) : '', c.autor || '', c.texto || '']);
    formato(n, 3, 1, 4, { unir: true, ajustar: true });
  });

  hoja.clear();
  hoja.getRange(1, 1, hoja.getMaxRows(), hoja.getMaxColumns()).breakApart();
  if (hoja.getMaxRows() < filas.length + 5) hoja.insertRowsAfter(hoja.getMaxRows(), filas.length + 5 - hoja.getMaxRows());
  hoja.getRange(1, 1, filas.length, COLUMNAS).setValues(filas).setVerticalAlignment('top');
  formatos.forEach(function (f) {
    const r = hoja.getRange(f.fila, f.col, f.nf, f.nc);
    if (f.unir) r.merge();
    if (f.fondo) r.setBackground(f.fondo);
    if (f.color) r.setFontColor(f.color);
    if (f.negrita) r.setFontWeight('bold');
    if (f.tam) r.setFontSize(f.tam);
    if (f.ajustar) r.setWrap(true);
  });
  [240, 230, 120, 340, 110, 110].forEach(function (w, i) { hoja.setColumnWidth(i + 1, w); });
  hoja.setFrozenRows(1);
  hoja.setTabColor(AZUL);
}

// ---------- resumen ----------
function hojaResumen(ss) {
  let r = ss.getSheetByName('Resumen');
  if (!r) {
    r = ss.insertSheet('Resumen', 0);
    r.getRange(1, 1, 1, CABECERA_RESUMEN.length).setValues([CABECERA_RESUMEN])
      .setBackground(AZUL_OSCURO).setFontColor('#ffffff').setFontWeight('bold');
    r.setFrozenRows(1);
    r.hideColumns(1);
    [20, 300, 260, 300, 110, 90, 150, 80].forEach(function (w, i) { r.setColumnWidth(i + 1, w); });
    r.setTabColor(CIELO);
  }
  return r;
}
function actualizarResumen(ss, act, hoja) {
  const r = hojaResumen(ss);
  const tecnicos = (act.regionales || []).map(function (x) { return x + ': ' + ((act.tecnicos && act.tecnicos[x]) || '—'); }).join('  ·  ');
  const valores = [
    act.id, act.titulo || '', (act.regionales || []).map(nombreRegional).join(', '), tecnicos,
    totalParticipantes(act), conteoAvance(act), act.actualizado ? fechaCorta(act.actualizado) : '',
    '=HYPERLINK("#gid=' + hoja.getSheetId() + '","Abrir")',
  ];
  let fila = filaDeId(r, act.id);
  if (!fila) fila = Math.max(2, r.getLastRow() + 1);
  r.getRange(fila, 1, 1, valores.length).setValues([valores]);
  r.getRange(fila, 6).setNumberFormat('0%');
}
function filaDeId(r, id) {
  const ultima = r.getLastRow();
  if (ultima < 2) return 0;
  const ids = r.getRange(2, 1, ultima - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

// ---------- borrar ----------
function borrarActividad(ss, id) {
  if (!id) return;
  const props = PropertiesService.getDocumentProperties();
  const idHoja = props.getProperty('tab:' + id);
  if (idHoja) {
    ss.getSheets().forEach(function (h) {
      if (String(h.getSheetId()) === idHoja && ss.getSheets().length > 1) ss.deleteSheet(h);
    });
  }
  const r = ss.getSheetByName('Resumen');
  if (r) { const f = filaDeId(r, id); if (f) r.deleteRow(f); }
  props.deleteProperty('tab:' + id);
  props.deleteProperty('rev:' + id);
}
function limpiarSobrantes(ss, idsVigentes) {
  const props = PropertiesService.getDocumentProperties().getProperties();
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('tab:') === 0) {
      const id = k.slice(4);
      if (idsVigentes.indexOf(id) === -1) borrarActividad(ss, id);
    }
  });
}
