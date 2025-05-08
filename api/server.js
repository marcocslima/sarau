// api/server.js
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();

// --- Configurações ---
// Na Vercel, o diretório gravável é /tmp. Os dados não serão persistentes entre deploys
// ou após a função serverless "esfriar", a menos que você use um armazenamento externo.
// Para CSVs que precisam ser persistentes, você precisaria de um banco de dados ou um serviço de storage (S3, etc.)
// Por simplicidade, vamos continuar usando o sistema de arquivos, mas ciente desta limitação na Vercel.
const IS_VERCEL = !!process.env.VERCEL_URL;
const UPLOAD_DIR_NAME = 'data_managed_by_api'; // Um nome de pasta
const UPLOAD_DIR = IS_VERCEL ? path.join('/tmp', UPLOAD_DIR_NAME) : path.join(__dirname, '..', UPLOAD_DIR_NAME);
const ARTISTS_LIST_FILE = path.join(UPLOAD_DIR, '_artists_list.csv');

// --- Middleware ---
app.use(cors()); // Permite requisições de qualquer origem (ajuste para produção se necessário)
app.use(express.json());

// --- Configuração do Multer para Upload ---
const ensureUploadDirExists = async () => {
    try {
        await fs.access(UPLOAD_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(UPLOAD_DIR, { recursive: true });
            console.log(`Diretório de dados/upload criado: ${UPLOAD_DIR}`);
             // Se for a primeira vez e o arquivo de lista não existe, crie-o com cabeçalho
            try {
                await fs.access(ARTISTS_LIST_FILE);
            } catch (listFileError) {
                if (listFileError.code === 'ENOENT') {
                    await fs.writeFile(ARTISTS_LIST_FILE, "artist_name\n", 'utf-8');
                    console.log(`Arquivo ${ARTISTS_LIST_FILE} inicializado.`);
                }
            }
        } else {
            throw error;
        }
    }
};

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        await ensureUploadDirExists();
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() !== '.csv') {
            return cb(new Error('Apenas arquivos .csv são permitidos!'), false);
        }
        cb(null, true);
    }
});

// --- Funções Auxiliares (parseCSV, updateArtistsList) ---
// Cole as funções parseCSV e updateArtistsList da resposta anterior aqui.
// Certifique-se que elas usam as constantes UPLOAD_DIR e ARTISTS_LIST_FILE corretas.
async function parseCSV(filePath, expectedHeaders = null) {
    try {
        await fs.access(filePath);
        const csvText = await fs.readFile(filePath, 'utf-8');
        const lines = csvText.trim().split('\n');
        if (lines.length === 0) return [];

        let headers;
        let dataStartIndex = 0;

        const firstLineValues = lines[0].split(',').map(h => h.trim());

        if (expectedHeaders && lines.length > 0 && expectedHeaders.every((eh, i) => eh === firstLineValues[i])) {
            headers = expectedHeaders;
            dataStartIndex = 1;
        } else if (lines.length > 0 && (firstLineValues.includes('song_name') || firstLineValues.includes('artist_name'))) { // Heurística
            headers = firstLineValues;
            dataStartIndex = 1;
        } else if (expectedHeaders) {
            headers = expectedHeaders;
            dataStartIndex = 0; // Assume que não há header no arquivo se não corresponder
        } else { // Sem headers esperados e sem heurística, adivinha pelo número de colunas
             if (firstLineValues.length === 2) headers = ['song_name', 'song_link']; // Default para músicas
             else if (firstLineValues.length === 1) headers = ['artist_name']; // Default para lista de artistas
             else return [];
             dataStartIndex = 0;
        }

        const data = [];
        for (let i = dataStartIndex; i < lines.length; i++) {
            if (lines[i].trim() === "") continue;
            const values = lines[i].split(',').map(v => v.trim());
            const entry = {};
            headers.forEach((header, index) => {
                entry[header] = values[index];
            });
            data.push(entry);
        }
        return data;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn(`Arquivo não encontrado ao parsear CSV: ${filePath}`);
            return [];
        }
        console.error(`Erro ao parsear CSV ${filePath}:`, error);
        throw error;
    }
}

async function updateArtistsList(newArtistName) {
    await ensureUploadDirExists();
    let artists = [];
    try {
        const existingArtistsData = await parseCSV(ARTISTS_LIST_FILE, ['artist_name']);
        artists = existingArtistsData.map(a => a.artist_name).filter(name => name && name.trim() !== ""); // Filtra vazios
    } catch (error) {
        console.warn("Não foi possível ler a lista de artistas existente, começando uma nova:", error.message);
    }

    if (newArtistName && newArtistName.trim() !== "" && !artists.includes(newArtistName)) {
        artists.push(newArtistName);
        artists.sort();
        const csvContent = "artist_name\n" + artists.join("\n");
        await fs.writeFile(ARTISTS_LIST_FILE, csvContent + "\n", 'utf-8'); // Adiciona newline no final
        console.log(`Artista "${newArtistName}" adicionado a ${ARTISTS_LIST_FILE}`);
    }
}


// --- Rotas da API ---
// GET: Listar todos os artistas
app.get('/api/artists', async (req, res) => {
    try {
        await ensureUploadDirExists(); // Garante que o diretório/arquivo exista
        const artistsData = await parseCSV(ARTISTS_LIST_FILE, ['artist_name']);
        const artistNames = artistsData.map(a => a.artist_name).filter(name => name && name.trim() !== "");
        res.json(artistNames);
    } catch (error) {
        console.error("Erro ao listar artistas:", error);
        res.status(500).send("Erro ao buscar lista de artistas.");
    }
});

// GET: Listar músicas de um artista
app.get('/api/artists/:artistName/songs', async (req, res) => {
    const artistName = req.params.artistName;
    if (!artistName || typeof artistName !== 'string' || artistName.includes('..')) {
        return res.status(400).send("Nome de artista inválido.");
    }
    const artistFilePath = path.join(UPLOAD_DIR, `${artistName}.csv`);
    try {
        await ensureUploadDirExists();
        const songsData = await parseCSV(artistFilePath, ['song_name', 'song_link']);
        res.json(songsData);
    } catch (error) {
        console.error(`Erro ao buscar músicas para ${artistName}:`, error);
        if (error.code === 'ENOENT') {
             return res.status(404).json({ message: `Arquivo de músicas para o artista ${artistName} não encontrado.` });
        }
        res.status(500).send(`Erro ao buscar músicas para ${artistName}.`);
    }
});

// POST: Upload de arquivo CSV de um artista
app.post('/api/upload/artist', upload.single('artistFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo foi enviado.'});
    }
    try {
        const artistName = path.basename(req.file.originalname, '.csv').trim();
        if (!artistName) {
            await fs.unlink(req.file.path);
            return res.status(400).json({ message: 'Nome de arquivo inválido para determinar o nome do artista.' });
        }
        await updateArtistsList(artistName);
        res.status(201).json({
            message: `Arquivo ${req.file.originalname} enviado com sucesso. Artista "${artistName}" adicionado/atualizado.`,
            artistName: artistName
        });
    } catch (error) {
        console.error("Erro no upload do artista:", error);
        if (req.file && req.file.path) {
            try { await fs.unlink(req.file.path); } catch (e) { console.error("Erro ao limpar arquivo:", e); }
        }
        res.status(500).json({ message: 'Erro ao processar o upload do artista.' });
    }
});


// Se não estiver na Vercel e quiser rodar localmente com `node api/server.js`
if (!IS_VERCEL) {
    const PORT = process.env.PORT || 3001;
    (async () => {
        await ensureUploadDirExists();
        app.listen(PORT, () => console.log(`Servidor local rodando na porta ${PORT}. Dados em ${UPLOAD_DIR}`));
    })();
}

// Exporta o app para a Vercel usar
module.exports = app;