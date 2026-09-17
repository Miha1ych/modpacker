/**
 * repack.js — «Перепаковка текстурпаков».
 * Полностью локально (JSZip в браузере): читаем pack.mcmeta из загруженного
 * ресурспака, пересчитываем pack_format под выбранную версию Minecraft по
 * таблице соответствий и отдаём новый ZIP. Структуру самого пака не трогаем —
 * это осознанное ограничение (см. пояснение на странице).
 *
 * Таблица форматов — с Minecraft Wiki (minecraft.wiki/w/Pack_format).
 */

const PACK_FORMAT_TABLE = [
  { from: '1.6.1',   format: 1,  label: '1.6.1 – 1.8.9' },
  { from: '1.9',     format: 2,  label: '1.9 – 1.10.2' },
  { from: '1.11',    format: 3,  label: '1.11 – 1.12.2' },
  { from: '1.13',    format: 4,  label: '1.13 – 1.14.4' },
  { from: '1.15',    format: 5,  label: '1.15 – 1.16.1' },
  { from: '1.16.2',  format: 6,  label: '1.16.2 – 1.16.5' },
  { from: '1.17',    format: 7,  label: '1.17 – 1.17.1' },
  { from: '1.18',    format: 8,  label: '1.18 – 1.18.2' },
  { from: '1.19',    format: 9,  label: '1.19 – 1.19.2' },
  { from: '1.19.3',  format: 12, label: '1.19.3' },
  { from: '1.19.4',  format: 13, label: '1.19.4' },
  { from: '1.20',    format: 15, label: '1.20 – 1.20.1' },
  { from: '1.20.2',  format: 18, label: '1.20.2' },
  { from: '1.20.3',  format: 22, label: '1.20.3 – 1.20.4' },
  { from: '1.20.5',  format: 32, label: '1.20.5 – 1.20.6' },
  { from: '1.21',    format: 34, label: '1.21 – 1.21.1' },
  { from: '1.21.2',  format: 42, label: '1.21.2 – 1.21.3' },
  { from: '1.21.4',  format: 46, label: '1.21.4' },
  { from: '1.21.5',  format: 55, label: '1.21.5' },
  { from: '1.21.6',  format: 63, label: '1.21.6' },
  { from: '1.21.7',  format: 64, label: '1.21.7 – 1.21.8' },
  { from: '1.21.9',  format: 69, label: '1.21.9 – 1.21.10' },
  { from: '1.21.11', format: 75, label: '1.21.11' },
  { from: '26.1',    format: 84, label: '26.1 – 26.1.2' },
  { from: '26.2',    format: 88, label: '26.2' },
  { from: '26.3',    format: 97, label: '26.3' },
];

function packFormatFor(version) {
  let result = PACK_FORMAT_TABLE[0];
  for (const entry of PACK_FORMAT_TABLE) {
    if (cmpVersions(version, entry.from) >= 0) result = entry;
    else break;
  }
  return result;
}

function guessLabelForFormat(format) {
  const entry = PACK_FORMAT_TABLE.find((e) => e.format === format);
  return entry ? entry.label : null;
}

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileStatus = document.getElementById('fileStatus');
const packInfo = document.getElementById('packInfo');
const infoFilename = document.getElementById('infoFilename');
const infoFormat = document.getElementById('infoFormat');
const infoGuess = document.getElementById('infoGuess');
const versionSelect = document.getElementById('versionSelect');
const repackBtn = document.getElementById('repackBtn');
const repackStatus = document.getElementById('repackStatus');

// Список версий рисуем кастомным выпадающим списком (всегда открывается
// вниз, в едином стиле) — см. enhanceSelectAsDropdown() в js/common.js.
enhanceSelectAsDropdown(versionSelect);

let state = { zip: null, mcmetaPath: null, mcmeta: null, originalName: '' };
let allGameVersions = null;

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  fileStatus.textContent = 'Читаю архив…';
  fileStatus.classList.remove('error');
  packInfo.hidden = true;
  repackBtn.disabled = true;
  repackStatus.textContent = '';

  try {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const candidates = Object.keys(zip.files)
      .filter((p) => !zip.files[p].dir && p.toLowerCase().endsWith('pack.mcmeta'))
      .sort((a, b) => a.split('/').length - b.split('/').length);

    if (candidates.length === 0) {
      throw new Error('Это не похоже на ресурспак Minecraft — внутри архива нет pack.mcmeta.');
    }

    const mcmetaPath = candidates[0];
    const text = await zip.file(mcmetaPath).async('string');
    let mcmeta;
    try {
      mcmeta = JSON.parse(text);
    } catch (e) {
      throw new Error('Не получилось прочитать pack.mcmeta — файл повреждён или это не корректный JSON.');
    }
    if (!mcmeta.pack || typeof mcmeta.pack.pack_format !== 'number') {
      throw new Error('В pack.mcmeta нет числового поля pack.pack_format — не похоже на обычный ресурспак.');
    }

    state = { zip, mcmetaPath, mcmeta, originalName: file.name.replace(/\.zip$/i, '') };

    infoFilename.textContent = file.name;
    infoFormat.textContent = String(mcmeta.pack.pack_format);
    infoGuess.textContent = guessLabelForFormat(mcmeta.pack.pack_format) || 'версию не удалось определить';

    fileStatus.textContent = 'Архив прочитан, pack.mcmeta найден.';
    packInfo.hidden = false;

    await ensureVersions();
  } catch (err) {
    fileStatus.textContent = err.message;
    fileStatus.classList.add('error');
  }
}

async function ensureVersions() {
  if (!allGameVersions) {
    versionSelect.innerHTML = '<option value="">Загружаю список версий…</option>';
    const tags = await api('/tag/game_version');
    allGameVersions = filterModernVersions(tags.filter((v) => v.version_type === 'release'));
  }
  versionSelect.innerHTML = '<option value="">Выбери версию…</option>' +
    allGameVersions.map((v) => `<option value="${v.version}">${v.version}</option>`).join('');
  versionSelect.disabled = false;
}

versionSelect.addEventListener('change', () => {
  repackBtn.disabled = !versionSelect.value;
});

repackBtn.addEventListener('click', async () => {
  if (!state.zip || !versionSelect.value) return;
  const targetVersion = versionSelect.value;
  const oldFormat = state.mcmeta.pack.pack_format;

  repackBtn.disabled = true;
  repackStatus.textContent = 'Пересобираю архив…';
  repackStatus.classList.remove('error');

  try {
    const entry = packFormatFor(targetVersion);
    const newMcmeta = JSON.parse(JSON.stringify(state.mcmeta));
    newMcmeta.pack.pack_format = entry.format;
    delete newMcmeta.pack.supported_formats; // старый диапазон совместимости больше не актуален

    state.zip.file(state.mcmetaPath, JSON.stringify(newMcmeta, null, 2));

    const blob = await state.zip.generateAsync({ type: 'blob' });
    const filename = `${state.originalName}-${targetVersion}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    repackStatus.textContent = `Готово! pack_format ${oldFormat} → ${entry.format} (под ${targetVersion}). Скачан файл ${filename}.`;
  } catch (err) {
    repackStatus.textContent = 'Ошибка: ' + err.message;
    repackStatus.classList.add('error');
  }
  repackBtn.disabled = false;
});
