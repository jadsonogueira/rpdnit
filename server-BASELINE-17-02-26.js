require('dotenv').config();
const { exec } = require('child_process');
const express = require('express');

// importe o google:
const { google } = require('googleapis');

// --- Google Drive Auth (Windows-friendly) ---
// Preferência: arquivo JSON apontado por GOOGLE_APPLICATION_CREDENTIALS
// Fallback: GOOGLE_SERVICE_ACCOUNT_JSON (se você quiser continuar usando)
let driveAuth = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  driveAuth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
} else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  // fallback robusto: aceita string com quebras "\n" etc.
  let raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).trim();

  // se vier entre aspas no .env, remove
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }

  // tenta normalizar \n (se veio como texto literal)
  raw = raw.replace(/\\n/g, '\n');

  driveAuth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
} else {
  console.warn(
    '[GOOGLE] Nenhuma credencial configurada. Defina GOOGLE_APPLICATION_CREDENTIALS (recomendado) ou GOOGLE_SERVICE_ACCOUNT_JSON.'
  );
}

// 2) Cliente da API Drive v3
const drive = google.drive({ version: 'v3', auth: driveAuth });

/**
 * Sobrescreve um arquivo no Drive (mantém o mesmo fileId)
 * @param {string} fileId    ID do arquivo no Drive (driveItem ID)
 * @param {Buffer} buffer    Conteúdo do PDF
 * @param {string} mimeType  Tipo MIME (ex.: 'application/pdf')
 */
async function overwriteDriveFile(fileId, buffer, mimeType) {
  if (!driveAuth) {
    throw new Error('Google Drive não configurado. Defina GOOGLE_APPLICATION_CREDENTIALS ou GOOGLE_SERVICE_ACCOUNT_JSON.');
  }
  await drive.files.update({
    fileId,
    media: { mimeType, body: buffer },
  });
}

const IM_CHECK = process.platform === 'win32' ? 'magick -version' : 'convert -version';
const GS_CHECK = process.platform === 'win32' ? 'gswin64c -version' : 'gs -version';

// Só tenta checar se o binário existir (evita poluir log)
(async () => {
  try {
    const imBin = process.platform === 'win32' ? 'magick' : 'convert';
    if (await hasBinary(imBin)) {
      exec(IM_CHECK, (error, stdout) => {
        if (error) console.error(`ImageMagick check falhou: ${error.message}`);
        else console.log(`ImageMagick:\n${stdout}`);
      });
    } else {
      console.warn('ImageMagick não encontrado no PATH (ok se não for usar).');
    }

    const gsBin = process.platform === 'win32' ? 'gswin64c' : 'gs';
    if (await hasBinary(gsBin)) {
      exec(GS_CHECK, (error, stdout) => {
        if (error) console.error(`Ghostscript check falhou: ${error.message}`);
        else console.log(`Ghostscript:\n${stdout}`);
      });
    } else {
      console.warn('Ghostscript não encontrado no PATH (ok se não for usar).');
    }
  } catch (e) {
    console.warn('Falha ao checar binários:', e.message);
  }
})();


const app = express();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const AdmZip = require('adm-zip');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execP = util.promisify(exec);
const { createWorker } = require('tesseract.js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { exec: execShell } = require('child_process');

// perto do topo você já tem: const express = require('express'); const app = express();
app.use(express.json({ limit: '20mb' }));

try {
  const ingestRoutes = require('./routes/ingest');
  app.use('/api/ingest', ingestRoutes);
  console.log('Rota /api/ingest carregada com sucesso.');
} catch (e) {
  console.warn('Rota /api/ingest não carregada:', e.message);
}

try {
  const processesRoutes = require('./routes/processes');
  app.use('/api/processes', processesRoutes);
  console.log('Rota /api/processes carregada com sucesso.');
} catch (e) {
  console.warn('Rota /api/processes não carregada:', e.message);
}

try {
  const processDocumentsRoutes = require('./routes/processDocuments');
  app.use('/api/process-documents', processDocumentsRoutes);
  console.log('Rota /api/process-documents carregada com sucesso.');
} catch (e) {
  console.warn('Rota /api/process-documents não carregada:', e.message);
}

function normalizeLangs(input) {
  if (!input) return 'por+eng';
  if (Array.isArray(input)) return input.map(s => String(s).trim()).filter(Boolean).join('+');
  let s = String(input).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(x => String(x).trim()).filter(Boolean).join('+');
    } catch {}
  }
  return s.split('+').map(t => t.trim()).filter(Boolean).join('+');
}

async function getWorker(langs = 'por') {
  console.log(`[OCR] Criando worker Tesseract.js`);

  const worker = await createWorker();

  try {
    console.log('[OCR] Carregando idioma português...');
    await worker.loadLanguage('por');
    await worker.initialize('por');
    console.log('[OCR] Worker inicializado com sucesso');
  } catch (error) {
    console.warn('[OCR] Erro com português, tentando inglês:', error.message);
    try {
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      console.log('[OCR] Worker inicializado com inglês');
    } catch (fallbackError) {
      console.error('[OCR] Falha total na inicialização:', fallbackError.message);
      try { await worker.terminate(); } catch {}
      throw new Error('Não foi possível inicializar o Tesseract.js');
    }
  }

  return worker;
}

/**
 * Torna um PDF pesquisável (OCR):
 * A) ocrmypdf (se instalado)
 * C) tesseract.js (WASM) + pdftoppm (robusto)
 *
 * (Removi o "Caminho B" porque no seu código ele estava quebrado)
 */
async function makePdfSearchable(inBuffer, langs = 'por+eng') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  const inPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(inPath, inBuffer);

  try {
    // --- Caminho A: OCRmyPDF
    if (await hasBinary('ocrmypdf')) {
      console.log('[OCR] Usando ocrmypdf');
      const outPath = path.join(tmpDir, 'output.pdf');
      const cmd = `ocrmypdf --skip-text -l ${langs} --optimize 1 "${inPath}" "${outPath}"`;
      await execP(cmd);
      const out = fs.readFileSync(outPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return out;
    }

    // --- Caminho C: Tesseract.js (WASM) + pdftoppm (robusto)
    const hasPdftoppm = await hasBinary('pdftoppm');
    if (!hasPdftoppm) {
      throw new Error('Nenhuma rota de OCR disponível: falta pdftoppm.');
    }
    console.log('[OCR] Usando tesseract.js (WASM) + pdftoppm');

    const parsed = await pdfParse(inBuffer);
    const numPages = parsed.numpages || 1;
    console.log(`[OCR] Páginas: ${numPages}`);

    const findFirstMatch = (dir, basePrefix, exts = ['png', 'jpg', 'jpeg', 'ppm']) => {
      const files = fs.readdirSync(dir);
      const esc = basePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${esc}-\\d+\\.(?:${exts.join('|')})$`, 'i');
      return files.find(f => re.test(f)) || null;
    };

    const imgPaths = [];
    for (let i = 1; i <= numPages; i++) {
      const basePrefix = `page_${i}`;
      const outPrefix = path.join(tmpDir, basePrefix);

      try { await execP(`pdftoppm -png -f ${i} -l ${i} "${inPath}" "${outPrefix}"`); } catch {}
      let fname = findFirstMatch(tmpDir, basePrefix, ['png', 'ppm']);

      if (!fname) {
        try {
          await execP(`pdftoppm -jpeg -f ${i} -l ${i} "${inPath}" "${outPrefix}"`);
          fname = findFirstMatch(tmpDir, basePrefix, ['jpg', 'jpeg']);
        } catch {}
      }

      if (!fname) {
        const ls = fs.readdirSync(tmpDir).slice(0, 100).join(', ');
        throw new Error(`pdftoppm não gerou imagem para a página ${i}. Dir: [${ls}]`);
      }

      imgPaths.push(path.join(tmpDir, fname));
    }

    const merged = await PDFDocument.create();
    const ocrFont = await merged.embedFont(StandardFonts.Helvetica);

    let worker;
    try {
      worker = await getWorker(langs);

      for (const imgPath of imgPaths) {
        const { data } = await worker.recognize(imgPath);

        const bytes = fs.readFileSync(imgPath);
        const lower = imgPath.toLowerCase();
        const embedded = lower.endsWith('.png')
          ? await merged.embedPng(bytes)
          : await merged.embedJpg(bytes);

        const { width, height } = embedded.size();
        const page = merged.addPage([width, height]);
        page.drawImage(embedded, { x: 0, y: 0, width, height });

        const words = Array.isArray(data?.words) ? data.words : [];
        for (const w of words) {
          const bb = w?.bbox;
          const txt = (w?.text ?? '').trim();
          if (!bb || !txt) continue;

          const x0 = +bb.x0, y0 = +bb.y0, x1 = +bb.x1, y1 = +bb.y1;
          if (![x0, y0, x1, y1].every(Number.isFinite)) continue;

          const h = Math.max(1, y1 - y0);
          const yPdf = height - (y0 + h);
          const size = Math.max(6, Math.min(36, h));

          page.drawText(txt, { x: x0, y: yPdf, size, font: ocrFont });
        }
      }
    } finally {
      if (worker) { try { await worker.terminate(); } catch {} }
    }

    const mergedBytes = await merged.save();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return Buffer.from(mergedBytes);

  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.error('[OCR] Falhou:', e?.message || e);
    throw e;
  }
}

// === Helper: otimiza/resize JPG mantendo nitidez ===
async function optimizeJpegBuffer(inputBuffer, maxWidth = 1500, quality = 85) {
  try {
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'jpg-opt-'));
    const inPath  = path.join(tmpDir, 'in.jpg');
    const outPath = path.join(tmpDir, 'out.jpg');
    fs.writeFileSync(inPath, inputBuffer);

    // Windows usa "magick"; Linux/macOS geralmente "convert"
    const IM_BIN = process.platform === 'win32' ? 'magick' : 'convert';
    const safeMax = Math.max(600, Math.min(4000, Number(maxWidth) || 1500));

    // -resize Wx> só reduz (não amplia); mantém proporção
    const cmd =
      `${IM_BIN} "${inPath}" -resize ${safeMax}x${safeMax}>` +
      ` -sampling-factor 4:2:0 -strip -interlace JPEG -quality ${quality} "${outPath}"`;

    await new Promise((resolve, reject) =>
      exec(cmd, (err, _o, stderr) => err ? reject(new Error(stderr || String(err))) : resolve())
    );

    const out = fs.readFileSync(outPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return out;
  } catch (e) {
    console.error('optimizeJpegBuffer falhou; usando original:', e.message);
    return inputBuffer;
  }
}

/**
 * Se o PDF for maior que 4 MB, tenta comprimir com Ghostscript.
 * Se não houver GS ou der erro, retorna o buffer original.
 */
async function compressPDFIfNeeded(file) {
  const MAX_SIZE = 4 * 1024 * 1024; // 4 MB
  if (!file || !file.buffer) return file?.buffer || Buffer.alloc(0);
  if (file.buffer.length <= MAX_SIZE) return file.buffer;

  // Windows: prefer gswin64c
  const GS_BIN = process.platform === 'win32' ? 'gswin64c' : 'gs';

  // Se GS não existir, não falha o fluxo
  try {
    if (typeof hasBinary === 'function') {
      const ok = await hasBinary(GS_BIN);
      if (!ok) {
        console.warn('[compressPDFIfNeeded] Ghostscript ausente; pulando compressão.');
        return file.buffer;
      }
    }
  } catch {
    console.warn('[compressPDFIfNeeded] Erro checando GS; pulando compressão.');
    return file.buffer;
  }

  const safeName = sanitizeFilename(file.originalname || `in_${Date.now()}.pdf`);
  const timestamp = Date.now();

  // ✅ Windows-friendly temp
  const tmpBase = os.tmpdir();
  const tmpIn  = path.join(tmpBase, `${timestamp}_${safeName}`);
  const tmpOut = path.join(tmpBase, `compressed_${timestamp}_${safeName}`);

  fs.writeFileSync(tmpIn, file.buffer);

  const cmd = [
    `${GS_BIN} -sDEVICE=pdfwrite`,
    '-dCompatibilityLevel=1.4',
    '-dPDFSETTINGS=/screen',
    '-dDownsampleColorImages=true',
    '-dColorImageResolution=72',
    '-dDownsampleGrayImages=true',
    '-dGrayImageResolution=72',
    '-dDownsampleMonoImages=true',
    '-dMonoImageResolution=72',
    '-dNOPAUSE -dQUIET -dBATCH',
    `-sOutputFile="${tmpOut}"`,
    `"${tmpIn}"`
  ].join(' ');

  try {
    await new Promise((resolve, reject) =>
      execShell(cmd, err => err ? reject(err) : resolve())
    );
    const compressed = fs.readFileSync(tmpOut);
    return compressed.length ? compressed : file.buffer;
  } catch (e) {
    console.error('[compressPDFIfNeeded] Falha Ghostscript, usando original:', e.message);
    return file.buffer;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// Importa a classe PDFImage do pdf-image
const PDFImage = require('pdf-image').PDFImage;

app.use(cors({ exposedHeaders: ['Content-Disposition'] }));
app.use(express.urlencoded({ extended: true }));

// Função para remover acentos e caracteres especiais do nome do arquivo
function sanitizeFilename(filename) {
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.\-]/g, '_');
}

async function hasBinary(bin) {
  try {
    await execP(process.platform === 'win32' ? `where ${bin}` : `which ${bin}`);
    return true;
  } catch { return false; }
}

// Verifica variáveis de ambiente obrigatórias (ajuste: aceita JWT_SECRET OU JJWT_SECRET)
const JWT_SECRET_EFFECTIVE = process.env.JWT_SECRET || process.env.JJWT_SECRET;

if (!process.env.MONGODB_URL || !JWT_SECRET_EFFECTIVE) {
  console.error('Erro: defina MONGODB_URL e JWT_SECRET (ou JJWT_SECRET) nas variáveis de ambiente.');
  process.exit(1);
}

// Conexão com MongoDB
mongoose.connect(process.env.MONGODB_URL)
  .then(() => console.log('MongoDB conectado'))
  .catch((err) => {
    console.error('Erro ao conectar ao MongoDB:', err);
    process.exit(1);
  });


// Schema e Model de usuário
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['classe_a', 'classe_b', 'classe_c', 'classe_d', 'classe_e', 'admin'],
    default: 'classe_a'
  }
});
const User = mongoose.model('User', userSchema);

// Modelo de dados para usuários (já existe, vamos reaproveitar)
const Usuario = User;

// Schema e model para usuários externos autorizados
const usuarioExternoSchema = new mongoose.Schema({
  idExterno: { type: String, required: true, unique: true },
  nome:      { type: String, required: true },
  empresa:   { type: String, required: true },
});
const UsuarioExterno = mongoose.model('UsuarioExterno', usuarioExternoSchema);

// Schema e model para contratos SEI
const contratoSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
});
const Contrato = mongoose.model('Contrato', contratoSchema);

// =================== Processos SEI ===================
const processSchema = new mongoose.Schema({
  seiNumber: String,
  seiNumberNorm: String,
  subject: String,
  title: String,
  type: String,
  tags: [String],
  unit: String,
  assignedTo: String,
  status: String,
  contracts: [String],
  diasUltimaMovimentacao: Number,
  updatedAtSEI: Date,
  updatedAt: Date,
  lastSyncedAt: Date,
  createdAt: { type: Date, default: Date.now }
}, { collection: 'processes' });

const Process = mongoose.models.Process || mongoose.model('Process', processSchema);

// GET /api/processes
app.get('/api/processes', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.max(parseInt(limit, 10) || 10, 1);

    let query = {};
    if (search && search.trim().length >= 2) {
      const term = search.trim();
      const normalizado = term.replace(/[.\-\/\s]/g, '');
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const rx = new RegExp(esc(term), 'i');
      const rxNorm = new RegExp(esc(normalizado), 'i');

      query = {
        $or: [
          { seiNumber: rx },
          { seiNumberNorm: rxNorm },
          { title: rx },
          { subject: rx },
          { unit: rx },
          { status: rx },
          { tags: rx }
        ]
      };
    }

    const [items, total] = await Promise.all([
      Process.find(query).sort({ updatedAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      Process.countDocuments(query)
    ]);

    const totalPages = Math.max(Math.ceil(total / l), 1);
    return res.json({ items, page: p, totalPages, total });
  } catch (err) {
    console.error('GET /api/processes error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Rota para buscar documentos pelo seiNumberNorm direto
app.get('/api/processes/by-sei/:seiNumberNorm/documents', async (req, res) => {
  try {
    const { seiNumberNorm } = req.params;

    const items = await mongoose.connection
      .collection('processDocuments')
      .find({ seiNumberNorm }, { projection: { _id: 0, docNumber: 1, docTitle: 1 } })
      .sort({ docNumber: 1 })
      .toArray();

    return res.json({ count: items.length, items });
  } catch (err) {
    console.error('GET /api/processes/by-sei/:seiNumberNorm/documents error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Lista documentos relacionados a um processo pelo _id
app.get('/api/processes/:id/documents', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const process = await Process.findById(id, { seiNumberNorm: 1 }).lean();
    if (!process) {
      return res.status(404).json({ error: 'Processo não encontrado' });
    }

    const items = await mongoose.connection
      .collection('processDocuments')
      .find({ seiNumberNorm: process.seiNumberNorm }, { projection: { _id: 0, docNumber: 1, docTitle: 1 } })
      .sort({ docNumber: 1 })
      .toArray();

    return res.json({ count: items.length, items });
  } catch (err) {
    console.error('GET /api/processes/:id/documents error', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Rota para listar usuários (sem a senha)
app.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, { password: 0 });
    res.json(usuarios);
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    res.status(500).send('Erro ao buscar usuários');
  }
});

app.get('/_debug/ocr-binaries', async (req, res) => {
  try {
    const GS_BIN = process.platform === 'win32' ? 'gswin64c' : 'gs';
    const out = {
      ocrmypdf: await hasBinary('ocrmypdf'),
      tesseract: await hasBinary('tesseract'),
      pdftoppm: await hasBinary('pdftoppm'),
      gs: await hasBinary(GS_BIN),
      magick: await hasBinary(process.platform === 'win32' ? 'magick' : 'convert'),
    };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rota para remover um usuário externo pelo ID
app.delete('/usuarios-externos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await UsuarioExterno.findByIdAndDelete(id);

    if (!resultado) {
      return res.status(404).json({ message: 'Usuário externo não encontrado' });
    }

    res.json({ message: 'Usuário externo removido com sucesso' });
  } catch (err) {
    console.error('Erro ao remover usuário externo:', err);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota de teste da DB
app.get('/test-db', (req, res) => {
  res.send('Conexão com o MongoDB funcionando.');
});

// Rota de cadastro
app.post('/signup', express.json(), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).send('Todos os campos são obrigatórios');
    }
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).send('Usuário ou e-mail já cadastrado');
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, email, password: hashedPassword });
    await user.save();
    res.status(201).send('Usuário registrado com sucesso');
  } catch (err) {
    console.error('Erro ao registrar usuário:', err);
    res.status(500).send('Erro no servidor');
  }
});

app.post('/login', express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send('Todos os campos são obrigatórios');
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).send('Usuário não encontrado');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send('Senha incorreta');

    const token = jwt.sign(
      { id: user._id, role: user.role },
      JWT_SECRET_EFFECTIVE,
      { expiresIn: '1h' }
    );

    res.send({
      token,
      role: user.role,
      nome: user.nome,
      email: user.email
    });

  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).send('Erro no servidor');
  }
});

// Rota para inserir usuários externos
app.post('/usuarios-externos', express.json(), async (req, res) => {
  try {
    const usuarios = req.body;

    if (!Array.isArray(usuarios)) {
      return res.status(400).send('Esperado um array de usuários externos.');
    }

    const inseridos = await UsuarioExterno.insertMany(usuarios, { ordered: false });
    res.status(201).send(`Inseridos ${inseridos.length} usuários externos`);
  } catch (err) {
    console.error('Erro ao inserir usuários externos:', err);
    if (err.code === 11000) {
      res.status(409).send('ID de usuário externo duplicado.');
    } else {
      res.status(500).send('Erro no servidor');
    }
  }
});

// Rota para listar todos os usuários externos
app.get('/usuarios-externos', async (req, res) => {
  try {
    const lista = await UsuarioExterno.find().sort({ nome: 1 });
    res.json(lista);
  } catch (err) {
    console.error('Erro ao buscar usuários externos:', err);
    res.status(500).send('Erro ao buscar usuários externos');
  }
});

app.post('/contratos', express.json(), async (req, res) => {
  try {
    const { numero } = req.body;
    if (!numero) {
      return res.status(400).send('O número do contrato é obrigatório.');
    }
    const novoContrato = new Contrato({ numero });
    await novoContrato.save();
    res.status(201).send('Contrato cadastrado com sucesso');
  } catch (err) {
    console.error('Erro ao cadastrar contrato:', err);
    if (err.code === 11000) {
      res.status(409).send('Contrato já existente.');
    } else {
      res.status(500).send('Erro ao cadastrar contrato');
    }
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/merge-pdf', upload.array('pdfs'), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).send('É necessário enviar pelo menos dois arquivos PDF');
    }

    const arquivosOrdenados = [...req.files].sort((a, b) =>
      a.originalname.localeCompare(b.originalname, 'pt', { numeric: true, sensitivity: 'base' })
    );

    const baseName = path.parse(arquivosOrdenados[0].originalname).name;
    const safeBase = baseName.replace(/[^\w\-]+/g, '_');
    const downloadName = `${safeBase}_merge.pdf`;

    const mergedPdf = await PDFDocument.create();

    for (const file of arquivosOrdenados) {
      const isPdf =
        (file.mimetype && file.mimetype.toLowerCase().includes('pdf')) ||
        /\.pdf$/i.test(file.originalname);

      if (!isPdf) {
        return res.status(400).send(`Arquivo não é PDF: ${file.originalname}`);
      }

      const pdf = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => mergedPdf.addPage(p));
    }

    const buf = Buffer.from(await mergedPdf.save());

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', String(buf.length));
    res.set('Content-Disposition',
      `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );

    return res.send(buf);
  } catch (err) {
    console.error('Erro no merge-pdf:', err);
    return res.status(500).send(`Erro ao unir PDFs: ${err.message}`);
  }
});

// --- Helper: interpreta "ranges" do split (ex.: "1-3,5,7-9") ---
function parseRanges(spec, totalPages) {
  const ranges = [];
  if (!spec) {
    return Array.from({ length: totalPages }, (_, i) => ({ start: i + 1, end: i + 1 }));
  }
  const parts = spec.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes('-')) {
      const [aStr, bStr] = part.split('-');
      const a = parseInt(aStr, 10);
      const b = parseInt(bStr, 10);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`Faixa inválida: "${part}"`);
      }
      if (a < 1 || b < 1 || a > totalPages || b > totalPages) {
        throw new Error(`Faixa fora do total de páginas (${totalPages}): "${part}"`);
      }
      const start = Math.min(a, b);
      const end   = Math.max(a, b);
      ranges.push({ start, end });
    } else {
      const p = parseInt(part, 10);
      if (!Number.isInteger(p) || p < 1 || p > totalPages) {
        throw new Error(`Página inválida ou fora do total (${totalPages}): "${part}"`);
      }
      ranges.push({ start: p, end: p });
    }
  }

  return ranges;
}

app.post('/split-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') {
      return res.status(400).send('Envie um único arquivo com field "pdf" (application/pdf).');
    }

    const srcPdf = await PDFDocument.load(req.file.buffer);
    const totalPages = srcPdf.getPageCount();

    const rangesSpec = (req.body.ranges || req.query.ranges || '').trim();
    const ranges = rangesSpec
      ? parseRanges(rangesSpec, totalPages)
      : Array.from({ length: totalPages }, (_, i) => ({ start: i + 1, end: i + 1 }));

    const zip = new AdmZip();

    for (const { start, end } of ranges) {
      const out = await PDFDocument.create();
      const idxsZeroBased = Array.from({ length: end - start + 1 }, (_, i) => (start - 1) + i);
      const pages = await out.copyPages(srcPdf, idxsZeroBased);
      pages.forEach(p => out.addPage(p));

      const bytes = await out.save();
      const filename = start === end
        ? `page-${String(start).padStart(3, '0')}.pdf`
        : `pages-${String(start).padStart(3, '0')}-${String(end).padStart(3, '0')}.pdf`;

      zip.addFile(filename, Buffer.from(bytes));
    }

    const zipBuffer = zip.toBuffer();

    const baseName = path.parse(req.file.originalname).name;
    const safeBase = baseName.replace(/[^\w\-]+/g, '_');
    const downloadName = `${safeBase}_split.zip`;

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${downloadName}"`);
    return res.send(zipBuffer);

  } catch (err) {
    console.error('Erro no split-pdf:', err);
    res.status(400).send(`Erro ao dividir PDF: ${err.message}`);
  }
});

// Rota para listar contratos (GET)
app.get('/contratos', async (req, res) => {
  try {
    const contratos = await Contrato.find().sort({ numero: 1 });
    res.json(contratos);
  } catch (err) {
    console.error('Erro ao buscar contratos:', err);
    res.status(500).send('Erro ao buscar contratos');
  }
});

app.use((req, res, next) => {
  if (req.path === '/send-email') {
    console.log('[DEBUG] chegou em /send-email - método', req.method);
  }
  next();
});

app.post('/send-email', upload.any(), async (req, res) => {
  console.log('[DEBUG] chegou no /send-email - método POST');
  try {
    console.log('Dados recebidos no formulário:', req.body);
    const fluxo = req.body.fluxo;
    const dados = req.body;

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).send('Token não fornecido.');

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_SECRET_EFFECTIVE);
      userId = decoded.id;
    } catch (err) {
      return res.status(401).send('Token inválido.');
    }

    const usuario = await Usuario.findById(userId);
    if (!usuario) {
      return res.status(404).send('Usuário não encontrado.');
    }

    let mailContent = `Fluxo: ${fluxo}\n\nDados do formulário:\n`;

    function getSeiFromDados(d) {
      const direto =
        d.processoSei ||
        d.seiTrim ||
        d.sei ||
        d.numeroSei ||
        d.numero_sei ||
        d['Número do processo SEI'];

      if (direto && String(direto).trim()) return String(direto).trim();

      const tryFields = [d.subject, d.assunto, d.text, d.mensagem];
      const reSei = /(\d{5}\.\d{6}\/\d{4}-\d{2})/;

      for (const f of tryFields) {
        if (!f) continue;
        const m = String(f).match(reSei);
        if (m && m[1]) return m[1];
      }
      return '';
    }

    const numeroSei = getSeiFromDados(dados);

    const { envio, quando, quandoUtc } = req.body;

    function spToUtcIso(localStr) {
      if (!localStr) return null;

      let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(localStr);
      if (!m) {
        const m12 = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(localStr);
        if (!m12) return null;
        let hh = (+m12[4]) % 12;
        if (/pm/i.test(m12[6])) hh += 12;
        m = [null, m12[1], m12[2], m12[3], String(hh).padStart(2, '0'), m12[5]];
      }

      const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mi = +m[5];
      const ms = Date.UTC(y, mo - 1, d, hh + 4, mi, 0);
      return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    let agIso = null;
    if (envio === 'agendar') {
      agIso = spToUtcIso(quando) ||
        (quandoUtc && (() => {
          const d = new Date(quandoUtc);
          return isNaN(d) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
        })());
    } else {
      agIso = new Date(Date.now() + 5 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    if (agIso) {
      mailContent += `Agendamento: ${agIso}\n`;
    }

    mailContent += `Requerente: ${usuario?.username || 'Desconhecido'}\n`;
    mailContent += `Email: ${usuario?.email || 'Não informado'}\n`;

    let attachments = [];

    if (fluxo === 'Liberar assinatura externa') {
      mailContent += `Assinante: ${dados.assinante || ''}\n`;
      mailContent += `Número do DOC_SEI: ${dados.numeroDocSei || ''}\n`;

    } else if (fluxo === 'Consultar empenho') {
      mailContent += `Contrato SEI: ${dados.contratoSei || ''}\n`;

    } else if (fluxo === 'Liberar acesso externo') {
      mailContent += `Usuário: ${dados.user || ''}\n`;
      mailContent += `Número do Processo SEI: ${dados.processo_sei || ''}\n`;

    } else if (fluxo === 'Analise de processo') {
      mailContent += `Número do Processo SEI: ${dados.processo_sei || ''}\n`;

      const idMap = {
        memoriaCalculo: process.env.MEMORIA_FILE_ID,
        diarioObra: process.env.DIARIO_FILE_ID,
        relatorioFotografico: process.env.RELATORIO_FILE_ID
      };

      for (const file of req.files) {
        const fileId = idMap[file.fieldname];
        if (!fileId) continue;
        if (file.mimetype !== 'application/pdf') {
          return res.status(400).send(`Tipo inválido: ${file.originalname}`);
        }
        await overwriteDriveFile(fileId, file.buffer, file.mimetype);
        console.log(`Atualizado no Drive: ${file.fieldname} (fileId=${fileId})`);
      }

    } else if (fluxo === 'Alterar ordem de documentos') {
      mailContent += `Número do Processo SEI: ${dados.processoSei || ''}\n`;
      mailContent += `Instruções: ${dados.instrucoes || ''}\n`;

    } else if (fluxo === 'Inserir anexo em doc SEI') {
      mailContent += `Número do DOC_SEI: ${dados.numeroDocSei || ''}\n`;

    } else if (fluxo === 'Inserir imagem em doc SEI') {
      mailContent += `Número do DOC_SEI: ${dados.numeroDocSei || ''}\n`;

    } else if (fluxo === 'Assinatura em doc SEI') {
      mailContent += `Número do DOC_SEI: ${dados.numeroDocSei || ''}\n`;
      mailContent += `Usuário: ${dados.user || ''}\n`;
      mailContent += `Senha: ${dados.key || ''}\n`;

    } else if (fluxo === 'Criar Doc SEI Editável') {
      mailContent += `Número do Processo SEI: ${dados.processoSei || ''}\n`;
      mailContent += `Tipo do Documento: ${dados.tipoDocumento || ''}\n`;
      mailContent += `Número: ${dados.numero || ''}\n`;
      mailContent += `Nome na Árvore: ${dados.nomeArvore || ''}\n`;

    } else if (fluxo === 'Criar Doc SEI Externo') {
      const agora = new Date();
      agora.setHours(agora.getHours() - 3);
      const dia = String(agora.getDate()).padStart(2, '0');
      const mes = String(agora.getMonth() + 1).padStart(2, '0');
      const ano = agora.getFullYear();
      const dataFormatada = `${dia}/${mes}/${ano}`;
      mailContent += `Número do Processo SEI: ${dados.processoSei || ''}\n`;
      mailContent += `Data: ${dataFormatada}\n`;
      mailContent += `Tipo do Documento: ${dados.tipoDocumento || ''}\n`;
      mailContent += `Número: ${dados.numero || ''}\n`;
      mailContent += `Nome na Árvore: ${dados.nomeArvore || ''}\n`;

    } else if (fluxo === 'Atualizar lista de documentos') {
      if (numeroSei) {
        mailContent += `Número do Processo SEI: ${numeroSei}\n`;
      }
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const safeOriginalName = sanitizeFilename(file.originalname);

        if (file.fieldname.startsWith('imagem')) {
          if (!file.mimetype.startsWith('image/')) {
            return res.status(400).send(`Tipo de arquivo não permitido: ${file.originalname}`);
          }
          if (file.size > 5 * 1024 * 1024) {
            return res.status(400).send(`Arquivo muito grande: ${file.originalname}`);
          }
          attachments.push({ filename: safeOriginalName, content: file.buffer });

        } else if (file.fieldname === 'arquivoZip') {
          try {
            const zip = new AdmZip(file.buffer);
            const zipEntries = zip.getEntries();
            if (attachments.length + zipEntries.length > 100) {
              return res.status(400).send('O total de arquivos excede o limite de 100.');
            }
            for (const entry of zipEntries) {
              if (entry.isDirectory) continue;
              const extension = path.extname(entry.entryName).toLowerCase();
              const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp'];
              if (!allowedExtensions.includes(extension)) {
                return res.status(400).send(`Tipo de arquivo não permitido no ZIP: ${entry.entryName}`);
              }
              const fileContent = entry.getData();
              if (fileContent.length > 5 * 1024 * 1024) {
                return res.status(400).send(`Arquivo muito grande no ZIP: ${entry.entryName}`);
              }
              const safeZipName = sanitizeFilename(entry.entryName);
              attachments.push({ filename: safeZipName, content: fileContent });
            }
          } catch (error) {
            console.error('Erro ao processar o arquivo ZIP:', error);
            return res.status(400).send('Erro ao processar o arquivo ZIP.');
          }

        } else if (file.fieldname === 'arquivo') {
          attachments.push({ filename: safeOriginalName, content: file.buffer });

        } else if (file.fieldname === 'arquivoPdf') {
          try {
            if (!/application\/pdf/i.test(file.mimetype)) {
              return res.status(400).send(`Arquivo inválido (esperado PDF): ${file.originalname}`);
            }

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
            const inputPath = path.join(tempDir, 'input.pdf');
            fs.writeFileSync(inputPath, file.buffer);

            const TARGET = 1500;
            const safeBase = sanitizeFilename(file.originalname.replace(/\.pdf$/i, ''));
            const outputPrefix = path.join(tempDir, 'page');

            const command = `pdftoppm -jpeg -scale-to ${TARGET} -jpegopt quality=82 "${inputPath}" "${outputPrefix}"`;
            await new Promise((resolve, reject) => {
              exec(command, (error, _stdout, stderr) =>
                error ? reject(new Error(stderr || error.message)) : resolve()
              );
            });

            const allFiles = fs.readdirSync(tempDir)
              .filter(name => /^page-\d+\.jpg$/i.test(name))
              .sort((a, b) => {
                const ai = parseInt(a.match(/^page-(\d+)\.jpg$/i)[1], 10);
                const bi = parseInt(b.match(/^page-(\d+)\.jpg$/i)[1], 10);
                return ai - bi;
              });

            if (allFiles.length === 0) {
              throw new Error('Nenhuma imagem gerada pelo pdftoppm');
            }

            for (const fname of allFiles) {
              const imagePath = path.join(tempDir, fname);
              const imgBuffer = fs.readFileSync(imagePath);
              const optimized = await optimizeJpegBuffer(imgBuffer, TARGET, 82);

              const n = parseInt(fname.match(/^page-(\d+)\.jpg$/i)[1], 10);
              attachments.push({
                filename: `${safeBase}_page_${String(n).padStart(3, '0')}.jpg`,
                content: optimized,
                contentType: 'image/jpeg'
              });

              try { fs.unlinkSync(imagePath); } catch {}
            }

            try { fs.unlinkSync(inputPath); } catch {}
            try { fs.rmdirSync(tempDir, { recursive: true }); } catch {}

          } catch (error) {
            console.error('Erro na conversão de PDF para JPG (send-email/arquivoPdf):', error.message);
            return res.status(400).send('Erro na conversão do PDF para JPG: ' + error.message);
          }
        }
      }
    }

    const totalBytes = attachments.reduce((sum, a) => sum + (a.content?.length || 0), 0);
    console.log(`Total de bytes nos attachments (raw): ${totalBytes}`);
    console.log(`Total estimado com Base64 (~4/3): ${Math.round(totalBytes * 4 / 3)}`);
    console.log('Attachments nomes:', attachments.map(a => a.filename));

    const provider = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();

    if (provider === 'resend') {
      const { sendWithResend } = require('./email/resend');

      try {
        const safeHtml = `<pre>${mailContent.replace(/[&<>]/g, s => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]
        ))}</pre>`;

        const result = await sendWithResend({
          to: 'jadsonnogueira@msn.com',
          subject: `${fluxo}`,
          text: mailContent,
          html: safeHtml,
          attachments,
        });

        console.log('[EMAIL] Enviado via Resend. id=', result && result.id);
        return res.send('E-mail enviado com sucesso');
      } catch (err) {
        const payloadErr = err?.response?.data || err?.message || err;
        console.error('Erro ao enviar via Resend:', payloadErr);
        return res.status(500).type('text/plain').send('Erro ao enviar o e-mail (Resend).');
      }

    } else {
      // Gmail SMTP (Nodemailer)
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      });

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'jadsonnogueira@msn.com',
        subject: `${fluxo}`,
        text: mailContent,
        attachments,
      };

      transporter.sendMail(mailOptions)
        .then(info => {
          console.log('[SEND] ✅ ok messageId=', info && info.messageId);
          return res.send('E-mail enviado com sucesso');
        })
        .catch(err => {
          const msg = (err && (err.response || err.message)) || String(err);
          console.error('[SEND][SMTP ERROR] ❌', msg);
          return res.status(500).type('text/plain').send(`Erro ao enviar o e-mail: ${msg}`);
        });
    }

  } catch (err) {
    console.error('Erro ao processar o envio de e-mail:', err);
    return res.status(500).send('Erro no servidor');
  }
});

// /verify-token robusto: aceita GET (sem body) e não retorna 401
app.get('/verify-token', (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const token = headerToken || req.query.token || null;

    if (!token) return res.json({ valid: false, error: 'Token ausente' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET_EFFECTIVE);
      return res.json({ valid: true, userId: decoded.id, role: decoded.role });
    } catch {
      return res.json({ valid: false, error: 'Token inválido ou expirado' });
    }
  } catch (e) {
    console.error('verify-token (GET) erro:', e.message);
    return res.json({ valid: false, error: 'Erro interno' });
  }
});

// Rota para a página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// PDF -> JPG
app.post('/pdf-to-jpg', upload.single('arquivoPdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') {
      return res.status(400).send('Arquivo inválido ou ausente');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    const inputPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(inputPath, req.file.buffer);

    const parsed = await pdfParse(req.file.buffer);
    const numPages = parsed.numpages;

    const baseName = path.basename(req.file.originalname, '.pdf');
    const safeBase = sanitizeFilename(baseName);

    let attachments = [];

    for (let i = 1; i <= numPages; i++) {
      const outputPrefix = path.join(tempDir, `page_${i}`);
      const TARGET = 1500;

      const command = `pdftoppm -jpeg -scale-to ${TARGET} -jpegopt quality=82 -f ${i} -l ${i} "${inputPath}" "${outputPrefix}"`;

      await new Promise((resolve, reject) => {
        exec(command, (error, _stdout, stderr) => {
          if (error) reject(new Error(`Erro ao converter página ${i}: ${stderr}`));
          else resolve();
        });
      });

      const imagePath = `${outputPrefix}-${i}.jpg`;
      if (fs.existsSync(imagePath)) {
        const imgBuffer = fs.readFileSync(imagePath);
        const optimized = await optimizeJpegBuffer(imgBuffer, 1500, 82);
        attachments.push({ filename: `${safeBase}_page_${i}.jpg`, content: optimized });

        fs.unlinkSync(imagePath);
      }
    }

    fs.unlinkSync(inputPath);
    fs.rmdirSync(tempDir, { recursive: true });

    if (attachments.length > 1) {
      const zip = new AdmZip();
      attachments.forEach(att => zip.addFile(att.filename, att.content));
      const zipBuffer = zip.toBuffer();

      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${safeBase}.zip"`);
      return res.send(zipBuffer);
    } else {
      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Disposition', `attachment; filename="${attachments[0].filename}"`);
      return res.send(attachments[0].content);
    }

  } catch (err) {
    console.error('Erro na conversão de PDF para JPG:', err);
    res.status(500).send('Erro ao converter PDF: ' + err.message);
  }
});

// OCR
app.post('/pdf-make-searchable', upload.single('arquivoPdf'), async (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') {
      return res.status(400).send('Envie um "arquivoPdf" (application/pdf).');
    }

    const langs = normalizeLangs(
      req.body.lang ?? req.query.lang ?? process.env.OCR_LANGS ?? 'por+eng'
    );

    const inputBuffer = await compressPDFIfNeeded(req.file);
    const searchable = await makePdfSearchable(inputBuffer, langs);

    const baseName = path.parse(req.file.originalname).name;
    const safeBase = sanitizeFilename(baseName);
    const downloadName = `${safeBase}_pesquisavel.pdf`;

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', String(searchable.length));
    res.set('Content-Disposition',
      `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    return res.send(searchable);
  } catch (err) {
    console.error('Erro no /pdf-make-searchable:', err);
    return res.status(500).send('Erro ao tornar PDF pesquisável: ' + err.message);
  }
});

// Inicia o servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
