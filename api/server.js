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
      `SELECT s.id, s.name, s.link FROM songs s 
             JOIN artists a ON s.artist_id = a.id
             WHERE a.name = $1
             ORDER BY s.name ASC`, // <<< MODIFICAÇÃO AQUI: Adicionado s.id
      [artistName]
    );
    // Agora result.rows será um array de objetos como: { id: 1, name: "Musica A", link: "..." }
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

// --- NOVAS ROTAS PARA PLAYLIST ---

// GET: Obter todos os itens da playlist
app.get('/api/playlist', async (req, res) => {
  try {
    const result = await pool.query(`
            SELECT pi.id, pi.user_name, pi.added_at,
                   s.name as song_name, s.link as song_link,
                   a.name as artist_name
            FROM playlist_items pi
            JOIN songs s ON pi.song_id = s.id
            JOIN artists a ON s.artist_id = a.id
            ORDER BY pi.added_at ASC; -- Ou DESC para mais recentes primeiro
        `);
    // Mapear para o formato que o frontend pode esperar (se necessário)
    // O frontend espera: { id (do playlist_item), userName, artistName, songName, link }
    const playlistData = result.rows.map(item => ({
      id: item.id, // Este é o ID do item na playlist, para exclusão
      userName: item.user_name,
      artistName: item.artist_name,
      songName: item.song_name,
      link: item.song_link,
      added_at: item.added_at // Opcional, se o frontend precisar
    }));
    res.json(playlistData);
  } catch (error) {
    console.error("Erro ao buscar playlist do DB:", error);
    res.status(500).json({ message: "Erro ao buscar playlist." });
  }
});

// POST: Adicionar música à playlist
app.post('/api/playlist/add', async (req, res) => {
  const { songName, artistName, userName, songLink } = req.body; // O frontend enviará esses dados

  if (!songName || !artistName || !userName || !songLink) {
    return res.status(400).json({ message: "Dados incompletos para adicionar à playlist." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Encontrar o ID do artista
    let artistRes = await client.query('SELECT id FROM artists WHERE name = $1', [artistName]);
    if (artistRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `Artista "${artistName}" não encontrado.` });
    }
    const artistId = artistRes.rows[0].id;

    // 2. Encontrar ou criar o ID da música (assumindo que a música já deve existir)
    // Ou, se o frontend envia o ID da música diretamente, melhor ainda.
    // Por agora, vamos assumir que a combinação artistaId + songName é única para encontrar a música.
    let songRes = await client.query('SELECT id FROM songs WHERE name = $1 AND artist_id = $2', [songName, artistId]);
    let songId;

    if (songRes.rows.length > 0) {
      songId = songRes.rows[0].id;
    } else {
      // Se a música não existe, podemos optar por criá-la ou retornar um erro.
      // Para este exemplo, vamos supor que ela já deveria existir (foi selecionada de uma lista).
      // Poderíamos também inserir a música aqui se ela não existir, usando o songLink.
      // Por simplicidade, vamos assumir que o frontend selecionou uma música existente.
      // Se o frontend puder enviar o songId diretamente, seria mais robusto.
      // Alternativa: se o frontend não tem o songId, mas tem name e link, e você quer criar se não existir:
      /*
      const newSongRes = await client.query(
          'INSERT INTO songs (artist_id, name, link) VALUES ($1, $2, $3) ON CONFLICT (artist_id, name) DO UPDATE SET link = EXCLUDED.link RETURNING id',
          [artistId, songName, songLink]
      );
      songId = newSongRes.rows[0].id;
      */
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `Música "${songName}" do artista "${artistName}" não encontrada no catálogo. O frontend deveria enviar um songId existente.` });
    }

    // 3. Adicionar à tabela playlist_items
    const result = await client.query(
      'INSERT INTO playlist_items (song_id, user_name) VALUES ($1, $2) RETURNING id, added_at',
      [songId, userName]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: "Música adicionada à playlist com sucesso!",
      playlistItem: {
        id: result.rows[0].id, // ID do item na playlist
        userName: userName,
        artistName: artistName,
        songName: songName,
        link: songLink,
        added_at: result.rows[0].added_at
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erro ao adicionar música à playlist no DB:", error);
    res.status(500).json({ message: "Erro ao adicionar música à playlist." });
  } finally {
    client.release();
  }
});

// DELETE: Remover um item específico da playlist
app.delete('/api/playlist/remove/:playlistItemId', async (req, res) => {
  const { playlistItemId } = req.params;
  if (!playlistItemId || isNaN(parseInt(playlistItemId))) {
    return res.status(400).json({ message: "ID do item da playlist inválido." });
  }

  try {
    const result = await pool.query('DELETE FROM playlist_items WHERE id = $1 RETURNING id', [playlistItemId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Item não encontrado na playlist." });
    }
    res.status(200).json({ message: "Música removida da playlist com sucesso.", id: playlistItemId });
  } catch (error) {
    console.error("Erro ao remover música da playlist no DB:", error);
    res.status(500).json({ message: "Erro ao remover música da playlist." });
  }
});

// DELETE: Limpar toda a playlist
app.delete('/api/playlist/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM playlist_items'); // Ou TRUNCATE TABLE playlist_items;
    res.status(200).json({ message: "Playlist limpa com sucesso!" });
  } catch (error) {
    console.error("Erro ao limpar playlist no DB:", error);
    res.status(500).json({ message: "Erro ao limpar a playlist." });
  }
});

// Exporta o app para a Vercel usar
// Se você quiser rodar localmente com `node api/server.js` (sem `vercel dev`):
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL_URL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor local (API) rodando na porta ${PORT}`));
}

module.exports = app;