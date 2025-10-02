// ===============================================
// ARES WhatsApp Service - Servidor Baileys
// ===============================================

import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  delay
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// Configuración
const CONFIG = {
  aresApiUrl: process.env.ARES_API_URL || 'http://localhost:3000',
  webhookSecret: process.env.ARES_WEBHOOK_SECRET || '',
  grupoTecnicoId: process.env.GRUPO_TECNICO_ID || '',
  port: process.env.PORT || 3001
};

// Logger
const logger = P({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

// Socket de WhatsApp (global)
let sock = null;

// ===============================================
// FUNCIÓN PRINCIPAL: Conectar a WhatsApp
// ===============================================

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: false,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  // Guardar credenciales cuando cambien
  sock.ev.on('creds.update', saveCreds);
  
  // ===============================================
  // EVENT: connection.update
  // ===============================================
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      logger.info('📱 Escanea este QR con WhatsApp:');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const shouldReconnect = 
        (lastDisconnect?.error instanceof Boom) && 
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      
      logger.warn('❌ Conexión cerrada', {
        reason: lastDisconnect?.error?.output?.statusCode,
        shouldReconnect
      });
      
      if (shouldReconnect) {
        logger.info('🔄 Reconectando en 5 segundos...');
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        logger.error('🚫 Sesión cerrada. Elimina auth_info/ y vuelve a escanear QR');
        process.exit(1);
      }
    } else if (connection === 'open') {
      logger.info('✅ WhatsApp conectado exitosamente!');
      logger.info(`📱 Grupo técnico: ${CONFIG.grupoTecnicoId}`);
    } else if (connection === 'connecting') {
      logger.info('🔄 Conectando a WhatsApp...');
    }
  });

  // ===============================================
  // EVENT: messages.upsert (MENSAJES ENTRANTES)
  // ===============================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // Solo mensajes nuevos
    
    for (const msg of messages) {
      try {
        await procesarMensaje(sock, msg);
      } catch (error) {
        logger.error('Error procesando mensaje:', error);
      }
    }
  });

  return sock;
}

// ===============================================
// PROCESAR MENSAJE
// ===============================================

async function procesarMensaje(sock, msg) {
  // Ignorar mensajes propios
  if (msg.key.fromMe) {
    logger.debug('Mensaje propio ignorado');
    return;
  }
  
  // Solo procesar mensajes del grupo técnico
  if (msg.key.remoteJid !== CONFIG.grupoTecnicoId) {
    logger.debug(`Mensaje de chat no autorizado: ${msg.key.remoteJid}`);
    return;
  }
  
  // Extraer datos del mensaje
  const mensajeData = {
    id: msg.key.id,
    chatId: msg.key.remoteJid,
    remitente: {
      numero: msg.key.participant || msg.key.remoteJid,
      nombre: msg.pushName || 'Desconocido'
    },
    texto: extraerTextoMensaje(msg),
    tipo: detectarTipoMensaje(msg),
    timestamp: msg.messageTimestamp || Date.now()
  };
  
  logger.info('📩 Mensaje recibido:', {
    remitente: mensajeData.remitente.nombre,
    texto: mensajeData.texto.substring(0, 50) + '...',
    tipo: mensajeData.tipo
  });
  
  // Enviar a ARES webhook
  await enviarMensajeAARES(mensajeData);
}

// ===============================================
// EXTRAER TEXTO DEL MENSAJE
// ===============================================

function extraerTextoMensaje(msg) {
  return msg.message?.conversation || 
         msg.message?.extendedTextMessage?.text || 
         msg.message?.imageMessage?.caption ||
         msg.message?.videoMessage?.caption ||
         '';
}

// ===============================================
// DETECTAR TIPO DE MENSAJE
// ===============================================

function detectarTipoMensaje(msg) {
  if (msg.message?.imageMessage) return 'image';
  if (msg.message?.videoMessage) return 'video';
  if (msg.message?.documentMessage) return 'document';
  if (msg.message?.audioMessage) return 'audio';
  return 'text';
}

// ===============================================
// ENVIAR MENSAJE A ARES
// ===============================================

async function enviarMensajeAARES(mensajeData) {
  try {
    const response = await axios.post(
      `${CONFIG.aresApiUrl}/api/whatsapp/webhook`,
      mensajeData,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': CONFIG.webhookSecret
        },
        timeout: 10000 // 10 segundos
      }
    );

    logger.info('✅ Mensaje enviado a ARES:', {
      status: response.status,
      ticketCreado: response.data?.ticketCreado || false,
      numeroReporte: response.data?.numeroReporte || 'N/A'
    });

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      logger.error('❌ ARES no está corriendo en', CONFIG.aresApiUrl);
    } else if (error.response?.status === 401) {
      logger.error('❌ Secret incorrecto. Verificar ARES_WEBHOOK_SECRET');
    } else {
      logger.error('❌ Error enviando a ARES:', {
        message: error.message,
        status: error.response?.status
      });
    }
  }
}

// ===============================================
// SERVIDOR HTTP (para recibir comandos de ARES)
// ===============================================

const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: sock?.user ? true : false,
    numero: sock?.user?.id || null
  });
});

// Enviar mensaje al grupo (llamado desde ARES)
app.post('/send-message', async (req, res) => {
  try {
    const { chatId, message } = req.body;
    
    if (!sock) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    
    if (!chatId || !message) {
      return res.status(400).json({ error: 'chatId and message are required' });
    }
    
    await sock.sendMessage(chatId, { text: message });
    
    logger.info('✅ Mensaje enviado al grupo:', {
      preview: message.substring(0, 50)
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error('Error enviando mensaje:', error);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor HTTP
app.listen(CONFIG.port, () => {
  logger.info(`🚀 Servidor HTTP escuchando en puerto ${CONFIG.port}`);
  logger.info(`📍 Health check: http://localhost:${CONFIG.port}/health`);
});

// ===============================================
// INICIAR CONEXIÓN
// ===============================================

// Validar configuración
if (!CONFIG.webhookSecret) {
  logger.error('⚠️ ARES_WEBHOOK_SECRET no configurado en .env');
}

if (!CONFIG.grupoTecnicoId) {
  logger.warn('⚠️ GRUPO_TECNICO_ID no configurado. Usa el checklist para obtenerlo.');
}

// Conectar
connectToWhatsApp().catch(err => {
  logger.error('Error fatal:', err);
  process.exit(1);
});

// Manejo de señales
process.on('SIGINT', async () => {
  logger.info('🛑 Cerrando conexión...');
  if (sock) {
    await sock.logout();
  }
  process.exit(0);
});
