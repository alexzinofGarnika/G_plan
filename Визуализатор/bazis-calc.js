/* ============================================================================
 * bazis-calc.js — разбор моделей БАЗИС (.b3d) и расчёт материалов.
 *
 * Чистый ES-модуль без зависимостей и без DOM. Работает в браузере
 * (в т.ч. внутри Web Worker) и в Node.
 *
 *   import { readModel, buildMaterialIndex, calculate } from './bazis-calc.js';
 *
 *   const model = await readModel(arrayBuffer);        // геометрия -> позиции
 *   const index = buildMaterialIndex(materialsJson);   // база материалов
 *   const res   = calculate(model, index);             // количества и стоимость
 *
 * Портирован с проверенной Python-версии (bazis_calc.py). Контрольные числа
 * для сверки — в конце файла.
 * ========================================================================= */

/* ─────────────────────────── распаковка zlib ─────────────────────────── */

/** Браузер умеет DecompressionStream, Node — zlib. Определяем на месте. */
export async function inflate(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  const { inflateSync } = await import('node:zlib');
  return new Uint8Array(inflateSync(Buffer.from(bytes)));
}

/* ─────────────────────────── чтение контейнера ────────────────────────── */

const SZ = { 16: 32, 17: 24, 20: 24, 18: 49 };
const TOL = 0.05;
const HOLE = /^\s*(отв\.?|отверстие|паз|разм)/i;

const dec = new TextDecoder('utf-16le');
const latin = new TextDecoder('latin1');

function readNames(dv, u8, off) {
  const n = dv.getUint32(off, true); off += 4;
  const names = new Array(n);
  for (let i = 0; i < n; i++) {
    const L = dv.getUint32(off, true); off += 4;
    names[i] = latin.decode(u8.subarray(off, off + L)); off += L;
  }
  return [names, off];
}

/** Находит сжатое тело модели: маркер 01 00 00 FF, затем поток zlib (78 9C). */
function findBody(u8) {
  if (!(u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x38 && u8[3] === 0x35))
    throw new Error('не модель БАЗИС: нет сигнатуры BZ85 (возможно, включено шифрование файлов)');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const [, after] = readNames(dv, u8, 9);
  for (let i = after; i < u8.length - 6; i++) {
    if (u8[i] === 0x01 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0xFF) {
      for (const st of [i + 5, i + 4])
        if (u8[st] === 0x78 && u8[st + 1] === 0x9C) return st;
    }
  }
  for (let i = after; i < u8.length - 2; i++)
    if (u8[i] === 0x78 && u8[i + 1] === 0x9C) return i;
  throw new Error('zlib-поток не найден');
}

/* ─────────────────────────── дерево объектов ─────────────────────────── */
/* Запись: [uint32 ключ][uint32 старшее слово][uint8 тип][данные].
   Старшее слово 0 -> это свойство; иначе -> заголовок вложенного объекта. */

function parseTree(dv, u8, names, start) {
  let o = start;

  function readValue(t) {
    switch (t) {
      case 0: case 8: return null;
      case 1: return true;
      case 2: return false;
      case 3: return u8[o++];
      case 4: { const v = dv.getInt32(o, true); o += 4; return v; }
      case 5: case 9: { const v = dv.getFloat64(o, true); o += 8; return v; }
      case 6: {
        const L = dv.getUint32(o, true); o += 4;
        const s = dec.decode(u8.subarray(o, o + L * 2)); o += L * 2; return s;
      }
      case 7: {
        const L = dv.getUint32(o, true); o += 4;
        const b = u8.subarray(o, o + L); o += L; return b;
      }
      default: throw new Error(`неизвестный тип значения ${t} @${o}`);
    }
  }

  function obj() {
    const cnt = dv.getUint32(o + 4, true); o += 9;
    const node = { props: Object.create(null), kids: [] };
    for (let i = 0; i < cnt; i++) {
      if (dv.getUint32(o + 4, true) === 0) {
        const key = dv.getUint32(o, true);
        const nm = key === 0xFFFFFFFF ? '_val' : names[key];
        const t = u8[o + 8]; o += 9;
        node.props[nm] = readValue(t);
      } else node.kids.push(obj());
    }
    return node;
  }
  return obj();
}

/* ─────────────────────────── геометрия ─────────────────────────── */

function parseContour(b) {
  const out = [];
  if (!b || b.length < 4) return out;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const cnt = dv.getUint32(0, true);
  let o = 4;
  for (let i = 0; i < cnt; i++) {
    if (o >= b.length) break;
    const t = b[o];
    if (!(t in SZ)) break;
    const g = k => dv.getFloat64(o + 1 + k * 8, true);
    if (t === 16) out.push(['L', g(0), g(1), g(2), g(3)]);
    else if (t === 17 || t === 20) out.push(['C', g(0), g(1), g(2)]);
    else if (t === 18) out.push(['A', g(0), g(1), g(2), g(3), g(4), g(5), b[o + 49]]);
    o += 1 + SZ[t];
  }
  return out;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function elemLen(e) {
  if (e[0] === 'L') return Math.hypot(e[3] - e[1], e[4] - e[2]);
  if (e[0] === 'C') return 2 * Math.PI * e[3];
  if (e[0] === 'A') {
    const r = Math.hypot(e[1] - e[5], e[2] - e[6]);
    const a1 = Math.atan2(e[2] - e[6], e[1] - e[5]);
    const a2 = Math.atan2(e[4] - e[6], e[3] - e[5]);
    let d = Math.abs(a2 - a1) % (2 * Math.PI);
    return r * d;
  }
  return 0;
}

function arcPts(x1, y1, x2, y2, cx, cy, ccw) {
  const r = Math.hypot(x1 - cx, y1 - cy);
  let a1 = Math.atan2(y1 - cy, x1 - cx), a2 = Math.atan2(y2 - cy, x2 - cx);
  if (ccw) { while (a2 <= a1) a2 += 2 * Math.PI; }
  else { while (a2 >= a1) a2 -= 2 * Math.PI; }
  const n = Math.max(2, Math.trunc(Math.abs(a2 - a1) / 0.25) + 1);
  const p = [];
  for (let i = 0; i <= n; i++) {
    const a = a1 + (a2 - a1) * i / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return p;
}

function elemPts(e) {
  if (e[0] === 'L') return [[e[1], e[2]], [e[3], e[4]]];
  if (e[0] === 'A') return arcPts(e[1], e[2], e[3], e[4], e[5], e[6], e[7]);
  const [, cx, cy, r] = e, p = [];
  for (let i = 0; i <= 20; i++) {
    const a = 2 * Math.PI * i / 20;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return p;
}

/** Сшивает элементы контура в замкнутые петли (внешняя + вырезы). */
function contourLoops(els) {
  const segs = [], loops = [];
  for (const e of els) {
    if (e[0] === 'L') segs.push([[e[1], e[2]], [e[3], e[4]]]);
    else if (e[0] === 'A') segs.push(arcPts(e[1], e[2], e[3], e[4], e[5], e[6], e[7]));
    else if (e[0] === 'C') {
      const [, cx, cy, r] = e, p = [];
      for (let i = 0; i < 24; i++) {
        const a = 2 * Math.PI * i / 24;
        p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      loops.push(p);
    }
  }
  const used = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = segs[i].slice(), changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j];
        if (dist(chain[chain.length - 1], s[0]) < TOL) { chain = chain.concat(s.slice(1)); used[j] = changed = true; }
        else if (dist(chain[chain.length - 1], s[s.length - 1]) < TOL) { chain = chain.concat(s.slice().reverse().slice(1)); used[j] = changed = true; }
        else if (dist(chain[0], s[s.length - 1]) < TOL) { chain = s.slice(0, -1).concat(chain); used[j] = changed = true; }
        else if (dist(chain[0], s[0]) < TOL) { chain = s.slice().reverse().slice(0, -1).concat(chain); used[j] = changed = true; }
      }
    }
    if (chain.length >= 3) {
      if (dist(chain[0], chain[chain.length - 1]) < TOL) chain.pop();
      loops.push(chain);
    }
  }
  return loops.filter(l => l.length >= 3);
}

function areaOf(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function quatMat(x, y, z, w) {
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const mmul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));
const xform = (M, t, v) => [0, 1, 2].map(i => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] + t[i]);
const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const matName = m => String(m ?? '').split('\r')[0].trim();
const matCode = m => { const p = String(m ?? '').split('\r'); return p.length > 1 ? p[1].trim() : ''; };

/* ─────────────────────────── обход модели ─────────────────────────── */
/* Опора на enum Type и наличие кватерниона, а НЕ на числовые id классов:
   они привязаны к словарю конкретного файла и в каждой модели свои.
   Ветка истории правок (ActiveIndex/StartName) пропускается — иначе
   в расчёт попадут прежние состояния изделия. */

function extract(root, wantScene = false) {
  const pos = new Map();          // "материал\u0000роль" -> агрегат
  const parts = [], scene = [], warnings = [], anims = [];

  const add = (full, role, area = 0, len = 0, qty = 0) => {
    const nm = matName(full), key = nm + '\u0000' + role;
    let p = pos.get(key);
    if (!p) { p = { material: nm, role, code: matCode(full), area: 0, len: 0, qty: 0 }; pos.set(key, p); }
    if (!p.code) p.code = matCode(full);
    p.area += area; p.len += len; p.qty += qty;
  };

  const localTf = node => {
    for (const k of node.kids) {
      const p = k.props;
      if ('Rw' in p || ('X' in p && 'Y' in p && 'Z' in p && !('Type' in p)))
        return [quatMat(p.Rx || 0, p.Ry || 0, p.Rz || 0, p.Rw ?? 1),
                [p.X || 0, p.Y || 0, p.Z || 0]];
    }
    return null;
  };

  (function walk(node, M, T, owner, animId) {
    const pr = node.props;
    if ('ActiveIndex' in pr || 'StartName' in pr) return;
    const tf = localTf(node);
    // порядок важен: положение считается по СТАРОЙ матрице, до её обновления
    if (tf) { const Tn = xform(M, T, tf[1]); M = mmul(M, tf[0]); T = Tn; }

    /* Анимация блока: узел с AnimType и двумя точками-детьми.
       AnimType 1 — поворот вокруг оси p1→p2 на Limit градусов (фасад),
       AnimType 2 — сдвиг по вектору p1→p2 (ящик).
       Точки заданы в системе координат блока, переводим их в мировую. */
    for (const k of node.kids) {
      const a = k.props;
      if (!('AnimType' in a)) continue;
      const pts = k.kids.filter(q => 'x' in q.props && 'y' in q.props && 'z' in q.props);
      if (pts.length < 2) continue;
      const w = q => xform(M, T, [q.props.x || 0, q.props.y || 0, q.props.z || 0]);
      animId = anims.length;
      anims.push({
        id: animId,
        kind: a.AnimType === 1 ? 'rotate' : 'slide',
        limit: Number(a.Limit ?? 0),
        shift: Number(a.Shift ?? 0),
        duration: Number(a.Duration ?? 0),
        salonType: pr.SalonType ?? 0,
        name: matName(pr.Name) || 'Блок',
        p1: w(pts[0]).map(v => +v.toFixed(1)),
        p2: w(pts[1]).map(v => +v.toFixed(1)),
      });
      break;
    }
    const typ = pr.Type;
    const nm = String(pr.Name ?? ''), base = matName(nm), art = matCode(nm);

    if ((typ === 4002 || typ === 2004) && pr.Contour instanceof Uint8Array) {
      const els = parseContour(pr.Contour);
      const loops = contourLoops(els);
      if (loops.length) {
        loops.sort((a, b) => areaOf(b) - areaOf(a));
        const th = Number((typ === 4002 ? pr.Thick : pr.Thickness) || 0);
        const a = (areaOf(loops[0]) - loops.slice(1).reduce((s, l) => s + areaOf(l), 0)) / 1e6;
        const xs = loops[0].map(p => p[0]), ys = loops[0].map(p => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        const butts = [], paint = [];
        if (typ === 4002 && th) {
          (function sub(x) {
            for (const k of x.kids) {
              const p = k.props, ks = Object.keys(p);
              if (p.Type != null) continue;
              if (ks.includes('Elem') && ks.includes('Mat')) {
                const i = p.Elem;
                if (Number.isInteger(i) && i >= 0 && i < els.length) {
                  const L = elemLen(els[i]) + 2 * (p.Overhung || 0);
                  add(p.Mat, 'кромка', 0, L / 1000);
                  butts.push({ m: matName(p.Mat), l: L, p: elemPts(els[i]) });
                } else warnings.push(`кромка вне контура: ${base}`);
              } else if (ks.includes('Mat') &&
                         ks.every(k2 => ['Mat', 'TexDir', 'Thick', 'Sign'].includes(k2))) {
                add(p.Mat, 'облицовка пласти', a);
                paint.push(matName(p.Mat));
              }
              sub(k);
            }
          })(node);
          add(pr.Mat, 'панель', a, 0, 1);
          parts.push({
            name: base, group: owner, material: matName(pr.Mat), article: matCode(pr.Mat),
            length: Math.round(Math.max(w, h)), width: Math.round(Math.min(w, h)),
            thickness: +Math.abs(th).toFixed(2), area: +a.toFixed(4),
            edge: +(butts.reduce((s, b) => s + b.l, 0) / 1000).toFixed(3),
            paintFaces: paint.length, cutouts: loops.length - 1,
          });
        } else if (typ === 2004 && th) {
          add(pr.Mat, 'профиль', 0, Math.abs(th) / 1000, 1);
        }
        if (wantScene && th) {
          scene.push({
            n: base, g: owner, m: matName(pr.Mat), k: typ === 4002 ? 'panel' : 'profile',
            t: +th.toFixed(2),
            o: loops[0].map(p => [+p[0].toFixed(1), +p[1].toFixed(1)]),
            h: loops.slice(1).map(l => l.map(p => [+p[0].toFixed(1), +p[1].toFixed(1)])),
            b: butts, p: paint, a: animId ?? null,
            td: pr.TexDir ?? null, ta: pr.TexAngle ?? 0,
            M: M.flat().map(v => +v.toFixed(6)), T: T.map(v => +v.toFixed(1)),
          });
        }
      }
    }

    if (typ === 3001 && art && !art.startsWith('-') && !HOLE.test(base))
      add(nm, 'крепёж', 0, 0, 1);

    for (const c of node.kids) walk(c, M, T, base || owner, animId);
  })(root, IDENT, [0, 0, 0], '', null);

  /* Покупные изделия — отдельным проходом: вложенные в комплект позиции
     второй раз в закупку не идут. Блок, носящий имя уже посчитанного
     материала (например профиль-ручка), тоже пропускаем. */
  (function hw(node, inside) {
    const pr = node.props;
    if ('ActiveIndex' in pr || 'StartName' in pr) return;
    const typ = pr.Type, nm = String(pr.Name ?? '');
    const base = matName(nm), art = matCode(nm);
    const isPur = (typ === 4001 || typ === 4004 || typ === 1005) &&
                  art && !art.startsWith('-') && !HOLE.test(base);
    const dup = ['панель', 'профиль', 'кромка', 'облицовка пласти']
      .some(r => pos.has(base + '\u0000' + r));
    if (isPur && !inside && !dup) add(nm, 'покупное изделие', 0, 0, 1);
    for (const c of node.kids) hw(c, inside || isPur);
  })(root, false);

  return { positions: [...pos.values()], parts, scene, warnings, anims };
}

/* ─────────────────────────── публичный разбор ─────────────────────────── */

/** ArrayBuffer/Uint8Array файла .b3d -> позиции, детали, предупреждения. */
export async function readModel(input, { scene = false } = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const start = findBody(u8);
  const body = await inflate(u8.subarray(start));
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const [names, off] = readNames(dv, body, 0);
  const root = parseTree(dv, body, names, off);
  return extract(root, scene);
}

/* ─────────────────────────── база материалов ─────────────────────────── */

/** Записи базы -> индекс для быстрого поиска по имени и по артикулу. */
export function buildMaterialIndex(records) {
  const byName = new Map(), byArt = new Map();
  for (const r of records) {
    if (r.name && !byName.has(r.name)) byName.set(r.name, r);
    if (r.art && !byArt.has(r.art)) byArt.set(r.art, r);
  }
  return { byName, byArt, records };
}

const SHEET_UNITS = new Set(['лист', 'шт', 'шт.']);

/** Перевод модельной величины в единицу измерения базы. */
function toDbQty(rec, role, area, len, qty) {
  const u = (rec.unit || '').toLowerCase();
  if (role === 'покупное изделие' || role === 'крепёж') return [qty, 'шт'];
  if (['м.п.', 'м', 'мп'].includes(u)) return [len, 'пог. м'];
  if (['кв. м', 'кв.м', 'м2', 'м²'].includes(u)) return [area, 'м²'];
  if (SHEET_UNITS.has(u) && rec.L > 0 && rec.W > 0 && area > 0) {
    const sheet = rec.L * rec.W / 1e6;
    return [area / sheet, `листов по ${sheet.toFixed(3)} м²`];
  }
  if (area > 0) return [area, 'м² (ед. базы не распознана)'];
  if (len > 0) return [len, 'пог. м (ед. базы не распознана)'];
  return [qty, 'шт'];
}

const applyRound = (q, mode) => mode === 1 ? Math.ceil(q - 1e-9) : q;

/** Позиции модели + индекс базы -> количества к закупке и стоимость. */
export function calculate(model, index) {
  const items = [], byRole = {};
  for (const v of model.positions) {
    const rec = index.byName.get(v.material) || index.byArt.get(v.code);
    const it = {
      material: v.material, role: v.role, article: v.code,
      modelArea_m2: +v.area.toFixed(4) || null,
      modelLength_m: +v.len.toFixed(4) || null,
      modelQty: v.qty || null,
      inDatabase: !!rec,
    };
    if (rec) {
      const [q, basis] = toDbQty(rec, v.role, v.area, v.len, v.qty);
      const coef = rec.coef || 1;
      const qc = q * coef;
      const qr = applyRound(qc, rec.round);
      const cost = qr * (rec.price || 0);
      Object.assign(it, {
        article: rec.art || v.code, group: rec.group, unit: rec.unit, basis,
        qty: +q.toFixed(4), coef, qtyWithCoef: +qc.toFixed(4),
        rounding: rec.round, qtyToBuy: +qr.toFixed(4),
        price: rec.price, cost: +cost.toFixed(2),
      });
      byRole[v.role] = +((byRole[v.role] || 0) + cost).toFixed(2);
    }
    items.push(it);
  }
  items.sort((a, b) => (b.cost || 0) - (a.cost || 0));
  return {
    partCount: model.parts.length,
    positions: items.length,
    notInDatabase: items.filter(i => !i.inDatabase).length,
    costByRole: byRole,
    costTotal: +Object.values(byRole).reduce((s, v) => s + v, 0).toFixed(2),
    warnings: model.warnings.slice(0, 200),
    items,
    parts: model.parts,
  };
}

/** Всё сразу: файл + база -> результат. */
export async function calcFromFile(input, index, opts) {
  return calculate(await readModel(input, opts), index);
}

/* ============================================================================
 * КОНТРОЛЬНЫЕ ЧИСЛА (сверка с эталонной Python-версией)
 *
 *   5352_кухня_обновленный_замер_вар5.b3d
 *     деталей 186 · позиций 68 · нет в базе 22 · материалы 6620.90
 *     панель 4187.59 · покупное изделие 1045.24 · крепёж 651.82
 *     облицовка пласти 348.03 · профиль 224.62 · кромка 163.60
 *
 *   5352_кухня_обновленный_замер_вар3.b3d
 *     деталей 167 · позиций 58 · материалы 2287.80
 *
 * Любая правка парсера обязана оставить эти числа неизменными.
 * ========================================================================= */
