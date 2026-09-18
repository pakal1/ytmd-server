const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const https = require('https');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActivityType
} = require('discord.js');

// ─── Supabase config ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'ylreexdonwpsyaqzdqah.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XEWgsWQMZVAVZ4BOBvLPGQ_4SlLuT-U';

// ─── Discord config (valores desde env vars de Render — nunca hardcodeados) ───
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1550408318374252636';
const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID  || '1534579090433245235';
const BOT_SECRET        = process.env.BOT_SECRET        || 'ytmd-private-2024';

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
const ROOM_TTL_MS      = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_MS    = 200;

const rateLimits = new Map();
const rooms      = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin O,0,1,I
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function isValidState(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.videoId !== 'string' || state.videoId.length > 20) return false;
  if (typeof state.currentTime !== 'number' || state.currentTime < 0 || state.currentTime > 86400) return false;
  if (typeof state.paused !== 'boolean') return false;
  if (state.title && typeof state.title !== 'string') return false;
  if (state.title && state.title.length > 200) return false;
  return true;
}

// Limpiar salas expiradas cada 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      console.log(`[Server] Cleaning up expired room ${code}`);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: process.uptime(),
    botOnline: !!discordClient?.isReady(),
    appConnected: !!controllerSocket?.connected
  });
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2 * 1024
});

// ─── Discord Bot ──────────────────────────────────────────────────────────────
let controllerSocket = null; // socket del plugin DiscordBot.js en la app Electron
let discordClient    = null;
const pendingCmds    = new Map(); // commandId → interaction pendiente

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function buildProgressBar(current, total) {
  if (!total || isNaN(total)) return '▬▬▬▬▬▬▬▬▬▬';
  const pct    = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(pct * 10);
  return '█'.repeat(filled) + '▬'.repeat(10 - filled);
}

function buildNowPlayingEmbed(data) {
  const bar = buildProgressBar(data.currentTime, data.duration);
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(data.paused ? '⏸ Pausado' : '🎵 Reproduciendo ahora')
    .setDescription(`**${data.title || 'Sin título'}**\n${data.artist || ''}`)
    .setThumbnail(data.thumbnail || null)
    .addFields({ name: 'Progreso', value: `${bar}\n\`${formatTime(data.currentTime)} / ${formatTime(data.duration)}\`` })
    .setFooter({ text: 'YTMD Bot' });
}

const slashCommands = [
  new SlashCommandBuilder().setName('now-playing').setDescription('Muestra la canción que está sonando'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproducción'),
  new SlashCommandBuilder().setName('skip').setDescription('Salta a la siguiente canción'),
  new SlashCommandBuilder().setName('volume')
    .setDescription('Cambia el volumen')
    .addIntegerOption(o => o.setName('nivel').setDescription('Volumen de 0 a 100').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('play')
    .setDescription('Reproduce una canción')
    .addStringOption(o => o.setName('busqueda').setDescription('Nombre de la canción o artista').setRequired(true)),
  new SlashCommandBuilder().setName('together').setDescription('Crea una sala de Listen Together y pone el código acá'),
  new SlashCommandBuilder().setName('status').setDescription('Estado del bot y la app'),
];

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
      body: slashCommands.map(c => c.toJSON())
    });
    console.log('[Bot] ✅ Slash commands registrados');
  } catch (err) {
    console.error('[Bot] ❌ Error registrando commands:', err.message);
  }
}

function sendBotCommand(interaction, type, extra = {}) {
  if (!controllerSocket?.connected) {
    return interaction.editReply({ content: '❌ La app de YouTube Music no está conectada al bot.' });
  }
  const commandId = Math.random().toString(36).slice(2, 10);
  pendingCmds.set(commandId, interaction);

  controllerSocket.emit('bot-command', { commandId, type, ...extra });

  // Timeout de 12s si la app no responde
  setTimeout(() => {
    if (pendingCmds.has(commandId)) {
      pendingCmds.delete(commandId);
      interaction.editReply({ content: '⏱️ La app no respondió a tiempo.' }).catch(() => {});
    }
  }, 12000);
}

function initDiscordBot() {
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

  discordClient.once('ready', () => {
    console.log(`[Bot] ✅ Online como ${discordClient.user.tag}`);
    discordClient.user.setActivity('YouTube Music', { type: ActivityType.Listening });
    registerSlashCommands();
  });

  discordClient.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const cmd = interaction.commandName;

    // /status no necesita la app conectada
    if (cmd === 'status') {
      const appOnline = !!controllerSocket?.connected;
      const embed = new EmbedBuilder()
        .setColor(appOnline ? 0x22c55e : 0xff4444)
        .setTitle('📊 Estado del YTMD Bot')
        .addFields(
          { name: '🤖 Bot',         value: '✅ Online',                                   inline: true },
          { name: '🖥️ App',         value: appOnline ? '✅ Conectada' : '❌ Desconectada', inline: true },
          { name: '🎵 Salas activas', value: `${rooms.size}`,                              inline: true }
        )
        .setFooter({ text: 'YTMD Bot' });
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === 'now-playing') return sendBotCommand(interaction, 'now-playing');
    if (cmd === 'pause')       return sendBotCommand(interaction, 'pause');
    if (cmd === 'resume')      return sendBotCommand(interaction, 'resume');
    if (cmd === 'skip')        return sendBotCommand(interaction, 'skip');
    if (cmd === 'together')    return sendBotCommand(interaction, 'together');
    if (cmd === 'volume')      return sendBotCommand(interaction, 'volume', { level: interaction.options.getInteger('nivel') });
    if (cmd === 'play')        return sendBotCommand(interaction, 'play',   { query: interaction.options.getString('busqueda') });
  });

  discordClient.login(DISCORD_TOKEN).catch(err => {
    console.error('[Bot] ❌ Login fallido:', err.message);
  });
}

initDiscordBot();

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Server] Connected: ${socket.id}`);

  // ── BOT CONTROLLER: el plugin DiscordBot.js se identifica acá ────────────
  socket.on('bot-identify', (secret) => {
    if (secret === BOT_SECRET) {
      controllerSocket = socket;
      console.log(`[Bot] 🎮 App controller conectada: ${socket.id}`);
      socket.emit('bot-identify-ack', { ok: true });
    }
  });

  // ── BOT RESULT: la app ejecutó el comando y devuelve el resultado ─────────
  socket.on('bot-result', (result) => {
    const interaction = pendingCmds.get(result.commandId);
    if (!interaction) return;
    pendingCmds.delete(result.commandId);

    if (result.error) {
      return interaction.editReply({ content: `❌ ${result.error}` }).catch(() => {});
    }

    let embed;
    switch (result.type) {
      case 'now-playing':
        embed = buildNowPlayingEmbed(result.data);
        break;
      case 'pause':
        embed = new EmbedBuilder().setColor(0xfbbf24).setTitle('⏸ Pausado').setDescription(`**${result.data?.title || ''}**`);
        break;
      case 'resume':
        embed = new EmbedBuilder().setColor(0x22c55e).setTitle('▶️ Reanudando').setDescription(`**${result.data?.title || ''}**`);
        break;
      case 'skip':
        embed = new EmbedBuilder().setColor(0x60a5fa).setTitle('⏭ Saltando canción').setDescription(result.data?.title ? `Siguiente: **${result.data.title}**` : '');
        break;
      case 'volume':
        embed = new EmbedBuilder().setColor(0xa78bfa).setTitle(`🔊 Volumen: ${result.data?.level}%`);
        break;
      case 'play':
        embed = new EmbedBuilder().setColor(0x22c55e).setTitle('▶️ Reproduciendo').setDescription(`**${result.data?.title || result.data?.query || ''}**`).setThumbnail(result.data?.thumbnail || null);
        break;
      case 'together':
        embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('🎵 Sala de Listen Together creada')
          .setDescription(`Código: \`${result.data?.code}\`\nUsá este código en la app para unirte.`);
        break;
      default:
        embed = new EmbedBuilder().setColor(0x22c55e).setTitle('✅ Listo');
    }

    interaction.editReply({ embeds: [embed] }).catch(() => {});
  });

  // ── CREATE ROOM ───────────────────────────────────────────────────────────
  socket.on('create-room', async (displayName, userId, cb) => {
    if (typeof displayName === 'function') { cb = displayName; displayName = 'Host'; userId = null; }
    if (typeof userId === 'function') { cb = userId; userId = null; }
    if (typeof cb !== 'function') return;

    const tier = await fetchUserTier(userId);

    if (rooms.size >= MAX_ROOMS) return cb({ error: 'El servidor está al límite de salas activas. Intentá de nuevo más tarde.' });

    let code, attempts = 0;
    do { code = generateRoomCode(); attempts++; } while (rooms.has(code) && attempts < 10);
    if (rooms.has(code)) return cb({ error: 'No se pudo generar un código único. Intentá de nuevo.' });

    rooms.set(code, {
      host: socket.id,
      tier: tier || 'free',
      members: new Set([socket.id]),
      lastActivity: Date.now(),
      createdAt: Date.now()
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;
    socket.data.displayName = typeof displayName === 'string' ? displayName.slice(0, 30) : 'Host';

    console.log(`[Server] Room created: ${code} by ${socket.id}`);
    cb({ code });
  });

  // ── JOIN ROOM ─────────────────────────────────────────────────────────────
  socket.on('join-room', (code, displayName, cb) => {
    if (typeof cb !== 'function') return;
    if (typeof code !== 'string' || code.length !== 8) return cb({ error: 'Código inválido.' });

    const room = rooms.get(code.toUpperCase());
    if (!room) return cb({ error: 'Sala no encontrada. Verificá el código.' });

    const maxMembers = room.tier === 'pro' ? MAX_ROOM_MEMBERS : 3;
    if (room.members.size >= maxMembers) {
      return cb({ error: room.tier === 'free' ? 'La sala está llena (máximo 3 personas en plan Free).' : `La sala está llena (máximo ${MAX_ROOM_MEMBERS} personas).` });
    }

    room.members.add(socket.id);
    room.lastActivity = Date.now();
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    socket.data.isHost = false;
    socket.data.displayName = typeof displayName === 'string' ? displayName.slice(0, 30) : 'Oyente';

    socket.to(code.toUpperCase()).emit('member-joined', {
      id: socket.id, name: socket.data.displayName, count: room.members.size
    });

    cb({ success: true, memberCount: room.members.size });
  });

  // ── STATE UPDATE (Host → Listeners) ──────────────────────────────────────
  socket.on('state-update', (state) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    if (!isValidState(state)) return;

    const now = Date.now();
    const lastTime = rateLimits.get(socket.id) || 0;
    if (now - lastTime < RATE_LIMIT_MS) return;
    rateLimits.set(socket.id, now);

    room.lastActivity = now;
    socket.to(code).emit('state-update', state);
  });

  // ── CHAT ─────────────────────────────────────────────────────────────────
  socket.on('chat-message', (text) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (typeof text !== 'string' || !text.trim() || text.length > 200) return;

    room.lastActivity = Date.now();
    socket.to(code).emit('chat-message', {
      from: socket.data.displayName || (socket.data.isHost ? 'Host' : 'Oyente'),
      text: text.trim().slice(0, 200),
      ts: Date.now()
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    rateLimits.delete(socket.id);

    // Si era el controller del bot, limpiar referencia
    if (controllerSocket?.id === socket.id) {
      controllerSocket = null;
      console.log('[Bot] ⚠️  App controller desconectada');
    }

    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) { console.log(`[Server] Disconnected: ${socket.id}`); return; }

    room.members.delete(socket.id);

    if (room.members.size === 0) {
      rooms.delete(code);
      console.log(`[Server] Room ${code} deleted (empty)`);
    } else if (room.host === socket.id) {
      const newHost = [...room.members][0];
      room.host = newHost;
      io.to(newHost).emit('promoted-to-host');
      io.to(code).emit('host-changed', { newHostId: newHost });
      console.log(`[Server] Host of ${code} changed to ${newHost}`);
    } else {
      io.to(code).emit('member-left', { id: socket.id, count: room.members.size });
    }

    console.log(`[Server] Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[YTMD Server] Corriendo en http://localhost:${PORT}`);
  console.log(`[YTMD Server] Health: http://localhost:${PORT}/health`);
});
