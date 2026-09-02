/* ============================================================================
 * garnika-model-viewer.js — просмотр модели БАЗИС внутри Гарники.
 *
 * Менеджер открывает заказ, выбирает файл .b3d — и видит изделие в 3D:
 * может покрутить, кликнуть по детали и узнать её размер и материал.
 *
 *   import { mountViewer } from './garnika-model-viewer.js';
 *
 *   const v = await mountViewer(divElement, {
 *     buffer,                  // ArrayBuffer файла .b3d
 *     materials,               // materials.json — для цветов и названий
 *     onSelect: part => {},    // клик по детали (необязательно)
 *   });
 *   v.dispose();               // при закрытии карточки заказа — обязательно
 *
 * Зависимости: bazis-calc.js (разбор) и three.js (подгружается сам с CDN).
 * ========================================================================= */

import { readModel } from './bazis-calc.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

/* Палитра проекта: цвет из базы материалов, иначе эвристика по названию.
   #F6B67F в базе — дефолт Базиса, а не настоящий цвет, он отброшен заранее. */
const PAL = [
  [/tasmanian|rechapado|roble|wood fasad|castoro|otawa/i, 0xc2925e],
  [/almendra|beige/i, 0xd9c39c],
  [/blanco|white|бел|krion|blanca|hidrofugo|polar/i, 0xe8e5de],
  [/покраска|эмаль|мдф|mdf|lacar/i, 0xdbd3c4],
  [/дсп|ldsp|melamine/i, 0xd2ccbe],
  [/gris|сер|сталь|steel|acero|aluminio|argentum/i, 0x9aa0a4],
  [/чёрн|черн|negro|antracita|black/i, 0x2c3033],
  [/стекло|glass|cristal/i, 0x7f8f97],
  [/neon|tira|led/i, 0xffd08a],
  [/бетон/i, 0x646b70],
];
const DEFAULT_COLOR = 0xb9b3a8;
const GLASS = /стекло|glass|cristal/i;
const METAL = /сталь|steel|metal|метал|acero|aluminio/i;

let threePromise = null;
function loadThree() {
  if (window.THREE) return Promise.resolve(window.THREE);
  if (!threePromise) {
    threePromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = THREE_URL;
      s.onload = () => res(window.THREE);
      s.onerror = () => rej(new Error('не удалось загрузить three.js'));
      document.head.appendChild(s);
    });
  }
  return threePromise;
}

const nameOf = m => String(m || '').split('\r')[0].trim() || 'Без материала';

/* Текстуры. В базе материалов у записи есть относительный путь `tex`
   (например EGGER/Gabarro/Surface_U211ST9.png). Если задан textureBase —
   адрес каталога в Supabase Storage, — картинка подгружается и кладётся
   на деталь. Пока грузится или если файла нет, деталь остаётся крашеной
   в цвет, поэтому просмотр не ломается никогда. */
function texIndex(materials) {
  const m = new Map();
  for (const r of materials || []) if (r.tex) m.set(r.name, r.tex);
  return m;
}
const texUrl = (base, rel) =>
  base.replace(/\/+$/, '') + '/' + String(rel).replace(/\\/g, '/').replace(/^\/+/, '')
      .split('/').map(encodeURIComponent).join('/');

function makePalette(materials) {
  const hex = new Map();
  for (const r of materials || []) if (r.hex) hex.set(r.name, r.hex);
  return m => {
    const k = nameOf(m);
    const h = hex.get(k);
    if (h && /^#[0-9a-f]{6}$/i.test(h)) return parseInt(h.slice(1), 16);
    for (const [re, c] of PAL) if (re.test(k)) return c;
    return DEFAULT_COLOR;
  };
}

const shoelace = r => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};

/**
 * @param {HTMLElement} el      контейнер (позиционированный, с заданной высотой)
 * @param {object} opts         { buffer, materials, onSelect, background }
 * @returns {Promise<{dispose, setLayer, fit, stats}>}
 */
export async function mountViewer(el, opts = {}) {
  const THREE = await loadThree();
  const model = await readModel(opts.buffer, { scene: true });
  const colorOf = makePalette(opts.materials);
  const texOf = texIndex(opts.materials);
  const TEX_BASE = opts.textureBase || null;
  const TILE = opts.textureTileMm || 1200;   // сколько мм покрывает одна плитка текстуры
  const loader = TEX_BASE ? new THREE.TextureLoader() : null;
  if (loader && opts.textureCrossOrigin !== false) loader.setCrossOrigin('anonymous');
  const texCache = new Map();
  let texLoaded = 0, texFailed = 0;

  /** Текстура материала: одна на материал, повторно используется. */
  function getTexture(matName) {
    if (!loader) return null;
    if (texCache.has(matName)) return texCache.get(matName);
    const rel = texOf.get(matName);
    if (!rel) { texCache.set(matName, null); return null; }
    const ok = () => { texLoaded++; if (opts.onTexture) opts.onTexture(texLoaded, texFailed); };
    const jpg = rel.replace(/\.[^.\/]+$/, '.jpg');
    // каталог готовится скриптом prepare-textures.py и сохраняется в JPEG,
    // а в базе путь остаётся с исходным расширением — пробуем оба
    const t = loader.load(texUrl(TEX_BASE, rel), ok, undefined, () => {
      if (jpg === rel) { texFailed++; if (opts.onTexture) opts.onTexture(texLoaded, texFailed); return; }
      loader.load(texUrl(TEX_BASE, jpg), tex => {
        t.image = tex.image; t.needsUpdate = true; ok();
      }, undefined, () => {
        texFailed++; if (opts.onTexture) opts.onTexture(texLoaded, texFailed);
      });
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / TILE, 1 / TILE);     // UV у ExtrudeGeometry идут в миллиметрах
    t.center.set(0.5, 0.5);
    texCache.set(matName, t);
    return t;
  }

  /* ── сцена ── */
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none';
  el.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  if (opts.background !== null) scene.background = new THREE.Color(opts.background ?? 0x14171a);
  const camera = new THREE.PerspectiveCamera(38, 1, 10, 300000);

  scene.add(new THREE.HemisphereLight(0xdfe6ec, 0x20262b, 0.95));
  const key = new THREE.DirectionalLight(0xfff2df, 1.15); key.position.set(1, 1.5, 1.1);
  const fill = new THREE.DirectionalLight(0xa8c4de, 0.45); fill.position.set(-1.1, 0.5, -0.9);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3); rim.position.set(0.2, -1, -0.4);
  scene.add(key, fill, rim);

  const root = new THREE.Group(); scene.add(root);
  const gParts = new THREE.Group(), gRoom = new THREE.Group(), gWire = new THREE.Group();
  root.add(gParts, gRoom, gWire);
  gRoom.visible = false;

  /* Анимация: у каждого подвижного блока своя группа с собственной матрицей.
     Поворот — вокруг оси p1→p2 на limit градусов, сдвиг — по вектору p1→p2. */
  const animGroups = new Map();
  const anims = (model.anims || []).map(a => ({ ...a, t: 0, dir: 1,
    p1v: new THREE.Vector3(...a.p1), p2v: new THREE.Vector3(...a.p2) }));
  for (const a of anims) {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    gParts.add(g);
    animGroups.set(a.id, g);
  }
  /** Пересчитать матрицу одного узла по его собственному положению a.t. */
  function applyOne(a) {
      const g = animGroups.get(a.id);
      if (!g) return;
      const t = a.t;
      const m = new THREE.Matrix4();
      if (a.kind === 'rotate' && a.limit) {
        const axis = a.p2v.clone().sub(a.p1v).normalize();
        const ang = THREE.MathUtils.degToRad(a.limit) * t * (a.dir ?? 1);
        m.multiply(new THREE.Matrix4().makeTranslation(a.p1v.x, a.p1v.y, a.p1v.z))
         .multiply(new THREE.Matrix4().makeRotationAxis(axis, ang))
         .multiply(new THREE.Matrix4().makeTranslation(-a.p1v.x, -a.p1v.y, -a.p1v.z));
      } else {
        const d = a.p2v.clone().sub(a.p1v).multiplyScalar(t * (a.dir ?? 1));
        m.makeTranslation(d.x, d.y, d.z);
      }
      g.matrix.copy(m);
      g.matrixWorldNeedsUpdate = true;
  }

  /* ── материалы ── */
  const matCache = new Map();
  const stdMat = (m, sel, angle) => {
    const a = +(angle || 0).toFixed(3);
    const key = m + '|' + (sel ? 1 : 0) + '|' + a;
    if (matCache.has(key)) return matCache.get(key);
    const glass = GLASS.test(m), metal = METAL.test(m);
    let map = null;
    if (!sel) {
      const base = getTexture(m);
      if (base) {                       // поворот текстуры — своя копия карты
        map = a ? base.clone() : base;
        if (a) { map.rotation = a; map.needsUpdate = true; }
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      map,
      color: sel ? 0xc08a4e : (map ? 0xffffff : colorOf(m)),
      roughness: metal ? 0.35 : 0.74,
      metalness: metal ? 0.55 : 0.04,
      transparent: glass, opacity: glass ? 0.34 : 1,
      side: THREE.DoubleSide,
      emissive: sel ? 0x3a2408 : 0x000000,
    });
    matCache.set(key, mat); return mat;
  };

  /* ── построение тел ── */
  const meshes = [], box = new THREE.Box3();
  let panels = 0, profiles = 0, roomSurfaces = 0, area = 0;

  for (const p of model.scene) {
    const th = Math.abs(p.t);
    if (!th) { roomSurfaces++; continue; }        // оболочка помещения из замера
    let geo;
    try {
      const sh = new THREE.Shape();
      p.o.forEach((q, i) => i ? sh.lineTo(q[0], q[1]) : sh.moveTo(q[0], q[1]));
      sh.closePath();
      (p.h || []).forEach(h => {
        const pa = new THREE.Path();
        h.forEach((q, i) => i ? pa.lineTo(q[0], q[1]) : pa.moveTo(q[0], q[1]));
        pa.closePath(); sh.holes.push(pa);
      });
      geo = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false, curveSegments: 8 });
    } catch (e) { continue; }
    if (p.t < 0) geo.translate(0, 0, p.t);        // знак = направление выдавливания

    const M = new THREE.Matrix4().set(
      p.M[0], p.M[1], p.M[2], p.T[0],
      p.M[3], p.M[4], p.M[5], p.T[1],
      p.M[6], p.M[7], p.M[8], p.T[2], 0, 0, 0, 1);

    const mesh = new THREE.Mesh(geo, stdMat(p.m, false, p.ta));
    mesh.applyMatrix4(M);
    const xs = p.o.map(q => q[0]), ys = p.o.map(q => q[1]);
    const a = (shoelace(p.o) - (p.h || []).reduce((s, h) => s + shoelace(h), 0)) / 1e6;
    mesh.userData = {
      part: {
        index: meshes.length,
        animId: (p.a != null && animGroups.has(p.a)) ? p.a : null,
        name: p.n, node: nameOf(p.g), material: nameOf(p.m),
        kind: p.k === 'panel' ? 'Панель' : 'Профиль',
        length: Math.round(Math.max(...xs) - Math.min(...xs)),
        width: Math.round(Math.max(...ys) - Math.min(...ys)),
        thickness: +th.toFixed(1), area: +a.toFixed(3), texAngle: p.ta || 0,
        edge: +((p.b || []).reduce((s, b) => s + b.l, 0) / 1000).toFixed(2),
        paintFaces: (p.p || []).length, cutouts: (p.h || []).length,
      },
    };
    (p.a != null && animGroups.has(p.a) ? animGroups.get(p.a) : gParts).add(mesh);
    meshes.push(mesh);
    if (p.k === 'panel') { panels++; area += a; } else profiles++;

    if (p.k === 'panel') {
      const eg = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 28),
        new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34 }));
      eg.applyMatrix4(M);
      (p.a != null && animGroups.has(p.a) ? animGroups.get(p.a) : gWire).add(eg);
      mesh.userData.wire = eg;
    }

    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    for (let i = 0; i < 8; i++)
      box.expandByPoint(new THREE.Vector3(
        i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z
      ).applyMatrix4(M));
  }

  const ctr = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  root.position.sub(ctr);
  const RAD = Math.max(size.x, size.y, size.z) || 1000;

  /* ── камера и управление ── */
  let dist = RAD * 1.9, theta = -0.72, phi = 1.16;
  const target = new THREE.Vector3();
  const place = () => {
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.sin(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
  };

  let drag = null, moved = false, lx = 0, ly = 0, pinch = 0;
  const onDown = e => {
    drag = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    moved = false; lx = e.clientX; ly = e.clientY;
    canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  };
  const onMove = e => {
    if (!drag) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (drag === 'orbit') {
      theta -= dx * 0.006;
      phi = Math.max(0.05, Math.min(Math.PI - 0.05, phi - dy * 0.006));
    } else {
      const s = dist * 0.0013;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
    }
    place();
  };
  const onUp = () => { drag = null; canvas.style.cursor = 'grab'; };
  const onWheel = e => {
    e.preventDefault();
    dist = Math.max(RAD * 0.1, Math.min(RAD * 6, dist * (1 + Math.sign(e.deltaY) * 0.11)));
    place();
  };
  const onCtx = e => e.preventDefault();
  const onTouchStart = e => {
    if (e.touches.length === 2)
      pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                         e.touches[0].clientY - e.touches[1].clientY);
  };
  const onTouchMove = e => {
    if (e.touches.length === 2 && pinch) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                           e.touches[0].clientY - e.touches[1].clientY);
      dist = Math.max(RAD * 0.1, Math.min(RAD * 6, dist * pinch / d)); pinch = d; place();
    }
  };

  /* ── выбор детали ── */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let selected = null;
  const onClick = e => {
    if (moved) return;
    const r = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(meshes.filter(m => m.visible), false)[0];
    if (selected) selected.material = stdMat(selected.userData.part.material, false, selected.userData.part.texAngle);
    selected = hit ? hit.object : null;
    if (selected) selected.material = stdMat(selected.userData.part.material, true);
    if (opts.onSelect) opts.onSelect(selected ? selected.userData.part : null);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: true });
  canvas.addEventListener('click', onClick);

  /* ── размер и цикл отрисовки ── */
  const resize = () => {
    const w = el.clientWidth || 800, h = el.clientHeight || 500;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(el);
  resize(); place();

  let alive = true;
  (function tick() {
    if (!alive) return;
    requestAnimationFrame(tick);
    renderer.render(scene, camera);
  })();

  let playing = null;
  const hidden = new Set();
  const refreshVis = () => meshes.forEach((m, i) => {
    const on = !hidden.has(i) && layerOn(m);
    m.visible = on;
    if (m.userData.wire) m.userData.wire.visible = on && wireOn;
  });
  let wireOn = true, profilesOn = true;
  const layerOn = m => m.userData.part.kind === 'Профиль' ? profilesOn : true;

  return {
    /** Список подвижных узлов: тип, ход/угол, имя. */
    anims: anims.map(a => ({ id: a.id, kind: a.kind, name: a.name,
      limit: a.limit, salonType: a.salonType,
      travel: +a.p2v.distanceTo(a.p1v).toFixed(1) })),
    /** Параметры подвижного узла: тип, угол/ход, текущее положение. */
    animOf(id) {
      const a = anims.find(x => x.id === id);
      return a ? { id: a.id, kind: a.kind, name: a.name, limit: a.limit,
                   travel: +a.p2v.distanceTo(a.p1v).toFixed(1), t: a.t, dir: a.dir } : null;
    },
    /** Положение одного узла: 0 закрыт, 1 открыт. Без id — все сразу. */
    setOpen(t, id) {
      t = Math.max(0, Math.min(1, t));
      if (id == null) { anims.forEach(a => { a.t = t; applyOne(a); }); }
      else { const a = anims.find(x => x.id === id); if (a) { a.t = t; applyOne(a); } }
      return t;
    },
    getOpen(id) {
      if (id == null) return anims.length ? anims[0].t : 0;
      const a = anims.find(x => x.id === id); return a ? a.t : 0;
    },
    /** Развернуть направление, если открывается не в ту сторону. */
    flip(id) { const a = anims.find(x => x.id === id); if (a) { a.dir = -a.dir; applyOne(a); } },
    flipAll() { anims.forEach(a => { a.dir = -a.dir; applyOne(a); }); },
    /** Плавное открытие-закрытие. Без id — вся модель, с id — один узел. */
    play(seconds = 2.5, id) {
      this.stop();
      const list = id == null ? anims : anims.filter(a => a.id === id);
      const t0 = performance.now(), dur = seconds * 1000;
      const step = now => {
        const k = (now - t0) / dur;
        if (k >= 2) { list.forEach(a => { a.t = 0; applyOne(a); }); playing = null; return; }
        const v = k <= 1 ? k : 2 - k;
        const e = v * v * (3 - 2 * v);           // сглаживание на входе и выходе
        list.forEach(a => { a.t = e; applyOne(a); });
        playing = requestAnimationFrame(step);
      };
      playing = requestAnimationFrame(step);
    },
    stop() { if (playing) { cancelAnimationFrame(playing); playing = null; } },

    /* ── видимость деталей ── */
    /** Скрыть или показать деталь по её index из onSelect. */
    setPartVisible(index, on) {
      on ? hidden.delete(index) : hidden.add(index);
      refreshVis();
    },
    hideSelected() {
      if (!selected) return null;
      const i = selected.userData.part.index;
      hidden.add(i);
      selected.material = stdMat(selected.userData.part.material, false, selected.userData.part.texAngle);
      selected = null;
      refreshVis();
      if (opts.onSelect) opts.onSelect(null);
      return i;
    },
    /** Оставить видимой только выбранную деталь. */
    isolateSelected() {
      if (!selected) return;
      const keep = selected.userData.part.index;
      hidden.clear();
      meshes.forEach((m, i) => { if (i !== keep) hidden.add(i); });
      refreshVis();
    },
    showAll() { hidden.clear(); refreshVis(); },
    hiddenCount() { return hidden.size; },
    stats: {
      panels, profiles, roomSurfaces,
      parts: model.parts.length,
      area: +area.toFixed(2),
      sizeMm: [Math.round(size.x), Math.round(size.y), Math.round(size.z)],
      warnings: model.warnings.length,
      movable: anims.length,
      withTexture: [...new Set(model.scene.filter(p => p.t && texOf.has(nameOf(p.m))).map(p => nameOf(p.m)))].length,
    },
    /** Слои: 'wire' рёбра, 'room' поверхности помещения, 'profiles' профили. */
    setLayer(name, on) {
      if (name === 'wire') { wireOn = on; gWire.visible = on; }
      else if (name === 'room') gRoom.visible = on;
      else if (name === 'profiles') { profilesOn = on; refreshVis(); }
      else if (name === 'wireOnly') { wireOn = on; gWire.visible = on; }
    },
    fit() { dist = RAD * 1.9; target.set(0, 0, 0); theta = -0.72; phi = 1.16; place(); },
    setView(v) {
      const V = { iso: [-0.72, 1.16], front: [0, Math.PI / 2], plan: [0, 0.001], left: [-Math.PI / 2, Math.PI / 2] };
      if (V[v]) { [theta, phi] = V[v]; place(); }
    },
    /** Обязательно вызывать при закрытии: иначе течёт память видеокарты. */
    dispose() {
      alive = false; ro.disconnect();
      if (playing) cancelAnimationFrame(playing);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('click', onClick);
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      matCache.forEach(m => m.dispose());
      texCache.forEach(t => t && t.dispose());
      renderer.dispose();
      canvas.remove();
    },
  };
}
