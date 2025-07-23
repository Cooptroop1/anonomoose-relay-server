const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// Initialize WebSocket server
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port });

// Map to store clients by chat code: { code: { clientId: { ws, username } } }
const chats = new Map();
// Map to track clients by WebSocket for cleanup: { ws: { code, clientId } }
const clientsByWs = new Map();

// Validate chat code format (xxxx-xxxx-xxxx-xxxx)
function validateCode(code) {
  const regex = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/;
  return code && regex.test(code);
}

// Validate username (1-16 alphanumeric characters)
function validateUsername(username) {
  const regex = /^[a-zA-Z0-9]{1,16}$/;
  return username && regex.test(username);
}

// Broadcast message to all clients in a chat except the sender
function broadcastMessage(code, senderId, message) {
  const chat = chats.get(code);
  if (!chat) return;
  chat.forEach((client, clientId) => {
    if (clientId !== senderId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');

  // Track client metadata
  let clientId = null;
  let code = null;
  let username = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('Received message:', message);

      // Handle client connection
      if (message.type === 'connect') {
        clientId = message.clientId || uuidv4();
        clientsByWs.set(ws, { clientId });
        ws.send(JSON.stringify({ type: 'connected', clientId }));
        console.log(`Client ${clientId} connected`);
        return;
      }

      // Handle joining a chat
      if (message.type === 'join') {
        if (!validateCode(message.code)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid code format' }));
          return;
        }
        if (!validateUsername(message.username)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid username: 1-16 alphanumeric characters' }));
          return;
        }

        code = message.code;
        username = message.username;
        clientId = message.clientId;

        // Initialize chat if it doesn't exist
        if (!chats.has(code)) {
          chats.set(code, new Map());
        }

        const chat = chats.get(code);

        // Check if username is taken
        let usernameTaken = false;
        chat.forEach((client) => {
          if (client.username === username && clientId !== clientId) {
            usernameTaken = true;
          }
        });
        if (usernameTaken) {
          ws.send(JSON.stringify({ type: 'error', message: 'Username already taken' }));
          return;
        }

        // Check if chat is full (max 10 users)
        if (chat.size >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Chat is full' }));
          return;
        }

        // Add client to chat
        chat.set(clientId, { ws, username });
        clientsByWs.set(ws, { code, clientId });
        console.log(`Client ${clientId} (${username}) joined chat ${code}`);

        // Notify client of successful join
        ws.send(JSON.stringify({ type: 'joined', code, totalClients: chat.size }));

        // Notify all clients in chat of new join
        broadcastMessage(code, clientId, {
          type: 'join-notify',
          clientId,
          username,
          totalClients: chat.size,
          code
        });
      }

      // Handle message relaying (text or image)
      if (message.type === 'message' || message.type === 'image') {
        if (!code || !chat || !message.messageId || !message.username || (!message.content && !message.data)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format or not in a chat' }));
          return;
        }

        // Verify sender is in chat
        const chat = chats.get(code);
        if (!chat || !chat.has(clientId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not in chat' }));
          return;
        }

        // Relay message to all other clients in chat
        broadcastMessage(code, clientId, {
          type: message.type,
          messageId: message.messageId,
          username: message.username,
          content: message.content, // for text
          data: message.data // for images
        });
        console.log(`Relayed ${message.type} from ${clientId} (${username}) in chat ${code}`);
      }

      // Handle client leaving
      if (message.type === 'leave') {
        if (code && clientId) {
          const chat = chats.get(code);
          if (chat && chat.has(clientId)) {
            chat.delete(clientId);
            clientsByWs.delete(ws);
            console.log(`Client ${clientId} left chat ${code}`);
            if (chat.size === 0) {
              chats.delete(code);
              console.log(`Chat ${code} is empty, removed`);
            } else {
              // Notify remaining clients
              broadcastMessage(code, clientId, {
                type: 'client-disconnected',
                clientId,
                totalClients: chat.size,
                code
              });
            }
          }
        }
        ws.close();
      }

      // Handle ping for keepalive
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }

    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    if (code && clientId) {
      const chat = chats.get(code);
      if (chat && chat.has(clientId)) {
        chat.delete(clientId);
        clientsByWs.delete(ws);
        console.log(`Client ${clientId} disconnected from chat ${code}`);
        if (chat.size === 0) {
          chats.delete(code);
          console.log(`Chat ${code} is empty, removed`);
        } else {
          broadcastMessage(code, clientId, {
            type: 'client-disconnected',
            clientId,
            totalClients: chat.size,
            code
          });
        }
      }
    }
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

console.log(`Server running on port ${port}`);
