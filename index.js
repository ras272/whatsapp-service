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

// ConfiguraciÃ³n
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
let currentQR = null; // Almacenar el QR actual

// ===============================================
// FUNCIÃ“N PRINCIPAL: Conectar a WhatsApp
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
      currentQR = qr; // Guardar el QR para exponerlo por HTTP
      logger.info('ðŸ“± QR Code disponible en: http://localhost:' + CONFIG.port + '/qr');
      logger.info('ðŸ“± String del QR:');
      logger.info(qr);
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const shouldReconnect = 
        (lastDisconnect?.error instanceof Boom) && 
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      
      logger.warn('âŒ ConexiÃ³n cerrada', {
        reason: lastDisconnect?.error?.output?.statusCode,
        shouldReconnect
      });
      
      if (shouldReconnect) {
        logger.info('ðŸ”„ Reconectando en 5 segundos...');
        setTimeout(() => connectToWhatsApp(), 5000);
      } else {
        logger.error('ðŸš« SesiÃ³n cerrada. Elimina auth_info/ y vuelve a escanear QR');
        process.exit(1);
      }
    } else if (connection === 'open') {
      currentQR = null; // Limpiar QR cuando se conecta
      logger.info('âœ… WhatsApp conectado exitosamente!');
      logger.info(`ðŸ“± Grupo tÃ©cnico: ${CONFIG.grupoTecnicoId}`);
    } else if (connection === 'connecting') {
      logger.info('ðŸ”„ Conectando a WhatsApp...');
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
  
  // Solo procesar mensajes del grupo tÃ©cnico
  if (msg.key.remoteJid !== CONFIG.grupoTecnicoId) {
    logger.debug(`Mensaje de chat no autorizado: ${msg.key.remoteJid}`);
    return;
  }
  
  // Extraer texto del mensaje
  const textoCompleto = extraerTextoMensaje(msg);
  
  // âœ… NUEVO: Solo procesar mensajes que empiezan con /
  if (!textoCompleto.startsWith('/')) {
    logger.debug('â­ï¸ Mensaje ignorado (no empieza con /)');
    return;
  }
  
  // âœ… NUEVO: Parsear formato /CLIENTE | EQUIPO | descripciÃ³n
  const mensajeParsed = parsearMensaje(textoCompleto);
  
  if (!mensajeParsed.valido) {
    logger.warn('âš ï¸ Formato invÃ¡lido. Uso: /CLIENTE | EQUIPO | descripciÃ³n');
    // Opcional: enviar mensaje al grupo explicando el formato
    await sock.sendMessage(msg.key.remoteJid, { 
      text: 'âš ï¸ Formato incorrecto.\n\nðŸ“‹ Usar: `/CLIENTE | EQUIPO | descripciÃ³n`\n\nEjemplo:\n`/LA MISION | RX DIGITAL | El equipo no enciende`' 
    });
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
    // âœ… NUEVO: Datos estructurados
    cliente: mensajeParsed.cliente,
    equipo: mensajeParsed.equipo,
    descripcion: mensajeParsed.descripcion,
    textoOriginal: textoCompleto,
    tipo: detectarTipoMensaje(msg),
    timestamp: msg.messageTimestamp || Date.now()
  };
  
  logger.info('ðŸ“© Ticket recibido:', {
    remitente: mensajeData.remitente.nombre,
    cliente: mensajeData.cliente,
    equipo: mensajeData.equipo,
    descripcion: mensajeData.descripcion.substring(0, 50) + '...'
  });
  
  // Enviar a ARES webhook
  await enviarMensajeAARES(mensajeData);
}

// ===============================================
// PARSEAR MENSAJE: /CLIENTE | EQUIPO | descripciÃ³n
// ===============================================

function parsearMensaje(texto) {
  // Remover el prefijo /
  const sinPrefijo = texto.substring(1).trim();
  
  // Separar por |
  const partes = sinPrefijo.split('|').map(p => p.trim());
  
  // Validar que tenga las 3 partes
  if (partes.length < 3) {
    return { valido: false };
  }
  
  const cliente = partes[0];
  const equipo = partes[1];
  const descripcion = partes.slice(2).join(' | ').trim(); // Por si la descripciÃ³n tiene |
  
  // Validar que ninguna parte estÃ© vacÃ­a
  if (!cliente || !equipo || !descripcion) {
    return { valido: false };
  }
  
  return {
    valido: true,
    cliente,
    equipo,
    descripcion
  };
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

    logger.info('âœ… Mensaje enviado a ARES:', {
      status: response.status,
      ticketCreado: response.data?.ticketCreado || false,
      numeroReporte: response.data?.numeroReporte || 'N/A'
    });

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      logger.error('âŒ ARES no estÃ¡ corriendo en', CONFIG.aresApiUrl);
    } else if (error.response?.status === 401) {
      logger.error('âŒ Secret incorrecto. Verificar ARES_WEBHOOK_SECRET');
    } else {
      logger.error('âŒ Error enviando a ARES:', {
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

// Endpoint para obtener el QR code
app.get('/qr', (req, res) => {
  if (!currentQR) {
    return res.status(404).json({ 
      error: 'No hay QR disponible',
      message: 'El servicio ya estÃ¡ conectado o aÃºn no ha generado el QR'
    });
  }
  
  // Devolver el string del QR
  res.json({ 
    qr: currentQR,
    message: 'Usa este string para generar el QR code en https://www.qr-code-generator.com/ o similar'
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
    
    logger.info('âœ… Mensaje enviado al grupo:', {
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
  logger.info(`ðŸš€ Servidor HTTP escuchando en puerto ${CONFIG.port}`);
  logger.info(`ðŸ“ Health check: http://localhost:${CONFIG.port}/health`);
});

// ===============================================
// INICIAR CONEXIÃ“N
// ===============================================

// Validar configuraciÃ³n
if (!CONFIG.webhookSecret) {
  logger.error('âš ï¸ ARES_WEBHOOK_SECRET no configurado en .env');
}

if (!CONFIG.grupoTecnicoId) {
  logger.warn('âš ï¸ GRUPO_TECNICO_ID no configurado. Usa el checklist para obtenerlo.');
}

// Conectar
connectToWhatsApp().catch(err => {
  logger.error('Error fatal:', err);
  process.exit(1);
});

// Manejo de seÃ±ales
process.on('SIGINT', async () => {
  logger.info('ðŸ›‘ Cerrando conexiÃ³n...');
  if (sock) {
    await sock.logout();
  }
  process.exit(0);
});
