const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir frontend estático directamente
app.use(express.static(__dirname));

// Localizador de ejecutable yt-dlp
function getYtDlpPath() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

  const localBin = path.join(__dirname, 'bin', binName);
  if (fs.existsSync(localBin)) return localBin;

  const tmpBin = path.join(os.tmpdir(), binName);
  if (fs.existsSync(tmpBin)) return tmpBin;

  return binName;
}

// Descarga automática en runtime para serverless Linux (Cloud Functions)
async function ensureYtDlpBinary() {
  const isWin = process.platform === 'win32';
  const binPath = getYtDlpPath();

  if (fs.existsSync(binPath)) return binPath;

  if (!isWin) {
    const targetPath = path.join(os.tmpdir(), 'yt-dlp');
    if (!fs.existsSync(targetPath)) {
      console.log('Descargando binario yt-dlp para Linux...');
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(targetPath);
        const fetchFile = (url) => {
          https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              fetchFile(res.headers.location);
            } else {
              res.pipe(file);
              file.on('finish', () => {
                file.close(() => {
                  fs.chmodSync(targetPath, 0o755);
                  resolve(targetPath);
                });
              });
            }
          }).on('error', reject);
        };
        fetchFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
      });
    }
    return targetPath;
  }

  return binPath;
}

// Formatos optimizados estándar (con 720p prioritario)
function getOptimizedFormats() {
  return [
    {
      id: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      label: 'Video 720p HD (MP4) • Recomendado',
      isAudio: false,
      ext: 'mp4'
    },
    {
      id: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      label: 'Video 1080p Full HD (MP4)',
      isAudio: false,
      ext: 'mp4'
    },
    {
      id: '18/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best',
      label: 'Video 480p / 360p Rápido (MP4)',
      isAudio: false,
      ext: 'mp4'
    },
    {
      id: 'bestaudio/best',
      label: 'Solo Audio MP3 (Máxima fidelidad)',
      isAudio: true,
      ext: 'mp3'
    }
  ];
}

// Búsqueda ultra-rápida vía oEmbed
async function getQuickMetadata(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.title || 'Video de YouTube',
          uploader: data.author_name || 'YouTube Creator',
          thumbnail: data.thumbnail_url || '',
          duration: 0,
          formats: getOptimizedFormats()
        };
      }
    } catch (_) {}
  }

  if (/tiktok\.com/i.test(url)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        return {
          title: data.title || 'Video de TikTok',
          uploader: data.author_name || 'TikTok Creator',
          thumbnail: data.thumbnail_url || '',
          duration: 0,
          formats: getOptimizedFormats()
        };
      }
    } catch (_) {}
  }

  return null;
}

// Sanitizar nombres de archivo
function sanitizeFilename(name) {
  return (name || 'media').replace(/[/\\?%*:|"<>]/g, '_').trim();
}

// Formatear tiempos de recorte
function formatSectionTime(timeStr) {
  if (!timeStr) return null;
  const cleaned = timeStr.trim().replace(/^[*]/, '');
  return /^\d{1,2}(:\d{2}){1,2}$/.test(cleaned) || /^\d+$/.test(cleaned) ? cleaned : null;
}

// Endpoint de búsqueda y metadatos
const handleInfo = async (req, res) => {
  const { url } = req.body || req.query || {};
  if (!url) {
    return res.status(400).json({ message: 'URL requerida.' });
  }

  const fastMeta = await getQuickMetadata(url);
  if (fastMeta) {
    return res.json(fastMeta);
  }

  try {
    const ytDlpCmd = await ensureYtDlpBinary();
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--skip-download',
      '--js-runtimes', 'node',
      '--extractor-args', 'youtube:skip=translated_subs,comments',
      url
    ];

    execFile(ytDlpCmd, args, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
      if (err) {
        console.error('Error yt-dlp info:', stderr || err.message);
        return res.status(500).json({ 
          message: 'No se pudo obtener información del enlace. Verifica que sea público.' 
        });
      }

      try {
        const data = JSON.parse(stdout);
        const formatList = getOptimizedFormats();

        return res.json({
          title: data.title || 'Contenido Multimedia',
          uploader: data.uploader || data.channel || data.creator || 'Desconocido',
          thumbnail: data.thumbnail || '',
          duration: data.duration || 0,
          formats: formatList
        });
      } catch (parseErr) {
        return res.status(500).json({ message: 'Error procesando los datos devueltos.' });
      }
    });
  } catch (initErr) {
    return res.status(500).json({ message: 'Error en el motor de descarga.' });
  }
};

// Endpoint de descarga de alta velocidad (Soporta GET y POST)
const handleDownload = async (req, res) => {
  const params = req.method === 'GET' ? req.query : req.body;
  const { 
    url, 
    formatId, 
    isAudio = false, 
    ext = 'mp4', 
    title = 'media', 
    startTime, 
    endTime 
  } = params || {};

  const audioMode = isAudio === true || isAudio === 'true';

  if (!url) {
    return res.status(400).send('URL requerida.');
  }

  try {
    const ytDlpCmd = await ensureYtDlpBinary();
    const fileId = crypto.randomBytes(8).toString('hex');
    const tempDir = os.tmpdir();
    const outputTemplate = path.join(tempDir, `${fileId}.%(ext)s`);

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--js-runtimes', 'node',
      '-N', '4',
      '--concurrent-fragments', '4',
      url,
      '-o', outputTemplate
    ];

    if (audioMode) {
      args.push('-x', '--audio-format', 'mp3');
    } else if (formatId) {
      args.push('-f', formatId);
      args.push('--merge-output-format', 'mp4');
    }

    // Recorte rápido sin forzar re-encodificación lenta
    const start = formatSectionTime(startTime);
    const end = formatSectionTime(endTime);

    if (start || end) {
      args.push('--download-sections', `*${start || '0'}-${end || 'inf'}`);
    }

    console.log(`[Inicio descarga]: ${url}`);
    const ytdlp = spawn(ytDlpCmd, args);

    ytdlp.stderr.on('data', (d) => {
      // Registrar solo errores reales
      const str = d.toString();
      if (str.includes('ERROR')) console.error(`[yt-dlp error]: ${str}`);
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        if (!res.headersSent) {
          return res.status(500).send('Error durante el procesamiento del archivo.');
        }
        return;
      }

      fs.readdir(tempDir, (err, files) => {
        if (err) {
          if (!res.headersSent) res.status(500).send('Error en disco temporal.');
          return;
        }

        const generatedFile = files.find(f => f.startsWith(fileId));
        if (!generatedFile) {
          if (!res.headersSent) res.status(500).send('Archivo no encontrado.');
          return;
        }

        const filePath = path.join(tempDir, generatedFile);
        const stats = fs.statSync(filePath);
        const fileExt = path.extname(generatedFile).replace('.', '') || (audioMode ? 'mp3' : 'mp4');
        const safeTitle = sanitizeFilename(title);
        const downloadFilename = `${safeTitle}.${fileExt}`;

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFilename)}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`);
        res.setHeader('Content-Type', audioMode ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Length', stats.size);

        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

        const cleanup = () => {
          fs.unlink(filePath, () => {});
        };

        res.on('finish', cleanup);
        res.on('close', cleanup);
        fileStream.on('error', () => cleanup());
      });
    });
  } catch (dlErr) {
    if (!res.headersSent) res.status(500).send('Fallo al iniciar el proceso.');
  }
};

// Rutas flexibles (POST y GET para descarga nativa inmediata)
app.post(['/info', '/api/info', '*/info'], handleInfo);
app.get(['/info', '/api/info', '*/info'], handleInfo);

app.post(['/download', '/api/download', '*/download'], handleDownload);
app.get(['/download', '/api/download', '*/download'], handleDownload);

// Exportar función Firebase
exports.api = functions.runWith({ timeoutSeconds: 300, memory: '1GB' }).https.onRequest(app);

// Iniciar servidor local
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor activo en http://localhost:${PORT}`);
  });
}
