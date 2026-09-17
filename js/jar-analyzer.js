/**
 * jar-analyzer.js — локальный (без сервера и без ИИ) разбор .jar-файла мода.
 *
 * Как это работает:
 *   1. Открываем .jar как обычный ZIP (JSZip) прямо в браузере пользователя,
 *      файл никуда не отправляется.
 *   2. Для каждого .class-файла разбираем ТОЛЬКО constant pool — заголовок
 *      класса, где лежат все строковые литералы и ссылки на используемые
 *      классы/методы. Это не полная декомпиляция (превратить байткод обратно
 *      в читаемую Java — отдельная большая задача), но даёт 90% сигнала:
 *      видно, какие API вызывает код (сеть, запуск процессов, рефлексия) и
 *      какие строки в нём зашиты (вебхуки, пути к паролям браузера и т.п.).
 *   3. Прогоняем собранные данные через список сигнатур ниже и получаем
 *      список находок с уровнем серьёзности — это и есть эвристика вместо
 *      полноценного антивируса.
 *   4. Отдельно считаем SHA-1 файла (Web Crypto, тоже локально) и сверяем
 *      его с Modrinth — вдруг это точная копия официального файла мода.
 */

// -------------------------------------------------------------------------
// Разбор constant pool одного .class файла
// -------------------------------------------------------------------------
function parseClassConstantPool(u8) {
  if (u8.length < 10) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint32(0) !== 0xCAFEBABE) return null;

  const cpCount = view.getUint16(8);
  const cp = new Array(cpCount);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let offset = 10;

  let i = 1;
  try {
    while (i < cpCount) {
      const tag = view.getUint8(offset); offset += 1;
      switch (tag) {
        case 1: { // Utf8
          const len = view.getUint16(offset); offset += 2;
          const bytes = u8.subarray(offset, offset + len);
          cp[i] = { tag, value: decoder.decode(bytes) };
          offset += len;
          break;
        }
        case 7: case 8: case 16: case 19: case 20: // Class, String, MethodType, Module, Package
          cp[i] = { tag, ref: view.getUint16(offset) }; offset += 2; break;
        case 15: // MethodHandle
          offset += 1;
          cp[i] = { tag, ref: view.getUint16(offset) }; offset += 2; break;
        case 9: case 10: case 11: // Fieldref, Methodref, InterfaceMethodref
          cp[i] = { tag, classRef: view.getUint16(offset), natRef: view.getUint16(offset + 2) }; offset += 4; break;
        case 12: // NameAndType
          cp[i] = { tag, nameRef: view.getUint16(offset), typeRef: view.getUint16(offset + 2) }; offset += 4; break;
        case 17: case 18: // Dynamic, InvokeDynamic
          cp[i] = { tag, natRef: view.getUint16(offset + 2) }; offset += 4; break;
        case 3: case 4: // Integer, Float
          offset += 4; cp[i] = { tag }; break;
        case 5: case 6: // Long, Double — занимают два слота
          offset += 8; cp[i] = { tag }; i++; break;
        default:
          return { cp, truncated: true };
      }
      i++;
    }
  } catch (e) {
    return { cp, truncated: true };
  }
  return { cp };
}

function utf8At(cp, idx) {
  const e = cp[idx];
  return e && e.tag === 1 ? e.value : null;
}

/** Возвращает { strings, classRefs: Set, methodCalls: [{owner,name}] } для одного класса */
function extractClassSignals(u8) {
  const parsed = parseClassConstantPool(u8);
  if (!parsed) return null;
  const { cp } = parsed;
  const strings = [];
  const classRefs = new Set();
  const methodCalls = [];

  for (let idx = 1; idx < cp.length; idx++) {
    const e = cp[idx];
    if (!e) continue;
    if (e.tag === 1) {
      strings.push(e.value);
    } else if (e.tag === 7) {
      const name = utf8At(cp, e.ref);
      if (name) classRefs.add(name);
    } else if (e.tag === 9 || e.tag === 10 || e.tag === 11) {
      const classEntry = cp[e.classRef];
      const owner = classEntry ? utf8At(cp, classEntry.ref) : null;
      const nat = cp[e.natRef];
      const name = nat ? utf8At(cp, nat.nameRef) : null;
      if (owner && name) methodCalls.push({ owner, name });
    }
  }
  return { strings, classRefs, methodCalls };
}

// -------------------------------------------------------------------------
// Сигнатуры: что считаем подозрительным
// -------------------------------------------------------------------------
const SUSPICIOUS_METHOD_CALLS = [
  { owner: 'java/lang/Runtime', name: 'exec', severity: 'critical', label: 'Запуск сторонних программ (Runtime.exec)' },
  { owner: 'java/lang/ProcessBuilder', name: 'start', severity: 'critical', label: 'Запуск сторонних программ (ProcessBuilder.start)' },
  { owner: 'javax/script/ScriptEngine', name: 'eval', severity: 'critical', label: 'Выполнение произвольного скрипта на лету (ScriptEngine.eval)' },
  { owner: 'java/lang/System', name: 'loadLibrary', severity: 'medium', label: 'Загрузка нативной библиотеки (System.loadLibrary)' },
  { owner: 'java/lang/System', name: 'load', severity: 'medium', label: 'Загрузка нативного файла по прямому пути (System.load)' },
  { owner: 'java/net/URLClassLoader', name: '<init>', severity: 'medium', label: 'Динамическая загрузка стороннего кода (URLClassLoader)' },
  { owner: 'java/io/ObjectInputStream', name: 'readObject', severity: 'medium', label: 'Небезопасная десериализация (ObjectInputStream.readObject)' },
  { owner: 'java/lang/Class', name: 'forName', severity: 'low', label: 'Загрузка класса по имени в рантайме (Class.forName)' },
];

const SUSPICIOUS_CLASS_REFS = [
  { pattern: /^java\/net\/(Socket|DatagramSocket|ServerSocket)$/, severity: 'medium', label: 'Прямая сетевая работа через сокеты' },
  { pattern: /^java\/net\/http\/HttpClient$/, severity: 'low', label: 'HTTP-запросы (java.net.http)' },
  { pattern: /^okhttp3\//, severity: 'low', label: 'HTTP-запросы (OkHttp)' },
  { pattern: /^org\/apache\/http\//, severity: 'low', label: 'HTTP-запросы (Apache HttpClient)' },
  { pattern: /^javax\/crypto\//, severity: 'low', label: 'Использование шифрования (может маскировать передаваемые данные)' },
  { pattern: /^java\/lang\/reflect\//, severity: 'low', label: 'Рефлексия — обращение к полям/методам в обход обычного API' },
  { pattern: /^sun\/misc\/Unsafe$/, severity: 'medium', label: 'Использование низкоуровневого sun.misc.Unsafe' },
];

const STRING_PATTERNS = [
  { re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/i, severity: 'critical', label: 'Найден Discord-вебхук — частый признак граббера (слив данных в Discord)' },
  { re: /\\Discord\\Local Storage\\leveldb/i, severity: 'critical', label: 'Прямое обращение к хранилищу токенов Discord' },
  { re: /AppData\\\\?Roaming|AppData\\\\?Local/i, severity: 'high', label: 'Обращение к папке AppData Windows — типично для кражи данных браузера/мессенджеров' },
  { re: /Login Data|\bCookies\b.{0,20}(Chrome|Google|Edge|Default)/i, severity: 'high', label: 'Похоже на чтение сохранённых паролей/куки браузера' },
  { re: /wallet\.dat|Exodus|MetaMask|Electrum/i, severity: 'high', label: 'Похоже на поиск файлов крипто-кошельков' },
  { re: /pastebin\.com\/raw|hastebin\.com|paste\.ee\//i, severity: 'high', label: 'Загрузка кода/данных со сервиса вроде pastebin — частый способ подгрузить вредоносную нагрузку' },
  { re: /\.onion\b/i, severity: 'high', label: 'Обращение к домену .onion (сеть Tor)' },
  { re: /(bit\.ly|tinyurl\.com|is\.gd|cutt\.ly|t\.ly)\//i, severity: 'medium', label: 'Сокращённая ссылка — куда ведёт, заранее не видно' },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, severity: 'low', label: 'Захардкоженный IP-адрес в коде' },
];

const BASE64_BLOB_RE = /^[A-Za-z0-9+/]{80,}={0,2}$/;

const EXECUTABLE_EXT = ['.exe', '.scr', '.bat', '.cmd', '.vbs', '.vbe', '.ps1', '.jse', '.com', '.msi'];
const NATIVE_EXT = ['.dll', '.so', '.dylib'];
const SHELL_EXT = ['.sh'];

// -------------------------------------------------------------------------
// Метаданные мода (best-effort)
// -------------------------------------------------------------------------
async function extractModMeta(zip) {
  if (zip.file('fabric.mod.json')) {
    try {
      const j = JSON.parse(await zip.file('fabric.mod.json').async('string'));
      return {
        loader: 'Fabric', id: j.id, name: j.name || j.id, version: j.version,
        authors: (j.authors || []).map((a) => (typeof a === 'string' ? a : a.name)).join(', '),
        description: j.description,
      };
    } catch (e) { /* игнорируем битые метаданные */ }
  }
  if (zip.file('quilt.mod.json')) {
    try {
      const j = JSON.parse(await zip.file('quilt.mod.json').async('string'));
      const md = (j.quilt_loader && j.quilt_loader.metadata) || {};
      return {
        loader: 'Quilt', id: j.quilt_loader && j.quilt_loader.id, name: md.name || (j.quilt_loader && j.quilt_loader.id),
        version: j.quilt_loader && j.quilt_loader.version,
        authors: (md.contributors ? Object.keys(md.contributors) : []).join(', '),
        description: md.description,
      };
    } catch (e) { /* игнорируем */ }
  }
  const toml = zip.file('META-INF/mods.toml') || zip.file('META-INF/neoforge.mods.toml');
  if (toml) {
    try {
      const text = await toml.async('string');
      const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
      return {
        loader: 'Forge/NeoForge',
        id: grab(/modId\s*=\s*"([^"]+)"/),
        name: grab(/displayName\s*=\s*"([^"]+)"/),
        version: grab(/version\s*=\s*"([^"]+)"/),
        authors: grab(/authors\s*=\s*"([^"]+)"/),
        description: grab(/description\s*=\s*"""?([^"]+)"""?/),
      };
    } catch (e) { /* игнорируем */ }
  }
  if (zip.file('mcmod.info')) {
    try {
      const j = JSON.parse(await zip.file('mcmod.info').async('string'));
      const first = Array.isArray(j) ? j[0] : (j.modList && j.modList[0]);
      if (first) {
        return {
          loader: 'Forge (legacy)', id: first.modid, name: first.name, version: first.version,
          authors: (first.authorList || []).join(', '), description: first.description,
        };
      }
    } catch (e) { /* игнорируем */ }
  }
  return null;
}

// -------------------------------------------------------------------------
// Главная функция анализа
// -------------------------------------------------------------------------
const MAX_CLASSES = 4000;
const MAX_CLASS_SIZE = 3 * 1024 * 1024; // пропускаем аномально большие .class-файлы

async function analyzeJar(file, onProgress) {
  const buf = await file.arrayBuffer();

  // SHA-1 файла целиком (Web Crypto, полностью локально)
  const hashBuf = await crypto.subtle.digest('SHA-1', buf);
  const sha1 = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files);

  const findings = []; // { severity, label, detail?, count? }
  const findingKey = new Map(); // группируем одинаковые находки, считаем count

  function addFinding(severity, label, detail) {
    const key = severity + '|' + label + '|' + (detail || '');
    if (findingKey.has(key)) {
      findingKey.get(key).count++;
      return;
    }
    const f = { severity, label, detail, count: 1 };
    findingKey.set(key, f);
    findings.push(f);
  }

  // ---- 1. Подозрительные файлы не-кода прямо в архиве ----
  const suspiciousFiles = [];
  let nestedJars = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const lower = entry.name.toLowerCase();
    if (EXECUTABLE_EXT.some((ext) => lower.endsWith(ext))) {
      addFinding('critical', 'Внутри архива найден исполняемый/скриптовый файл — моды Minecraft никогда не должны такого содержать', entry.name);
      suspiciousFiles.push(entry.name);
    } else if (NATIVE_EXT.some((ext) => lower.endsWith(ext))) {
      addFinding('low', 'Внутри архива есть нативная библиотека (.dll/.so/.dylib) — иногда легитимно (например LWJGL), но стоит убедиться в источнике', entry.name);
    } else if (SHELL_EXT.some((ext) => lower.endsWith(ext))) {
      addFinding('high', 'Внутри архива найден shell-скрипт', entry.name);
      suspiciousFiles.push(entry.name);
    } else if (lower.endsWith('.jar')) {
      nestedJars++;
    }
  }

  // ---- 2. Метаданные мода ----
  const meta = await extractModMeta(zip);

  // ---- 3. Разбор .class файлов ----
  const classEntries = entries.filter((e) => !e.dir && e.name.toLowerCase().endsWith('.class'));
  const totalClasses = classEntries.length;
  const toProcess = classEntries.slice(0, MAX_CLASSES);

  let shortNameClasses = 0;
  let processedClasses = 0;
  const allStrings = [];

  for (let idx = 0; idx < toProcess.length; idx++) {
    const entry = toProcess[idx];
    let u8;
    try {
      u8 = await entry.async('uint8array');
    } catch (e) { continue; }
    if (u8.length > MAX_CLASS_SIZE) continue;

    const baseName = entry.name.split('/').pop().replace('.class', '');
    if (baseName.length <= 2) shortNameClasses++;

    const signals = extractClassSignals(u8);
    if (!signals) continue;
    processedClasses++;

    for (const call of signals.methodCalls) {
      const sig = SUSPICIOUS_METHOD_CALLS.find((s) => s.owner === call.owner && s.name === call.name);
      if (sig) addFinding(sig.severity, sig.label, `${call.owner.replace(/\//g, '.')}.${call.name}()`);
    }
    for (const cls of signals.classRefs) {
      const sig = SUSPICIOUS_CLASS_REFS.find((s) => s.pattern.test(cls));
      if (sig) addFinding(sig.severity, sig.label, cls.replace(/\//g, '.'));
    }
    for (const str of signals.strings) {
      if (str.length < 4) continue;
      allStrings.push(str);
      for (const sp of STRING_PATTERNS) {
        if (sp.re.test(str)) {
          addFinding(sp.severity, sp.label, str.length > 90 ? str.slice(0, 90) + '…' : str);
        }
      }
    }

    if (onProgress && idx % 40 === 0) onProgress(idx / toProcess.length);
  }

  // base64-подобные длинные строки — считаем отдельно, без огромного детализированного списка
  const base64Count = allStrings.filter((s) => BASE64_BLOB_RE.test(s)).length;
  if (base64Count > 0) {
    addFinding('low', `Найдены длинные base64-подобные строки (${base64Count}) — возможно спрятанные данные, но часто это просто иконки/ресурсы`, null);
  }

  if (totalClasses > 0 && shortNameClasses / totalClasses > 0.6 && totalClasses > 15) {
    addFinding('low', 'Большинство классов имеют однобуквенные имена — похоже на обфускацию (ProGuard и т.п.), это затрудняет ручную проверку, но само по себе не значит, что мод вредоносный', null);
  }
  if (nestedJars > 0) {
    addFinding('low', `Внутри архива есть вложенные .jar (${nestedJars}) — обычно это встроенные библиотеки, само по себе нормально`, null);
  }
  if (classEntries.length > MAX_CLASSES) {
    addFinding('low', `Файл очень большой — разобрали первые ${MAX_CLASSES} из ${classEntries.length} классов`, null);
  }

  // ---- 4. Итоговая оценка риска ----
  const weight = { critical: 40, high: 18, medium: 8, low: 2 };
  const score = findings.reduce((sum, f) => sum + (weight[f.severity] || 0) * Math.min(f.count, 3), 0);
  let risk;
  if (findings.some((f) => f.severity === 'critical')) risk = 'critical';
  else if (score >= 20) risk = 'medium';
  else if (score > 0) risk = 'low';
  else risk = 'clean';

  findings.sort((a, b) => weight[b.severity] - weight[a.severity]);

  return {
    fileName: file.name,
    fileSize: file.size,
    sha1,
    meta,
    risk,
    score,
    findings,
    totalClasses,
    processedClasses,
    suspiciousFiles,
  };
}
