# 🤖 ARES WhatsApp Service

Servidor Node.js con **Baileys** para conectar el bot de WhatsApp al sistema ARES.

## 📋 Pre-requisitos

- **Node.js** v18 o superior
- **npm** o **yarn**
- Teléfono con WhatsApp activo
- Servidor ARES corriendo en `http://localhost:3000`

---

## 🚀 Instalación

### 1. Instalar dependencias

```bash
cd whatsapp-service
npm install
```

### 2. Configurar variables de entorno

```bash
# Copiar el template
cp .env.example .env

# Editar .env con tu configuración
```

**Variables importantes:**

- `ARES_API_URL`: URL donde corre ARES (default: `http://localhost:3000`)
- `ARES_WEBHOOK_SECRET`: Secret compartido (debe coincidir con ARES)
- `GRUPO_TECNICO_ID`: ID del grupo de WhatsApp (ver sección "Obtener ID del Grupo")
- `PORT`: Puerto del servidor HTTP (default: `3001`)

### 3. Obtener ID del Grupo de WhatsApp

#### Método A: Desde WhatsApp Web

1. Abrir https://web.whatsapp.com
2. Abrir el grupo técnico
3. Presionar **F12** → **Console**
4. Ejecutar: `Store.Chat.models[0].id`
5. Copiar el resultado (ej: `120363023427327473@g.us`)

#### Método B: Desde los logs del servidor

1. Iniciar el servidor (ver siguiente paso)
2. Enviar mensaje en el grupo
3. Ver el log con el `Chat ID`

---

## 🎮 Uso

### Iniciar servidor

```bash
npm run dev
```

### Primera vez (vincular dispositivo)

1. Al iniciar, aparecerá un **QR code** en la terminal
2. Abrir WhatsApp en el teléfono
3. **Menú → Dispositivos vinculados → Vincular dispositivo**
4. Escanear el QR
5. ✅ Mensaje: "WhatsApp conectado exitosamente!"

### Sesión guardada

Una vez escaneado el QR, la sesión se guarda en `auth_info/`. En futuros inicios, se conecta automáticamente sin QR.

---

## 🧪 Testing

### Test 1: Verificar conexión

```bash
curl http://localhost:3001/health
```

**Respuesta esperada:**
```json
{
  "status": "ok",
  "connected": true,
  "numero": "+595XXXXXXXXX"
}
```

### Test 2: Enviar mensaje de prueba al grupo

```bash
curl -X POST http://localhost:3001/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "chatId": "120363XXXXXX@g.us",
    "message": "Test desde servidor Baileys"
  }'
```

### Test 3: Verificar logs

Enviar un mensaje en el grupo de WhatsApp y verificar que aparezca en los logs:

```
📩 Mensaje recibido: { remitente: 'Javier López', texto: 'test bot...', tipo: 'text' }
✅ Mensaje enviado a ARES: { status: 200, ticketCreado: false }
```

---

## 📊 Estados de Conexión

| Estado | Descripción |
|--------|-------------|
| `connecting` | Conectando a WhatsApp |
| `open` | ✅ Conectado exitosamente |
| `close` | ❌ Desconectado (reconectando automáticamente) |

### Reconexión automática

El servidor **reconecta automáticamente** si pierde la conexión, excepto cuando:
- La sesión fue cerrada manualmente (logout)
- Las credenciales fueron revocadas

En esos casos, eliminar `auth_info/` y volver a escanear QR.

---

## 🔧 Troubleshooting

### Problema: QR no aparece

```bash
# Limpiar sesión anterior
rm -rf auth_info/
npm run dev
```

### Problema: "ECONNREFUSED"

ARES no está corriendo. Verificar:

```bash
# En otra terminal, en la raíz del proyecto
npm run dev
```

ARES debe estar en `http://localhost:3000`

### Problema: "Unauthorized 401"

El `ARES_WEBHOOK_SECRET` no coincide. Verificar:

1. `.env` de whatsapp-service
2. `.env.local` de ARES (debe tener la misma variable)

### Problema: No recibe mensajes del grupo

Verificar `GRUPO_TECNICO_ID` en `.env`:

1. Enviar mensaje en el grupo
2. Ver logs del servidor
3. Buscar línea: `Mensaje de chat no autorizado: 120363...`
4. Copiar ese ID y actualizarlo en `.env`

### Problema: Desconexión constante

- Verificar conexión a internet
- Cerrar WhatsApp Web en otros navegadores
- Asegurar que el teléfono tiene batería y conexión

---

## 📁 Estructura de Archivos

```
whatsapp-service/
├── index.js              # Servidor principal
├── package.json
├── .env                  # Configuración (gitignored)
├── .env.example          # Template
├── .gitignore
├── auth_info/            # Sesión WhatsApp (gitignored)
└── README.md
```

---

## 🔒 Seguridad

- ❌ **NUNCA** commitear `auth_info/` (contiene credenciales)
- ❌ **NUNCA** compartir el `ARES_WEBHOOK_SECRET`
- ✅ Usar secrets diferentes en desarrollo y producción
- ✅ Solo procesar mensajes del `GRUPO_TECNICO_ID` configurado

---

## 🚀 Producción

Para correr en producción (servidor dedicado):

```bash
# Instalar PM2
npm install -g pm2

# Iniciar con PM2
pm2 start index.js --name whatsapp-bot

# Ver logs
pm2 logs whatsapp-bot

# Auto-iniciar en reboot
pm2 startup
pm2 save
```

---

## 📞 Comandos Útiles

```bash
# Ver logs en tiempo real
npm run dev

# Reiniciar servidor
Ctrl + C → npm run dev

# Limpiar sesión y volver a vincular
rm -rf auth_info/ && npm run dev

# Ver estado de conexión
curl http://localhost:3001/health
```

---

## 🎯 Siguiente Paso

Una vez que el servidor funcione correctamente:
1. ✅ Verificar que recibe mensajes del grupo
2. ✅ Confirmar que envía a ARES (aunque el webhook aún no existe)
3. Continuar con **Día 5**: Crear webhook en ARES

Ver: `DIA_3-4_CHECKLIST.md` para validación completa
