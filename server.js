const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Boom } = require('@hapi/boom');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const P = require('pino');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const SESSION_TIMEOUT = 20000; // 20 seconds
const PAIR_CODE = 'DOPESASA';

// Sessions store
const sessions = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// WebSocket handling
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.action === 'pair') {
        await handlePairCode(ws, data.number);
      } else if (data.action === 'qr') {
        await handleQrCode(ws);
      }
    } catch (err) {
      console.error('[WS] Error:', err);
      ws.send(JSON.stringify({ type: 'pair_error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

async function handlePairCode(ws, phoneNumber) {
  const sessionId = 'session_' + Date.now();
  const authFolder = path.join(__dirname, 'auth', sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser: ['SASA X MD', 'Chrome', '10.0'],
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    connectTimeoutMs: 30000,
  });

  sessions.set(sessionId, { sock, ws, startTime: Date.now(), type: 'pair', phoneNumber });

  // Request pairing code after connection
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting' || qr) {
      try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNumber, PAIR_CODE);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pair_code', code }));
        }

        // Auto-expire after 20 seconds
        setTimeout(() => {
          try {
            sock.end(new Error('Timeout'));
            sessions.delete(sessionId);
          } catch(e) {}
        }, SESSION_TIMEOUT);

      } catch (err) {
        console.error('[Pair] Error requesting code:', err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pair_error', message: 'Failed to generate pair code' }));
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || DisconnectReason.loggedOut;
      if (statusCode === DisconnectReason.loggedOut) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'status', state: 'disconnected' }));
        }
      }
    }
  });

  // When credentials are updated (linked successfully)
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    
    if (sock.authState.creds.registered) {
      const sessionData = sessions.get(sessionId);
      if (sessionData) {
        // Send session ID back to the phone number
        try {
          const jid = sessionData.phoneNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          const creds = sock.authState.creds;
          const sessionIdStr = JSON.stringify({
            sessionId: sessionId,
            registered: true,
            serverHash: creds.serverHash || 'generated',
          });

          await sock.sendMessage(jid, {
            text: `SASA X MD OFC - Session Generated\n\nSession ID: ${sessionId}\n\nUse this to connect your WhatsApp bot.`,
          });

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'session_id', 
              sessionId: sessionId,
              message: 'Session sent to your WhatsApp number',
            }));
          }
        } catch (err) {
          console.error('[Session] Error sending message:', err);
        }

        // Clean up after sending
        setTimeout(() => {
          try { sock.end(new Error('Done')); } catch(e) {}
          sessions.delete(sessionId);
        }, 2000);
      }
    }
  });
}

async function handleQrCode(ws) {
  const sessionId = 'qr_' + Date.now();
  const authFolder = path.join(__dirname, 'auth', sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
    },
    printQRInTerminal: false,
    browser: ['SASA X MD', 'Chrome', '10.0'],
    logger: P({ level: 'silent' }),
    markOnlineOnConnect: false,
    connectTimeoutMs: 30000,
  });

  sessions.set(sessionId, { sock, ws, startTime: Date.now(), type: 'qr' });

  let qrSent = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !qrSent) {
      qrSent = true;
      try {
        const qrBase64 = await QRCode.toDataURL(qr, { 
          width: 400, 
          margin: 2,
          color: { dark: '#000', light: '#fff' }
        });
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'qr_code', qr: qrBase64 }));
        }

        // Auto-expire after 20 seconds
        setTimeout(() => {
          qrSent = false;
          try {
            sock.end(new Error('Timeout'));
            sessions.delete(sessionId);
          } catch(e) {}
        }, SESSION_TIMEOUT);

      } catch (err) {
        console.error('[QR] Error generating:', err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'qr_error', message: 'Failed to generate QR' }));
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode || DisconnectReason.loggedOut;
      if (statusCode === DisconnectReason.loggedOut) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'status', state: 'disconnected' }));
        }
      }
    }
  });

  // When credentials updated (QR scanned successfully)
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    
    if (sock.authState.creds.registered) {
      const sessionData = sessions.get(sessionId);
      if (sessionData && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'qr_success', 
          sessionId: sessionId,
          message: 'QR scanned successfully',
        }));
      }
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Running on port ${PORT}`);
});
