/* Web Worker для расчёта по модели БАЗИС.
 * Разбор 22-мегабайтной модели занимает секунды и разворачивается в ~142 МБ,
 * поэтому его нельзя делать в главном потоке.
 *
 *   const w = new Worker('/bazis-calc.worker.js', { type: 'module' });
 *   w.postMessage({ buffer, materials }, [buffer]);
 *   w.onmessage = e => e.data.ok ? show(e.data.result) : showError(e.data.error);
 */
import { readModel, buildMaterialIndex, calculate } from './bazis-calc.js';

let index = null;   // индекс базы переживает вызовы: строить его на каждую модель незачем

self.onmessage = async (e) => {
  const { buffer, materials, scene = false } = e.data || {};
  try {
    if (materials) index = buildMaterialIndex(materials);
    if (!index) throw new Error('база материалов не передана');
    if (!buffer) throw new Error('файл модели не передан');
    const model = await readModel(buffer, { scene });
    const result = calculate(model, index);
    if (scene) result.scene = model.scene;
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
