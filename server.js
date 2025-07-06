const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Chess } = require('chess.js');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const validator = require('validator');
const twilio = require('twilio');
const crypto = require('crypto');
const MAX_MOVES_PER_SECOND = 5;
const MIN_MOVE_TIME = 200; // milliseconds
const MAX_RATING_DIFFERENCE = 100; // for matchmaking

require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "cdnjs.cloudflare.com",
        "cdn.socket.io",
        "https://www.paypal.com"
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", process.env.CLIENT_URL || "http://localhost:3000"]
    }
  },
  hsts: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  exposedHeaders: ['set-cookie'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());

// JWT functions
const createToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
};

// Auth middleware
const protect = async (req, res, next) => {
  try {
    let token;
    if (req.cookies.jwt) {
      token = req.cookies.jwt;
    }

    if (!token || token === 'loggedout') {
      return res.status(401).json({
        status: 'fail',
        message: 'Please log in to access this resource'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const currentUser = await User.findById(decoded.id);

    if (!currentUser) {
      return res.status(401).json({
        status: 'fail',
        message: 'The user belonging to this token no longer exists'
      });
    }

    req.user = currentUser;
    next();
  } catch (err) {
    return res.status(401).json({
      status: 'fail',
      message: 'Invalid token'
    });
  }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts, please try again later'
});

app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/verify', authLimiter);
app.use('/api/auth/resend-code', authLimiter);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(apiLimiter);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/chessbet')
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define schemas
const userSchema = new mongoose.Schema({
  
  email: { 
    type: String, 
    required: true, 
    unique: true,
    validate: [validator.isEmail, 'Invalid email']
  },
  phone: {
    type: String,
    required: true,
    validate: [validator.isMobilePhone, 'Invalid phone number']
  },
  countryCode: {
    type: String,
    required: true
  },
  password: { 
    type: String, 
    required: true,
    minlength: 8,
    select: false
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  rating: { 
    type: Number, 
    default: 400,
    min: 100,
    max: 3000
  },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  verified: { type: Boolean, default: false },
  verificationCode: String,
  verificationExpires: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  socketId: String
}, { timestamps: true });

const gameSchema = new mongoose.Schema({
  gameId: String,
  players: [{
    userId: mongoose.Schema.Types.ObjectId,
    username: String,
    color: String,
    rating: Number,
    ratingChange: Number,
    wager: Number
  }],
  moves: [{
    from: String,
    to: String,
    promotion: String,
    fen: String,
    timestamp: Date
  }],
  timeControl: Number,
  result: String,
  winner: String,
  reason: String,
  finalFen: String,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  pgn: String,
  wagers: {
    white: Number,
    black: Number
  }
});

const User = mongoose.model('User', userSchema);
const Game = mongoose.model('Game', gameSchema);


// Configure Socket.IO with auth
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  cookie: true,
  transports: ['websocket', 'polling']
});

// Socket.io middleware for auth
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token || token === 'loggedout') {
      return next(new Error('Authentication error'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || !user.verified) {
      return next(new Error('Authentication error'));
    }

    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// Game state management
const games = {};
// Update the matchmakingQueue object
const matchmakingQueue = {
  players: [],
  pendingMatches: {},
  timeControl: 600,

  addPlayer: function(socket, timeControl, wager) {
    this.removePlayer(socket.id);
    
    const playerData = {
      socketId: socket.id,
      userId: socket.user._id,
      rating: socket.user.rating,
      timeControl,
      wager,
      user: {
        username: socket.user.username,
        rating: socket.user.rating
      },
      timestamp: Date.now()
    };
    
    // Try to find compatible opponent
    for (let i = 0; i < this.players.length; i++) {
      const opponent = this.players[i];
      
      if (opponent.timeControl === timeControl && 
          Math.abs(opponent.wager - wager) <= 10 &&
          opponent.userId.toString() !== playerData.userId.toString()) {
        
        const matchId = generateGameId();
        this.pendingMatches[matchId] = {
          player1: opponent,
          player2: playerData,
          timeControl,
          createdAt: Date.now()
        };
        
        this.players.splice(i, 1);
        
        socket.emit('matchProposal', {
          matchId,
          opponent: opponent.user,
          opponentWager: opponent.wager,
          timeControl,
          rating: opponent.rating
        });
        
        io.to(opponent.socketId).emit('matchProposal', {
          matchId,
          opponent: socket.user,
          opponentWager: wager,
          timeControl,
          rating: socket.user.rating
        });
        
        setTimeout(() => {
          if (this.pendingMatches[matchId]) {
            delete this.pendingMatches[matchId];
            this.addPlayer(socket, timeControl, wager);
            if (io.sockets.sockets.get(opponent.socketId)) {
              io.to(opponent.socketId).emit('matchExpired');
            }
          }
        }, 30000);
        return;
      }
    }
    
    this.players.push(playerData);
    socket.emit('matchmakingStatus', { 
      inQueue: true,
      queueSize: this.players.length
    });
  },

  removePlayer: function(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    
    for (const matchId in this.pendingMatches) {
      const match = this.pendingMatches[matchId];
      if (match.player1.socketId === socketId || 
          match.player2.socketId === socketId) {
        this.handleDeclinedMatch(matchId);
        break;
      }
    }
  },

  handleAcceptedMatch: function(matchId) {
    const match = this.pendingMatches[matchId];
    if (!match) return;
    
    const { player1, player2, timeControl } = match;
    const gameId = generateGameId();
    const gameInstance = new Chess();
    
    games[gameId] = {
      players: {
        [player1.socketId]: { 
          color: 'white', 
          userId: player1.userId,
          username: player1.user.username,
          wager: player1.wager
        },
        [player2.socketId]: { 
          color: 'black', 
          userId: player2.userId,
          username: player2.user.username,
          wager: player2.wager
        }
      },
      fen: gameInstance.fen(),
      timeControl,
      whiteTime: timeControl,
      blackTime: timeControl,
      lastUpdate: Date.now(),
      currentTurn: 'w',
      status: 'active',
      moves: [],
      wagers: {
        white: player1.wager,
        black: player2.wager
      }
    };
    
    io.to(player1.socketId).emit('matchFound', {
      gameId,
      color: 'white',
      timeControl,
      opponent: player2.user,
      opponentWager: player2.wager
    });
    
    io.to(player2.socketId).emit('matchFound', {
      gameId,
      color: 'black',
      timeControl,
      opponent: player1.user,
      opponentWager: player1.wager
    });
    
    io.to(gameId).emit('gameFull', {
      color: 'white',
      state: { fen: gameInstance.fen() },
      timeControl,
      opponent: player2.user,
      wagers: {
        white: player1.wager,
        black: player2.wager
      }
    });
    
    startGameTimer(gameId);
    delete this.pendingMatches[matchId];
  },

  handleDeclinedMatch: function(matchId) {
    const match = this.pendingMatches[matchId];
    if (!match) return;
    
    const { player1, player2 } = match;
    
    if (io.sockets.sockets.get(player1.socketId)) {
      io.to(player1.socketId).emit('matchDeclined');
      this.addPlayer(io.sockets.sockets.get(player1.socketId), 
        player1.timeControl, 
        player1.wager);
    }
    
    if (io.sockets.sockets.get(player2.socketId)) {
      io.to(player2.socketId).emit('matchDeclined');
      this.addPlayer(io.sockets.sockets.get(player2.socketId), 
        player2.timeControl, 
        player2.wager);
    }
    
    delete this.pendingMatches[matchId];
  },

  cleanup: function() {
    const now = Date.now();
    this.players = this.players.filter(p => now - p.timestamp < 1800000);
    for (const matchId in this.pendingMatches) {
      if (now - this.pendingMatches[matchId].createdAt > 30000) {
        this.handleDeclinedMatch(matchId);
      }
    }
  }
};

setInterval(() => matchmakingQueue.cleanup(), 300000);

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}, User: ${socket.user?.username || 'unknown'}`);
  
  if (!socket.user) {
    console.error('No user attached to socket - authentication failed');
    socket.disconnect();
    return;
  }

  // Add this debug line:
  console.log('Authenticated user:', {
    id: socket.user._id,
    username: socket.user.username,
    email: socket.user.email
  });
  // Add error listener
  socket.on('error', (error) => {
    console.error(`Socket error for user ${socket.user.username}:`, error);
  });
  
  // Update user's socketId and lastActive
  User.findByIdAndUpdate(socket.user._id, { 
    socketId: socket.id,
    lastActive: new Date() 
  }).exec();
    
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

  socket.on('createGame', wrap(async ({ timeControl }, callback) => {
    if (!timeControl || timeControl < 60) {
      return callback({ success: false, error: 'Invalid time control' });
    }
    
    const gameId = generateGameId();
    const gameInstance = new Chess();
    
    games[gameId] = {
      players: { 
        [socket.id]: { 
          color: 'white', 
          userId: socket.user._id 
        } 
      },
      fen: gameInstance.fen(),
      timeControl: timeControl,
      whiteTime: timeControl,
      blackTime: timeControl,
      lastUpdate: Date.now(),
      currentTurn: 'w',
      status: 'waiting',
      moves: []
    };
    
    socket.join(gameId);
    
    callback({ 
      success: true,
      gameId: gameId,  
      color: 'white',
      timeControl: timeControl
    });
  }));

  socket.on('joinGame', wrap(async ({ gameId }, callback) => {
    if (!games[gameId]) {
      return callback({ success: false, error: 'Game not found' });
    }

    if (Object.keys(games[gameId].players).length >= 2) {
      return callback({ success: false, error: 'Game is full' });
    }

    const color = Math.random() < 0.5 ? 'white' : 'black';
    games[gameId].players[socket.id] = { 
      color, 
      userId: socket.user._id 
    };
    games[gameId].status = 'active';
    
    socket.join(gameId);
    
    callback({ 
      success: true,
      gameId: gameId, 
      color: color,
      timeControl: games[gameId].timeControl
    });
    
    io.to(gameId).emit('gameFull', { 
      color: color,
      state: { fen: games[gameId].fen },
      timeControl: games[gameId].timeControl
    });
    
    startGameTimer(gameId);
  }));

  socket.on('joinMatchmaking', wrap(async ({ timeControl, wager }, callback) => {
    matchmakingQueue.addPlayer(socket, timeControl, wager || 0);
    callback({ success: true });
  }));

  socket.on('leaveMatchmaking', wrap(() => {
    matchmakingQueue.removePlayer(socket.id);
    socket.emit('matchmakingStatus', { inQueue: false });
  }));

  // Update the move handler with anti-cheating checks
  socket.on('move', wrap(async ({ gameId, from, to, promotion, fen }, callback) => {
    if (!games[gameId] || games[gameId].status !== 'active' || games[gameId].locked) {
      return callback({ success: false, error: 'Game not active' });
    }
    // Add state validation
    if (fen && !validateGameState(gameId, fen)) {
      socket.emit('cheatingWarning', { message: 'Game state mismatch' });
      return callback({ success: false, error: 'Invalid game state' });
    }
    const playerData = games[gameId].players[socket.id];
    if (!playerData) return callback({ success: false, error: 'Not in this game' });
    
    const playerColor = playerData.color;
    const game = new Chess(games[gameId].fen);
    
    // Check if it's the player's turn
    if ((playerColor === 'white' && game.turn() !== 'w') || 
        (playerColor === 'black' && game.turn() !== 'b')) {
      return callback({ success: false, error: 'Not your turn' });
    }

    // Anti-cheating: Move timing checks
    const now = Date.now();
    const moveTime = now - games[gameId].lastUpdate;
    
    // Check for too fast moves
    if (moveTime < MIN_MOVE_TIME) {
      socket.emit('cheatingWarning', { message: 'Moving too fast' });
      return callback({ success: false, error: 'Move too fast' });
    }
    
    // Check for move rate limiting
    const recentMoves = games[gameId].moves.filter(m => 
      m.player === socket.id && 
      now - new Date(m.timestamp).getTime() < 1000
    );
    
    if (recentMoves.length >= MAX_MOVES_PER_SECOND) {
      socket.emit('cheatingWarning', { message: 'Too many moves in short time' });
      return callback({ success: false, error: 'Move rate limit exceeded' });
    }

    // Validate the move
    const move = game.move({ 
      from, 
      to, 
      promotion: promotion || 'q' 
    });
    
    if (!move) {
      return callback({ success: false, error: 'Invalid move' });
    }

    // Update game state
    updateGameState(gameId, game, move);
    
    games[gameId].moves.push({
      from,
      to,
      promotion,
      fen: game.fen(),
      timestamp: new Date(),
      player: socket.id
    });
    
    // Broadcast the move
    io.to(gameId).emit('gameState', { 
      fen: games[gameId].fen,
      lastMove: { from, to },
      timestamp: Date.now(),
      moveHistory: games[gameId].moves
    });
    
    // Check for game over conditions
    checkGameOver(gameId, game);
    
    callback({ success: true });
  }));

  socket.on('resign', wrap(async ({ gameId }) => {
    if (!games[gameId] || games[gameId].status !== 'active') return;
    
    const playerData = games[gameId].players[socket.id];
    if (!playerData) return;
    
    const winner = playerData.color === 'white' ? 'Black' : 'White';
    games[gameId].status = 'finished';
    games[gameId].locked = true;
    
    const game = new Chess();
    games[gameId].moves.forEach(move => {
      game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || 'q'
      });
    });
    games[gameId].pgn = game.pgn();
    
    await handleGameCompletion(gameId, {
      winner,
      reason: 'resignation'
    });
    
    io.to(gameId).emit('gameOver', {
      winner: winner,
      reason: 'resignation',
      finalFen: games[gameId].fen
    });
  }));

  socket.on('offerDraw', wrap(({ gameId }) => {
    if (!games[gameId] || games[gameId].status !== 'active') return;
    
    const opponentId = Object.keys(games[gameId].players).find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit('drawOffered');
    }
  }));

  socket.on('acceptDraw', wrap(async ({ gameId }) => {
    if (!games[gameId] || games[gameId].status !== 'active') return;
    
    games[gameId].status = 'finished';
    games[gameId].locked = true;
    
    const game = new Chess();
    games[gameId].moves.forEach(move => {
      game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || 'q'
      });
    });
    games[gameId].pgn = game.pgn();
    
    await handleGameCompletion(gameId, {
      winner: null,
      reason: 'agreement'
    });
    
    io.to(gameId).emit('gameOver', {
      winner: null,
      reason: 'agreement',
      finalFen: games[gameId].fen
    });
  }));

  socket.on('declineDraw', wrap(({ gameId }) => {
    if (!games[gameId]) return;
    
    const playerId = Object.keys(games[gameId].players).find(id => id !== socket.id);
    if (playerId) {
      io.to(playerId).emit('drawDeclined');
    }
  }));

  socket.on('acceptMatch', wrap(({ matchId }) => {
    matchmakingQueue.handleAcceptedMatch(matchId);
  }));

  socket.on('declineMatch', wrap(({ matchId }) => {
    matchmakingQueue.handleDeclinedMatch(matchId);
  }));

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}, User: ${socket.user.username}`);
    matchmakingQueue.removePlayer(socket.id);
    cleanupDisconnectedPlayer(socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
    cleanupDisconnectedPlayer(socket.id);
  });

});

function validateGameState(gameId, fen) {
  if (!games[gameId]) return false;
  
  try {
    const serverGame = new Chess(games[gameId].fen);
    const clientGame = new Chess(fen);
    
    // Basic validation - check if FEN matches
    if (serverGame.fen() !== clientGame.fen()) {
      return false;
    }
    
    // More advanced validation could go here
    return true;
  } catch (err) {
    return false;
  }
}

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

async function checkGameOver(gameId, game) {
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
    games[gameId].locked = true;
    
    games[gameId].pgn = game.pgn();
    
    await handleGameCompletion(gameId, result);
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
      
      const game = new Chess();
      games[gameId].moves.forEach(move => {
        game.move({
          from: move.from,
          to: move.to,
          promotion: move.promotion || 'q'
        });
      });
      games[gameId].pgn = game.pgn();
      
      handleGameCompletion(gameId, { 
        winner: winner, 
        reason: 'timeout' 
      });
      
      io.to(gameId).emit('gameOver', { 
        winner: winner, 
        reason: 'timeout',
        finalFen: games[gameId].fen
      });
    }
  }, 1000);
}

async function cleanupDisconnectedPlayer(socketId) {
  for (const gameId in games) {
    if (games[gameId].players[socketId]) {
      const playerData = games[gameId].players[socketId];
      delete games[gameId].players[socketId];
      
      if (Object.keys(games[gameId].players).length === 0) {
        clearInterval(games[gameId].interval);
        delete games[gameId];
        console.log(`Game ${gameId} removed (no players)`);
      } else {
        games[gameId].status = 'abandoned';
        clearInterval(games[gameId].interval);
        io.to(gameId).emit('opponentLeft', { playerColor: playerData.color });
        console.log(`Player ${socketId} left game ${gameId}`);
      }
    }
  }
}

async function handleGameCompletion(gameId, result) {
  if (!games[gameId]) return;
  
  const gameData = games[gameId];
  const playerIds = Object.keys(gameData.players);
  
  try {
    const whitePlayerData = gameData.players[playerIds.find(id => gameData.players[id].color === 'white')];
    const blackPlayerData = gameData.players[playerIds.find(id => gameData.players[id].color === 'black')];
    
    const whitePlayer = await User.findById(whitePlayerData.userId);
    const blackPlayer = await User.findById(blackPlayerData.userId);
    
    let whiteRatingChange = 0;
    let blackRatingChange = 0;
    
    if (result.winner === 'White') {
      const expectedWhite = 1 / (1 + Math.pow(10, (blackPlayer.rating - whitePlayer.rating) / 400));
      whiteRatingChange = Math.round(32 * (1 - expectedWhite));
      blackRatingChange = -whiteRatingChange;
    } else if (result.winner === 'Black') {
      const expectedBlack = 1 / (1 + Math.pow(10, (whitePlayer.rating - blackPlayer.rating) / 400));
      blackRatingChange = Math.round(32 * (1 - expectedBlack));
      whiteRatingChange = -blackRatingChange;
    } else {
      const expectedWhite = 1 / (1 + Math.pow(10, (blackPlayer.rating - whitePlayer.rating) / 400));
      whiteRatingChange = Math.round(32 * (0.5 - expectedWhite));
      blackRatingChange = -whiteRatingChange;
    }
    
    if (result.winner === 'White') {
      await User.updateOne({ _id: whitePlayer._id }, { 
        $inc: { rating: whiteRatingChange, wins: 1 },
        $set: { lastActive: new Date() }
      });
      await User.updateOne({ _id: blackPlayer._id }, { 
        $inc: { rating: blackRatingChange, losses: 1 },
        $set: { lastActive: new Date() }
      });
    } else if (result.winner === 'Black') {
      await User.updateOne({ _id: whitePlayer._id }, { 
        $inc: { rating: whiteRatingChange, losses: 1 },
        $set: { lastActive: new Date() }
      });
      await User.updateOne({ _id: blackPlayer._id }, { 
        $inc: { rating: blackRatingChange, wins: 1 },
        $set: { lastActive: new Date() }
      });
    } else {
      await User.updateOne({ _id: whitePlayer._id }, { 
        $inc: { rating: whiteRatingChange, draws: 1 },
        $set: { lastActive: new Date() }
      });
      await User.updateOne({ _id: blackPlayer._id }, { 
        $inc: { rating: blackRatingChange, draws: 1 },
        $set: { lastActive: new Date() }
      });
    }
    
    const gameRecord = new Game({
      gameId,
      players: playerIds.map(id => ({
        userId: gameData.players[id].userId,
        username: gameData.players[id].username,
        color: gameData.players[id].color,
        rating: gameData.players[id].color === 'white' ? whitePlayer.rating : blackPlayer.rating,
        ratingChange: gameData.players[id].color === 'white' ? whiteRatingChange : blackRatingChange,
        wager: gameData.players[id].wager
      })),
      moves: gameData.moves || [],
      timeControl: gameData.timeControl,
      result: result.winner ? `${result.winner} wins by ${result.reason}` : `Draw by ${result.reason}`,
      winner: result.winner,
      reason: result.reason,
      finalFen: gameData.fen,
      pgn: gameData.pgn,
      completedAt: new Date(),
      wagers: gameData.wagers
    });
    
    await gameRecord.save();
    
    io.to(gameId).emit('gameStats', {
      whiteRating: whitePlayer.rating + whiteRatingChange,
      blackRating: blackPlayer.rating + blackRatingChange,
      whiteRatingChange,
      blackRatingChange
    });
    
    clearInterval(gameData.interval);
    delete games[gameId];
  } catch (error) {
    console.error('Error completing game:', error);
  }
}

function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Auth Routes
app.post('/api/payment/methods', protect, async (req, res) => {
  try {
    const { provider, email } = req.body;
    
    // In a real app, you would validate and save the payment method
    // This is a simplified version
    const user = await User.findByIdAndUpdate(req.user.id, {
      $push: {
        paymentMethods: {
          provider,
          email,
          isDefault: req.user.paymentMethods.length === 0
        }
      }
    }, { new: true });
    
    res.status(200).json({
      status: 'success',
      data: {
        paymentMethods: user.paymentMethods
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to add payment method'
    });
  }
});
app.post('/api/payment/deposit', protect, async (req, res) => {
  try {
    const { amount, paymentMethodId } = req.body;
    
    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Amount must be positive'
      });
    }
    
    // In a real app, you would process the payment here
    // For demo purposes, we'll just simulate a successful payment
    
    const user = await User.findByIdAndUpdate(req.user.id, {
      $inc: { walletBalance: amount },
      $push: {
        transactions: {
          type: 'deposit',
          amount,
          paymentMethod: paymentMethodId,
          status: 'completed'
        }
      }
    }, { new: true });
    
    res.status(200).json({
      status: 'success',
      data: {
        balance: user.walletBalance
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Deposit failed'
    });
  }
});
// Wallet Routes
app.get('/api/wallet/balance', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    res.status(200).json({
      status: 'success',
      data: {
        balance: user.walletBalance || 0
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to get wallet balance'
    });
  }
});

app.post('/api/wallet/deposit', protect, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    
    // In a real app, you would integrate with Coinbase Commerce API here
    // This is a simplified version that just simulates the response
    
    // Generate a mock deposit address
    const address = crypto.randomBytes(20).toString('hex');
    
    // Create a pending deposit record
    await User.findByIdAndUpdate(req.user.id, {
      $push: {
        transactions: {
          type: 'deposit',
          amount,
          currency,
          address,
          status: 'pending',
          createdAt: new Date()
        }
      }
    });
    
    res.status(200).json({
      status: 'success',
      data: {
        address
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to create deposit'
    });
  }
});

app.post('/api/wallet/withdraw', protect, async (req, res) => {
  try {
    const { amount, address, currency } = req.body;
    const user = await User.findById(req.user.id);
    
    if (user.walletBalance < amount) {
      return res.status(400).json({
        status: 'fail',
        message: 'Insufficient balance'
      });
    }
    
    // In a real app, you would send the crypto here
    // This is a simplified version
    
    // Generate a mock transaction ID
    const txid = crypto.randomBytes(32).toString('hex');
    
    // Update user balance and create withdrawal record
    await User.findByIdAndUpdate(req.user.id, {
      $inc: { walletBalance: -amount },
      $push: {
        transactions: {
          type: 'withdrawal',
          amount,
          currency,
          address,
          txid,
          status: 'pending',
          createdAt: new Date()
        }
      }
    });
    
    res.status(200).json({
      status: 'success',
      data: {
        txid
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to process withdrawal'
    });
  }
});
app.get('/api/payment/methods', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    res.status(200).json({
      status: 'success',
      data: {
        paymentMethods: user.paymentMethods
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to get payment methods'
    });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, phone, username, password, countryCode } = req.body;
    
    if (!email || !phone || !username || !password || !countryCode) {
      return res.status(400).json({ 
        status: 'fail', 
        message: 'Please provide all required fields' 
      });
    }
    
    // Check for existing unverified user with expired verification
    const existingUnverified = await User.findOne({ 
      email,
      verified: false,
      verificationExpires: { $lt: Date.now() }
    });
    
    if (existingUnverified) {
      await User.deleteOne({ _id: existingUnverified._id });
    }
    
    const existingUser = await User.findOne({ 
      $or: [{ email }, { username }],
      verified: true
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        status: 'fail', 
        message: 'Email or username already in use' 
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const newUser = await User.create({
      email,
      phone,
      countryCode,
      username,
      password: hashedPassword,
      verificationCode,
      verificationExpires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });
    
    // DEVELOPMENT: Log code to console instead of SMS
    console.log(`Verification code for ${email}: ${verificationCode}`);
    
    const token = createToken(newUser._id);
    
    res.cookie('jwt', token, {
      expires: new Date(Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    res.status(201).json({
      status: 'success',
      token,
      data: {
        user: {
          id: newUser._id,
          email: newUser.email,
          username: newUser.username,
          rating: newUser.rating
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});

app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email, verified: false });
    
    if (!user) {
      return res.status(400).json({ 
        status: 'fail', 
        message: 'No pending verification found for this email' 
      });
    }
    
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.verificationCode = verificationCode;
    user.verificationExpires = Date.now() + 10 * 60 * 1000;
    await user.save();
    
    if (process.env.TWILIO_ACCOUNT_SID) {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        body: `Your new ChessBet verification code is: ${verificationCode}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: `+${user.countryCode}${user.phone.replace(/\D/g, '')}`
      });
    }
    
    res.status(200).json({
      status: 'success',
      message: 'New verification code sent'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to resend verification code'
    });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { code } = req.body;
    const user = await User.findOne({ 
      verificationCode: code,
      verificationExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({ 
        status: 'fail', 
        message: 'Invalid or expired verification code' 
      });
    }
    
    user.verified = true;
    user.verificationCode = undefined;
    user.verificationExpires = undefined;
    await user.save();
    
    const token = createToken(user._id);
    
    res.cookie('jwt', token, {
      expires: new Date(Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000),
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    
    res.status(200).json({
      status: 'success',
      token,
      data: {
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          rating: user.rating
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        status: 'fail', 
        message: 'Please provide email and password' 
      });
    }
    
    const user = await User.findOne({ email }).select('+password');
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ 
        status: 'fail', 
        message: 'Incorrect email or password' 
      });
    }
    
    if (!user.verified) {
      return res.status(401).json({ 
        status: 'fail', 
        message: 'Account not verified. Please verify your account.' 
      });
    }
    
    const token = createToken(user._id);
    
    // Set cookie
    res.cookie('jwt', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
    
    res.status(200).json({
      status: 'success',
      token,
      data: {
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          rating: user.rating
        }
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) {
      return res.status(200).json({
        status: 'success',
        message: 'If an account exists, a reset email has been sent'
      });
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpires = Date.now() + 10 * 60 * 1000;
    
    user.passwordResetToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.passwordResetExpires = resetTokenExpires;
    await user.save();
    
    // In a real app, you would send an email with the reset token
    console.log(`Password reset token for ${email}: ${resetToken}`);
    
    res.status(200).json({
      status: 'success',
      message: 'Password reset instructions sent to your email'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Error processing password reset'
    });
  }
});

app.patch('/api/auth/reset-password/:token', async (req, res) => {
  try {
    const hashedToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');
      
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.status(400).json({
        status: 'fail',
        message: 'Token is invalid or has expired'
      });
    }
    
    const hashedPassword = await bcrypt.hash(req.body.password, 12);
    user.password = hashedPassword;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    
    res.status(200).json({
      status: 'success',
      message: 'Password updated successfully'
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Error resetting password'
    });
  }
});

app.get('/api/auth/logout', (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true
  });
  
  res.status(200).json({ status: 'success' });
});

// Protected routes
app.get('/api/user/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    res.status(200).json({
      status: 'success',
      data: {
        user
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong'
    });
  }
});

// API Endpoints
app.get('/api/game/:id/pgn', async (req, res) => {
  try {
    const game = await Game.findOne({ gameId: req.params.id });
    if (!game) {
      if (games[req.params.id]) {
        const game = new Chess();
        games[req.params.id].moves.forEach(move => {
          game.move({
            from: move.from,
            to: move.to,
            promotion: move.promotion || 'q'
          });
        });
        res.set('Content-Type', 'text/plain');
        return res.send(game.pgn());
      }
      return res.status(404).send('Game not found');
    }
    res.set('Content-Type', 'text/plain');
    res.send(game.pgn);
  } catch (error) {
    res.status(500).send('Server error');
  }
});

app.get('/api/user/:id/games', protect, async (req, res) => {
  try {
    const games = await Game.find({ 
      'players.userId': req.params.id 
    }).sort({ completedAt: -1 }).limit(20);
    
    res.json({
      status: 'success',
      results: games.length,
      data: {
        games
      }
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      message: 'Server error' 
    });
  }
});
// In server.js
app.get('/api/debug/auth', (req, res) => {
  res.json({
    cookies: req.cookies,
    headers: req.headers,
    authHeader: req.headers.authorization
  });
});

app.get('/api/debug/user', protect, (req, res) => {
  res.json({
    user: req.user
  });
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
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