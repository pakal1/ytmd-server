const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActivityType
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection
} = require('@discordjs/voice');
const play = require('play-dl');

// ─── Supabase config ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'ylreexdonwpsyaqzdqah.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XEWgsWQMZVAVZ4BOBvLPGQ_4SlLuT-U';

// ─── Discord config ───────────────────────────────────────────────────────────
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1550408318374252636';
const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID  || '1534579090433245235';

// ─── Supabase tier check ──────────────────────────────────────────────────────
function fetchUserTier(userId) {
  return new Promise((resolve) => {
    if (!userId || typeof userId !== 'string' || userId.length > 64) return resolve('free');
    const path = `/rest/v1/profiles?select=subscription_tier&id=eq.${encodeURIComponent(userId)}&limit=1`;
    const options = {
      hostname: SUPABASE_URL, path, method: 'GET',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Accept': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)?.[0]?.subscription_tier || 'free'); }
        catch (_) { resolve('free'); }
      });
    });
    req.on('error', () => resolve('free'));
    req.setTimeout(3000, () => { req.destroy(); resolve('free'); });
    req.end();
  });
}

// ─── Express + HTTP + Socket.io ───────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

const PORT             = process.env.PORT || 3001;
const MAX_ROOMS        = 50;
const MAX_ROOM_MEMBERS = 10;
const ROOM_TTL_MS      = 4 * 60 * 60 * 1000;
const RATE_LIMIT_MS    = 200;

const rateLimits = new Map();
const rooms      = new Map(); // ListenTogether Rooms

// Auto-actualizar yt-dlp al iniciar para garantizar compatibilidad con YouTube
(async () => {
  try {
    const { execFile } = require('child_process');
    const ytdlpBin = require.resolve('youtube-dl-exec/bin/yt-dlp');
    await new Promise((resolve) => execFile(ytdlpBin, ['--update'], (err, stdout) => {
      if (stdout) console.log('[yt-dlp update]', stdout.trim());
      resolve();
    }));
  } catch (e) {
    console.error('[yt-dlp update] No se pudo actualizar:', e.message);
  }
})();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function isValidState(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.videoId !== 'string' || state.videoId.length > 20) return false;
  if (typeof state.currentTime !== 'number') return false;
  if (typeof state.paused !== 'boolean') return false;
  return true;
}

// Limpiar salas expiradas
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 30 * 60 * 1000);

// ─── Logger Intercept for Remote Debugging ─────────────────────────────────────
const serverLogs = [];
const originalLog = console.log;
const originalError = console.error;
function interceptLog(level, args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  serverLogs.push(`[${new Date().toISOString()}] [${level}] ${msg}`);
  if (serverLogs.length > 100) serverLogs.shift();
}
console.log = function(...args) { interceptLog('INFO', args); originalLog.apply(console, args); };
console.error = function(...args) { interceptLog('ERROR', args); originalError.apply(console, args); };

app.get('/logs', (_req, res) => {
  res.send(`<pre style="background:#0f0f0f;color:#22c55e;padding:10px;">${serverLogs.join('\n')}</pre>`);
});

app.get('/health', (_req, res) => {
  const { generateDependencyReport } = require('@discordjs/voice');
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime(), botOnline: !!discordClient?.isReady(), deps: generateDependencyReport() });
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Discord Voice Player State ───────────────────────────────────────────────
let queue = [];
let currentSong = null;
let isPlaying = false;
let voiceConnection = null;
let cookiesFilePath = null;
let currentAudioPassthrough = null; // PassThrough stream fed by Electron client chunks

function saveCookiesToFile(cookiesArray) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookiesArray) {
    if (!c.name || !c.value) continue;
    const domain = c.domain || '.youtube.com';
    const subdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    // If expirationDate is 0 or missing, yt-dlp expects 0
    const expires = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push(`${domain}\t${subdomains}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
  }
  const tmpPath = path.join(os.tmpdir(), 'yt_cookies.txt');
  fs.writeFileSync(tmpPath, lines.join('\n'));
  return tmpPath;
}
const audioPlayer = createAudioPlayer();

// Broadcast bot state to all connected dashboard apps
function broadcastBotState() {
  io.emit('bot-state-update', {
    isPlaying,
    currentSong,
    queue: queue.map(s => ({ title: s.title, duration: s.duration, thumbnail: s.thumbnail }))
  });
}

audioPlayer.on(AudioPlayerStatus.Idle, () => {
  playNext();
});

async function playNext() {
  if (queue.length === 0) {
    isPlaying = false;
    currentSong = null;
    broadcastBotState();
    return;
  }
  
  currentSong = queue.shift();
  isPlaying = true;
  broadcastBotState();

  try {
    const { PassThrough } = require('stream');
    if (currentAudioPassthrough && !currentAudioPassthrough.destroyed) {
      currentAudioPassthrough.destroy();
    }
    currentAudioPassthrough = new PassThrough();
    
    console.log(`[Bot Voice] Solicitando stream local para: ${currentSong.url}`);
    
    // Esperar el primer chunk ANTES de pasar el stream a Discord
    // (si no, ffmpeg empieza con buffer vacío y da TimeoutNegativeWarning)
    await new Promise((resolve) => {
      const onFirstData = () => {
        console.log('[Bot Voice] Primer chunk recibido — iniciando player');
        resolve();
      };
      currentAudioPassthrough.once('data', onFirstData);
      
      // Timeout de seguridad: si en 8s no llega nada, intentar igual
      const fallback = setTimeout(() => {
        currentAudioPassthrough.removeListener('data', onFirstData);
        console.warn('[Bot Voice] Timeout esperando primer chunk — iniciando sin datos');
        resolve();
      }, 8000);
      
      // Limpiar timeout si llega el primer dato
      currentAudioPassthrough.once('data', () => clearTimeout(fallback));
      
      io.emit('bot-stream-request', { url: currentSong.url });
    });
    
    const { StreamType } = require('@discordjs/voice');
    // IMPORTANTE: Usar Arbitrary (FFmpeg) en lugar de WebmOpus.
    // El demuxer WebmOpus de discord.js no soporta datos llegando en "push"
    // desde socket (se traba después del primer frame). FFmpeg actúa como
    // buffer inteligente y decodifica correctamente sin importar el timing.
    const resource = createAudioResource(currentAudioPassthrough, { inputType: StreamType.Arbitrary });
    audioPlayer.play(resource);
    console.log(`[Bot Voice] Reproduciendo: ${currentSong.title} (FFmpeg/Arbitrary)`);
  } catch (err) {
    console.error('[Bot Voice] Error al reproducir:', err.message);
    playNext();
  }
}

async function ensureVoiceConnection(memberVoiceChannel) {
  if (voiceConnection && voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) return true;
  
  let targetChannel = memberVoiceChannel;

  // Si no se proveyó canal, intentar encontrar uno ocupado en el server
  if (!targetChannel) {
    const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
    if (!guild) return false;
    for (const [_, channel] of guild.channels.cache) {
       if (channel.isVoiceBased() && channel.members.size > 0) {
          targetChannel = channel;
          break;
       }
    }
  }
  
  if (!targetChannel) return false;
  
  try {
    console.log(`[Bot Voice] Intentando unir al canal: ${targetChannel.name} (ID: ${targetChannel.id})`);
    voiceConnection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: targetChannel.guild.id,
        adapterCreator: targetChannel.guild.voiceAdapterCreator
    });
    voiceConnection.subscribe(audioPlayer);
    
    voiceConnection.on(VoiceConnectionStatus.Ready, () => {
      console.log('[Bot Voice] Conexión de voz establecida (Ready)');
    });

    voiceConnection.on('error', (err) => {
      console.error('[Bot Voice] Error en la conexión UDP:', err.message);
    });
    
    voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
      console.log('[Bot Voice] Desconectado del canal de voz');
      voiceConnection.destroy();
      voiceConnection = null;
      isPlaying = false;
      currentSong = null;
      queue = [];
      broadcastBotState();
    });
    return true;
  } catch (err) {
    console.error('[Bot Voice] Error uniendo canal de voz:', err);
    return false;
  }
}

async function searchAndAdd(query, user) {
  try {
    console.log(`[Bot Voice] Delegando búsqueda al cliente local: ${query}`);
    const sockets = await io.fetchSockets();
    if (sockets.length === 0) {
      return { error: 'No hay ninguna app de YMusic conectada para buscar. Abrí la app en tu PC.' };
    }
    
    // Preguntar a TODOS los sockets conectados simultáneamente (por si hay conexiones zombies o múltiples pestañas)
    const promises = sockets.map(clientSocket => 
      clientSocket.timeout(15000).emitWithAck('bot-search-request', query).then(res => {
        if (res && res.error) throw new Error(res.error);
        if (!res || !res.title) throw new Error("Respuesta inválida");
        return res;
      })
    );

    let result;
    try {
      // El primero que responda correctamente gana
      result = await Promise.any(promises);
    } catch (e) {
      return { error: 'Timeout: Ninguna app local conectada logró encontrar la canción a tiempo.' };
    }
    
    const song = {
      title: result.title,
      url: result.url,
      thumbnail: result.thumbnail,
      duration: result.duration,
      user
    };
    
    queue.push(song);
    if (!isPlaying) {
      await playNext();
    } else {
      broadcastBotState();
    }
    
    return { song };
  } catch (err) {
    console.error('[Bot Voice] Error en searchAndAdd delegada:', err);
    return { error: 'Error interno conectando con la app local para buscar.' };
  }
}

// ─── Discord Client ───────────────────────────────────────────────────────────
let discordClient = null;

const slashCommands = [
  new SlashCommandBuilder().setName('play').setDescription('Reproduce una canción')
    .addStringOption(o => o.setName('busqueda').setDescription('Nombre o URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Salta la canción actual'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproducción'),
  new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola de reproducción'),
  new SlashCommandBuilder().setName('leave').setDescription('Desconecta al bot del canal de voz')
];

async function registerSlashCommands() {
  if (!DISCORD_TOKEN) return console.error('[Bot] ❌ No hay DISCORD_TOKEN en env.');
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
      body: slashCommands.map(c => c.toJSON())
    });
    console.log('[Bot] ✅ Slash commands de Voz registrados');
  } catch (err) {
    console.error('[Bot] ❌ Error registrando commands:', err.message);
  }
}

function initDiscordBot() {
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

  discordClient.once('ready', () => {
    console.log(`[Bot] ✅ Online como ${discordClient.user.tag} (Modo Servidor de Voz)`);
    discordClient.user.setActivity('YouTube Music', { type: ActivityType.Listening });
    registerSlashCommands();
  });

  discordClient.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const cmd = interaction.commandName;

    if (cmd === 'play') {
      const query = interaction.options.getString('busqueda');
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) return interaction.editReply('❌ Tenés que estar en un canal de voz.');
      
      const joined = await ensureVoiceConnection(voiceChannel);
      if (!joined) return interaction.editReply('❌ No pude unirme al canal de voz.');
      
      const res = await searchAndAdd(query, interaction.user.tag);
      if (res.error) return interaction.editReply(`❌ ${res.error}`);
      
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🎵 Agregado a la cola')
        .setDescription(`**${res.song.title}**`)
        .setThumbnail(res.song.thumbnail);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === 'skip') {
      if (!isPlaying) return interaction.editReply('❌ No hay nada sonando.');
      audioPlayer.stop(); // Dispara Idle -> playNext()
      return interaction.editReply('⏭️ Canción saltada.');
    }

    if (cmd === 'pause') {
      if (!isPlaying) return interaction.editReply('❌ No hay nada sonando.');
      audioPlayer.pause();
      return interaction.editReply('⏸️ Pausado.');
    }

    if (cmd === 'resume') {
      if (audioPlayer.state.status !== AudioPlayerStatus.Paused) return interaction.editReply('❌ El bot no está pausado.');
      audioPlayer.unpause();
      return interaction.editReply('▶️ Reanudado.');
    }
    
    if (cmd === 'leave') {
       if (voiceConnection) {
           voiceConnection.destroy();
           voiceConnection = null;
           isPlaying = false;
           currentSong = null;
           queue = [];
           broadcastBotState();
           return interaction.editReply('👋 Desconectado.');
       }
       return interaction.editReply('❌ No estoy en un canal de voz.');
    }

    if (cmd === 'queue') {
      if (!currentSong) return interaction.editReply('La cola está vacía.');
      let desc = `**Sonando ahora:**\n${currentSong.title}\n\n**En cola:**\n`;
      if (queue.length === 0) desc += '*Ninguna*';
      else queue.forEach((s, i) => desc += `${i + 1}. ${s.title}\n`);
      const embed = new EmbedBuilder().setColor(0x60a5fa).setTitle('📋 Cola de Reproducción').setDescription(desc);
      return interaction.editReply({ embeds: [embed] });
    }
  });

  if (DISCORD_TOKEN) discordClient.login(DISCORD_TOKEN).catch(e => console.error('[Bot] Login fallido:', e));
}

initDiscordBot();

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Server] Socket connected: ${socket.id}`);
  
  // Enviar estado inicial del bot al conectarse la app
  socket.emit('bot-state-update', { isPlaying, currentSong, queue: queue.map(s => ({ title: s.title, duration: s.duration, thumbnail: s.thumbnail })) });

  // Comandos de voz que llegan desde el dashboard de la app local
  socket.on('bot-sync-cookies', (cookiesData) => {
    try {
      cookiesFilePath = saveCookiesToFile(Array.isArray(cookiesData) ? cookiesData : []);
      console.log(`[Bot] Cookies guardadas en archivo: ${cookiesFilePath}`);
    } catch (e) {
      console.error('[Bot] Error guardando cookies:', e);
    }
  });

  // ─── Streaming de audio desde la app Electron (IP residencial) ─────────────
  let _chunkCount = 0;
  socket.on('bot-audio-chunk', (chunk) => {
    _chunkCount++;
    if (_chunkCount === 1) console.log('[Bot Voice] ✅ Primer chunk de audio recibido desde cliente');
    if (_chunkCount % 50 === 0) console.log(`[Bot Voice] Chunks recibidos: ${_chunkCount}`);
    if (currentAudioPassthrough && !currentAudioPassthrough.destroyed) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Backpressure: si el PassThrough tiene demasiado buffereado, lo descartamos
      // para evitar saturar FFmpeg (que procesa a ritmo de Discord, ~50 frames/s)
      if (currentAudioPassthrough.writableLength < 256 * 1024) {
        currentAudioPassthrough.write(buf);
      }
    }
  });

  socket.on('bot-audio-end', () => {
    if (currentAudioPassthrough && !currentAudioPassthrough.destroyed) {
      currentAudioPassthrough.end();
    }
  });

  socket.on('bot-audio-error', (errMsg) => {
    console.error('[Bot Voice] Error de stream desde cliente:', errMsg);
    if (currentAudioPassthrough && !currentAudioPassthrough.destroyed) {
      currentAudioPassthrough.destroy(new Error(errMsg));
    }
    // Intentar siguiente canción
    setTimeout(() => playNext(), 500);
  });

  socket.on('bot-action-play', async (query) => {
    const joined = await ensureVoiceConnection(null);
    if (!joined) return socket.emit('bot-error', 'El bot no pudo encontrar un canal de voz. Entrá a uno en Discord primero.');
    const res = await searchAndAdd(query, 'App YTMD');
    if (res.error) socket.emit('bot-error', res.error);
  });
  
  socket.on('bot-action-skip', () => { if (isPlaying) audioPlayer.stop(); });
  socket.on('bot-action-pause', () => { audioPlayer.pause(); });
  socket.on('bot-action-resume', () => { audioPlayer.unpause(); });
  socket.on('bot-action-leave', () => {
    if (voiceConnection) {
       voiceConnection.destroy();
       voiceConnection = null;
       isPlaying = false;
       currentSong = null;
       queue = [];
       broadcastBotState();
    }
  });


  // ── ListenTogether Protocol ───────────────────────────────────────────────
  socket.on('create-room', async (displayName, userId, cb) => {
    if (typeof cb !== 'function') return;
    const tier = await fetchUserTier(userId);
    if (rooms.size >= MAX_ROOMS) return cb({ error: 'Servidor lleno.' });

    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    rooms.set(code, { host: socket.id, tier: tier || 'free', members: new Set([socket.id]), lastActivity: Date.now() });

    socket.join(code);
    socket.data = { roomCode: code, isHost: true, displayName: displayName || 'Host' };
    cb({ code });
  });

  socket.on('join-room', (code, displayName, cb) => {
    if (typeof cb !== 'function' || !code) return;
    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ error: 'Sala no encontrada.' });

    const max = room.tier === 'pro' ? MAX_ROOM_MEMBERS : 3;
    if (room.members.size >= max) return cb({ error: 'Sala llena.' });

    room.members.add(socket.id);
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socket.data = { roomCode: code.toUpperCase(), isHost: false, displayName: displayName || 'Oyente' };

    socket.to(code.toUpperCase()).emit('member-joined', { id: socket.id, name: socket.data.displayName, count: room.members.size });
    cb({ success: true, memberCount: room.members.size });
  });

  socket.on('state-update', (state) => {
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id || !isValidState(state)) return;

    const now = Date.now();
    if (now - (rateLimits.get(socket.id) || 0) < RATE_LIMIT_MS) return;
    rateLimits.set(socket.id, now);
    room.lastActivity = now;

    socket.to(code).emit('state-update', state);
  });

  socket.on('disconnect', () => {
    rateLimits.delete(socket.id);
    const code = socket.data?.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.members.delete(socket.id);
    if (room.members.size === 0) {
      rooms.delete(code);
    } else if (room.host === socket.id) {
      const newHost = [...room.members][0];
      room.host = newHost;
      io.to(newHost).emit('promoted-to-host');
      io.to(code).emit('host-changed', { newHostId: newHost });
    } else {
      io.to(code).emit('member-left', { id: socket.id, count: room.members.size });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[YTMD Server] Corriendo en http://localhost:${PORT}`);
});
