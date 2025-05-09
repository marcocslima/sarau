// api/server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg'); // Driver do PostgreSQL
require('dotenv').config(); // Para carregar variáveis do .env em desenvolvimento

const app = express();

// --- Configuração do Pool de Conexão com o PostgreSQL ---
// A Vercel injeta automaticamente as variáveis de ambiente para o banco de dados.
// Para desenvolvimento local, elas virão do .env
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL, // Usado pela Vercel e pelo dotenv
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // Necessário para conexões SSL (comum em produção)
});

// Teste de conexão (opcional, mas bom para depuração)
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Erro ao adquirir cliente do pool de conexão', err.stack);
    }
    client.query('SELECT NOW()', (err, result) => {
        release(); // Libera o cliente de volta ao pool
        if (err) {
            return console.error('Erro ao executar query de teste', err.stack);
        }
        console.log('Conectado ao PostgreSQL! Hora atual do banco:', result.rows[0].now);
    });
});


// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Configuração do Multer para Upload (em memória, pois vamos processar e inserir no DB) ---
const storage = multer.memoryStorage(); // Armazena o arquivo na memória como um Buffer
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'text/csv' && path.extname(file.originalname).toLowerCase() !== '.csv') {
            return cb(new Error('Apenas arquivos .csv são permitidos!'), false);
        }
        cb(null, true);
    }
});

// --- Funções Auxiliares de Banco de Dados ---

// Parseia o conteúdo do CSV (recebe um Buffer ou string)
function parseCSVContent(csvContentString, expectedHeaders = null) {
    const lines = csvContentString.trim().split(/\r?\n/); // Lida com \n e \r\n
    if (lines.length === 0) return [];

    let headers;
    let dataStartIndex = 0;
    const firstLineValues = lines[0].split(',').map(h => h.trim());

    if (expectedHeaders && lines.length > 0 && expectedHeaders.every((eh, i) => eh === firstLineValues[i])) {
        headers = expectedHeaders;
        dataStartIndex = 1;
    } else if (lines.length > 0 && (firstLineValues.includes('song_name') || firstLineValues.includes('artist_name'))) {
        headers = firstLineValues;
        dataStartIndex = 1;
    } else if (expectedHeaders) {
        headers = expectedHeaders;
        dataStartIndex = 0;
    } else {
         if (firstLineValues.length === 2) headers = ['song_name', 'song_link'];
         else if (firstLineValues.length === 1) headers = ['artist_name'];
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
}


// --- Rotas da API ---

// GET: Listar todos os artistas
app.get('/api/artists', async (req, res) => {
    try {
        const result = await pool.query('SELECT name FROM artists ORDER BY name ASC');
        res.json(result.rows.map(row => row.name));
    } catch (error) {
        console.error("Erro ao listar artistas do DB:", error);
        res.status(500).json({ message: "Erro ao buscar lista de artistas." });
    }
});

// GET: Listar músicas de um artista
app.get('/api/artists/:artistName/songs', async (req, res) => {
    const artistName = req.params.artistName;
    console.log(`Buscando músicas para o artista: "${artistName}"`);

    try {
        const result = await pool.query(
            `SELECT s.name, s.link FROM songs s
             JOIN artists a ON s.artist_id = a.id
             WHERE a.name = $1
             ORDER BY s.name ASC`,
            [artistName]
        );
        console.log(`Músicas encontradas para "${artistName}":`, result.rows);

        if (result.rows.length === 0) {
            console.log(`Nenhuma música encontrada no DB para "${artistName}" com a query.`);
        }
        res.json(result.rows);
    } catch (error) {
        console.error(`Erro ao buscar músicas para ${artistName} do DB:`, error);
        res.status(500).json({ message: `Erro ao buscar músicas para ${artistName}.` });
    }
});

// POST: Upload de arquivo CSV de um artista e suas músicas
app.post('/api/upload/artist', upload.single('artistFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Nenhum arquivo foi enviado.' });
    }

    const client = await pool.connect(); // Pega uma conexão do pool
    try {
        const artistNameFromFile = path.basename(req.file.originalname, '.csv').trim();
        if (!artistNameFromFile) {
            return res.status(400).json({ message: 'Nome de arquivo inválido para determinar o nome do artista.' });
        }

        const csvContentString = req.file.buffer.toString('utf-8');
        const songsFromCSV = parseCSVContent(csvContentString, ['song_name', 'song_link']);

        if (songsFromCSV.length === 0) {
            return res.status(400).json({ message: 'CSV vazio ou em formato inválido (esperado: song_name,song_link).' });
        }

        await client.query('BEGIN'); // Inicia uma transação

        // 1. Encontrar ou criar o artista
        let artistResult = await client.query('SELECT id FROM artists WHERE name = $1', [artistNameFromFile]);
        let artistId;

        if (artistResult.rows.length > 0) {
            artistId = artistResult.rows[0].id;
            // Opcional: Excluir músicas antigas deste artista se for um re-upload completo
            // await client.query('DELETE FROM songs WHERE artist_id = $1', [artistId]);
            // console.log(`Músicas antigas do artista ${artistNameFromFile} (ID: ${artistId}) excluídas para re-upload.`);
        } else {
            artistResult = await client.query(
                'INSERT INTO artists (name) VALUES ($1) RETURNING id',
                [artistNameFromFile]
            );
            artistId = artistResult.rows[0].id;
        }

        // 2. Inserir as músicas, lidando com duplicatas (nome da música para o mesmo artista)
        let songsAddedCount = 0;
        for (const song of songsFromCSV) {
            if (song.song_name && song.link) {
                try {
                    // Tenta inserir. Se a constraint UNIQUE (artist_id, name) falhar, ignora.
                    // ON CONFLICT (artist_id, name) DO NOTHING; -- ou DO UPDATE SET link = EXCLUDED.link;
                    await client.query(
                        `INSERT INTO songs (artist_id, name, link) VALUES ($1, $2, $3)
                         ON CONFLICT (artist_id, name) DO UPDATE SET link = EXCLUDED.link`,
                        [artistId, song.song_name, song.link]
                    );
                    songsAddedCount++;
                } catch (insertError) {
                    // Se não for um erro de violação de constraint UNIQUE, ou se você não usar ON CONFLICT
                    console.error(`Erro ao inserir música "${song.song_name}":`, insertError.message);
                    // Você pode decidir se quer continuar ou abortar a transação
                }
            }
        }

        await client.query('COMMIT'); // Finaliza a transação

        res.status(201).json({
            message: `Artista "${artistNameFromFile}" processado. ${songsAddedCount} músicas adicionadas/atualizadas.`,
            artistName: artistNameFromFile
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Desfaz a transação em caso de erro
        console.error("Erro no processamento do upload do artista e inserção no DB:", error);
        res.status(500).json({ message: 'Erro ao processar o upload e salvar no banco de dados.' });
    } finally {
        client.release(); // Libera a conexão de volta ao pool
    }
});


// Exporta o app para a Vercel usar
// Se você quiser rodar localmente com `node api/server.js` (sem `vercel dev`):
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL_URL) {
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`Servidor local (API) rodando na porta ${PORT}`));
}

module.exports = app;