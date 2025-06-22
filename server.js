const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Game state management
const games = {};

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Add error handler for all socket events
    const wrap = (handler) => {
        return (...args) => {
            try {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') {
                    return handler(...args);
                } else {
                    return handler(...args, (response) => {
                        if (!response.success) {
                            socket.emit('error', response.error);
                        }
                    });
                }
            } catch (error) {
                console.error('Socket handler error:', error);
                socket.emit('error', error.message);
            }
        };
    };

  // Create new game
  socket.on('createGame', ({ timeControl }, callback) => {
      try {
          if (!timeControl || timeControl < 60) {
              return callback({ success: false, error: 'Invalid time control' });
          }
          
          const gameId = generateGameId();
          const gameInstance = new Chess();
          
          games[gameId] = {
              players: { [socket.id]: 'white' },
              fen: gameInstance.fen(),
              timeControl: timeControl,
              whiteTime: timeControl,
              blackTime: timeControl,
              lastUpdate: Date.now(),
              currentTurn: 'w',
              status: 'waiting'
          };
          
          socket.join(gameId);
          
          callback({ 
              success: true,
              gameId,
              color: 'white',
              timeControl: timeControl
          });
      } catch (error) {
          callback({ success: false, error: error.message });
      }
  });

  // Join existing game
  socket.on('joinGame', ({ gameId }, callback) => {
    try {
      if (!games[gameId]) {
        return callback({ success: false, error: 'Game not found' });
      }

      if (Object.keys(games[gameId].players).length >= 2) {
        return callback({ success: false, error: 'Game is full' });
      }

      const color = 'black';
      games[gameId].players[socket.id] = color;
      games[gameId].status = 'active';
      
      socket.join(gameId);
      
      callback({ 
        success: true,
        gameId,
        color,
        timeControl: games[gameId].timeControl
      });
      
      io.to(gameId).emit('gameFull', { 
        color,
        state: { 
          fen: games[gameId].fen 
        },
        timeControl: games[gameId].timeControl
      });
      
      startGameTimer(gameId);
      console.log(`Player joined game: ${gameId}`);
    } catch (error) {
      console.error('Game join error:', error);
      callback({ success: false, error: 'Failed to join game' });
    }
  });

  // Handle chess moves
  socket.on('move', ({ gameId, from, to, promotion }, callback) => {
    try {
      if (!games[gameId]) {
        return callback({ success: false, error: 'Game not found' });
      }

      const game = new Chess(games[gameId].fen);
      const move = game.move({ 
        from, 
        to, 
        promotion: promotion || 'q' 
      });
      
      if (!move) {
        return callback({ success: false, error: 'Invalid move' });
      }

      updateGameState(gameId, game, move);
      
      io.to(gameId).emit('gameState', { 
        fen: games[gameId].fen,
        lastMove: { from, to },
        timestamp: Date.now()
      });
      
      checkGameOver(gameId, game);
      
      callback({ success: true });
    } catch (error) {
      console.error('Move processing error:', error);
      callback({ success: false, error: 'Failed to process move' });
    }
  });

  // Handle resignations
  socket.on('resign', ({ gameId }) => {
    if (!games[gameId]) return;
    
    const playerColor = games[gameId].players[socket.id];
    const winner = playerColor === 'white' ? 'Black' : 'White';
    
    games[gameId].status = 'finished';
    clearInterval(games[gameId].interval);
    
    io.to(gameId).emit('gameOver', {
      winner: winner,
      reason: 'resignation'
    });
  });

  // Handle draw offers
    socket.on('offerDraw', ({ gameId }) => {
        if (!games[gameId] || games[gameId].status !== 'active') return;
        
        const opponentId = Object.keys(games[gameId].players).find(id => id !== socket.id);
        if (opponentId) {
            io.to(opponentId).emit('drawOffered');
        }
    });

  // Handle draw acceptances
  socket.on('acceptDraw', ({ gameId }) => {
    if (!games[gameId]) return;
    
    games[gameId].status = 'finished';
    clearInterval(games[gameId].interval);
    
    io.to(gameId).emit('gameOver', {
      winner: null,
      reason: 'agreement'
    });
  });

  // Handle draw declines
  socket.on('declineDraw', ({ gameId }) => {
    if (!games[gameId]) return;
    
    const playerId = Object.keys(games[gameId].players).find(id => id !== socket.id);
    if (playerId) {
      io.to(playerId).emit('drawDeclined');
    }
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    cleanupDisconnectedPlayer(socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
    cleanupDisconnectedPlayer(socket.id);
  });
});

// Helper Functions
function updateGameState(gameId, game, move) {
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - games[gameId].lastUpdate) / 1000);
  games[gameId].lastUpdate = now;
  
  if (move.color === 'w') {
    games[gameId].whiteTime = Math.max(0, games[gameId].whiteTime - elapsedSeconds);
  } else {
    games[gameId].blackTime = Math.max(0, games[gameId].blackTime - elapsedSeconds);
  }
  
  games[gameId].fen = game.fen();
  games[gameId].currentTurn = game.turn();
}

function checkGameOver(gameId, game) {
  if (game.isGameOver()) {
    clearInterval(games[gameId].interval);
    
    let result;
    if (game.isCheckmate()) {
      result = { 
        winner: game.turn() === 'w' ? 'Black' : 'White', 
        reason: 'checkmate' 
      };
    } else if (game.isDraw()) {
      result = { 
        winner: null, 
        reason: game.isStalemate() ? 'stalemate' : 
               game.isThreefoldRepetition() ? 'threefold repetition' :
               game.isInsufficientMaterial() ? 'insufficient material' :
               'draw' 
      };
    }
    
    games[gameId].status = 'finished';
    io.to(gameId).emit('gameOver', result);
  }
}

function startGameTimer(gameId) {
  games[gameId].interval = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.floor((now - games[gameId].lastUpdate) / 1000);
    games[gameId].lastUpdate = now;
    
    if (games[gameId].currentTurn === 'w') {
      games[gameId].whiteTime = Math.max(0, games[gameId].whiteTime - elapsed);
    } else {
      games[gameId].blackTime = Math.max(0, games[gameId].blackTime - elapsed);
    }
    
    io.to(gameId).emit('timeUpdate', {
      whiteTime: games[gameId].whiteTime,
      blackTime: games[gameId].blackTime
    });
    
    if (games[gameId].whiteTime <= 0 || games[gameId].blackTime <= 0) {
      clearInterval(games[gameId].interval);
      const winner = games[gameId].whiteTime <= 0 ? 'Black' : 'White';
      games[gameId].status = 'finished';
      io.to(gameId).emit('gameOver', { 
        winner: winner, 
        reason: 'timeout' 
      });
    }
  }, 1000);
}

function cleanupDisconnectedPlayer(socketId) {
    for (const gameId in games) {
        if (games[gameId].players[socketId]) {
            const playerColor = games[gameId].players[socketId];
            delete games[gameId].players[socketId];
            
            if (Object.keys(games[gameId].players).length === 0) {
                clearInterval(games[gameId].interval);
                delete games[gameId];
                console.log(`Game ${gameId} removed (no players)`);
            } else {
                games[gameId].status = 'abandoned';
                clearInterval(games[gameId].interval);
                io.to(gameId).emit('opponentLeft', { playerColor });
                console.log(`Player ${socketId} left game ${gameId}`);
            }
        }
    }
}

function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}).on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});