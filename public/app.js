
document.addEventListener('DOMContentLoaded', function() {
  console.log('DOM fully loaded');
  initChessboard();
  setupAuthFormHandlers();
  
  // Show UI immediately while checking auth status
  enableUI();

  checkAuthStatus().then(isAuthenticated => {
    console.log('Auth check complete, authenticated:', isAuthenticated);
    if (isAuthenticated) {
      document.querySelector('.game-container').style.display = 'grid';
      document.querySelector('.auth-modal').style.display = 'none';
      initGame();
    } else {
      document.querySelector('.game-container').style.display = 'none';
      showAuthModal();
      // Stop further execution
      return;
    }
  }).catch(err => {
    console.error('Auth check failed:', err);
    showAuthModal();
  });

  // Theme toggle
  const themeToggle = document.getElementById('theme-toggle');
  themeToggle.addEventListener('click', toggleTheme);
  
  if (localStorage.getItem('theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
  }
});

let socket;
let game;
let board;
let currentGameId = null;
let playerColor = null;
let gameTime = 10 * 60;
let whiteTime = gameTime;
let blackTime = gameTime;
let gameInterval;
let lastMoveTime = null;
let drawOfferActive = false;
let playerRating = 400;
let playerStats = { wins: 0, losses: 0, draws: 0 };
let currentUser = null;
let resendTimerInterval;

function debugAuthState() {
  console.group('Auth Debug');
  console.log('LocalStorage JWT:', localStorage.getItem('jwt'));
  console.log('Cookie JWT:', getCookie('jwt'));
  console.log('Current User:', currentUser);
  console.groupEnd();
}

// Call this after important auth operations
debugAuthState();

function initChessboard() {
  try {
    if (window.Chessboard && board) {
      Chessboard('board', 'destroy');
    }
    
    board = Chessboard('board', {
      draggable: true,
      position: 'start',
      pieceTheme: '/pieces/merida/{piece}.svg',
      onDragStart: onDragStart,
      onDrop: onDrop,
      onSnapEnd: onSnapEnd,
      showNotation: true,
      sparePieces: false,
      appearSpeed: 100,
      moveSpeed: 200,
      snapbackSpeed: 100
    });
    
    // Small delay to ensure board is ready
    setTimeout(() => {
      if (board) {
        board.position('start');
      }
    }, 100);
  } catch (err) {
    console.error('Chessboard initialization error:', err);
    showNotification('Failed to load chessboard', 'error');
  }
}

window.addEventListener('resize', handleResize);

function handleResize() {
  if (board) {
    // This will force the board to recalculate its size
    board.resize();
  }
}

function initGame() {
  console.log('Initializing game...');
  const token = localStorage.getItem('jwt') || getCookie('jwt');
  console.log('Using JWT token:', token ? 'found' : 'not found');

  enableUI();

  try {
    if (socket) {
      console.log('Cleaning up previous socket connection');
      socket.disconnect();
      socket.removeAllListeners();
      socket = null;
    }

    console.log('Creating new socket connection...');
    socket = io({
      auth: { 
        token: token 
      },
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      transports: ['websocket'],
      withCredentials: true
    });

    // Add error listener
    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
      if (err.message === 'Authentication error') {
        showNotification('Session expired. Please log in again.', 'error');
        logout();
      }
    });

    setupSocketListeners();
    game = new Chess();
    initChessboard();
    updateClocks();
    loadPlayerProfile();
    initCryptoWallet();
    setupUIListeners();

  } catch (err) {
    console.error('Game initialization failed:', err);
    showNotification('Failed to initialize game. Please refresh.', 'error');
    enableUI();
  }
}

function initSocket(token) {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  return new Promise((resolve, reject) => {
    socket = io({
      auth: { token },
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      transports: ['websocket'],
      withCredentials: true
    });

    socket.on('connect', () => {
      console.log('Socket connected');
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
      reject(err);
    });

    setupSocketListeners();
  });
}

async function initGame() {
  console.log('Initializing game...');
  const token = localStorage.getItem('jwt') || getCookie('jwt');
  
  if (!token) {
    showNotification('Please log in to play', 'error');
    showAuthModal();
    return;
  }

  enableUI();

  try {
    await initSocket(token);
    game = new Chess();
    initChessboard();
    updateClocks();
    await loadPlayerProfile();
    initCryptoWallet();
    setupUIListeners();
  } catch (err) {
    console.error('Game initialization failed:', err);
    showNotification('Failed to connect. Please refresh and try again.', 'error');
    if (err.message.includes('Authentication')) {
      logout();
    }
  }
}

function enableUI() {
  console.log('Enabling UI elements...');
  document.querySelectorAll('button').forEach(btn => {
    // Only enable buttons that aren't specifically marked to stay disabled
    if (!btn.classList.contains('keep-disabled')) {
      btn.disabled = false;
    }
  });
}

function disableUI() {
  console.log('Disabling UI elements...');
  document.querySelectorAll('button').forEach(btn => {
    // Don't disable logout button or buttons marked to stay enabled
    if (!btn.id.includes('logout') && !btn.classList.contains('keep-enabled')) {
      btn.disabled = true;
    }
  });
}

// Crypto Wallet Functions
async function initCryptoWallet() {
  try {
    const response = await fetch('/api/wallet/balance', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      updateWalletDisplay(data.data.balance);
    }
  } catch (error) {
    console.error('Failed to load wallet balance:', error);
  }
}

function updateWalletDisplay(balance) {
  const walletElement = document.getElementById('wallet-balance');
  if (walletElement) {
    walletElement.textContent = `${balance.toFixed(8)} BTC`;
  }
}

function showCryptoDepositModal() {
  const modal = document.createElement('div');
  modal.className = 'modal show';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Deposit Crypto</h3>
      <div class="form-group">
        <label>Amount (USD)</label>
        <input type="number" id="crypto-amount" min="5" step="0.01" placeholder="10.00">
      </div>
      <div class="form-group">
        <label>Currency</label>
        <select id="crypto-currency">
          <option value="BTC">Bitcoin (BTC)</option>
          <option value="ETH">Ethereum (ETH)</option>
          <option value="LTC">Litecoin (LTC)</option>
        </select>
      </div>
      <div class="modal-buttons">
        <button id="confirm-crypto-deposit" class="btn btn-success">Generate Deposit Address</button>
        <button id="cancel-crypto-deposit" class="btn btn-danger">Cancel</button>
      </div>
      <div id="deposit-address-container" style="display:none; margin-top:1rem;">
        <p>Send your crypto to:</p>
        <div class="deposit-address" id="deposit-address"></div>
        <div class="deposit-qr" id="deposit-qr"></div>
        <p>Deposits typically take 3 confirmations (~30 minutes)</p>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('confirm-crypto-deposit').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('crypto-amount').value);
    const currency = document.getElementById('crypto-currency').value;
    
    if (!amount || amount < 5) {
      showNotification('Minimum deposit is $5', 'error');
      return;
    }
    
    try {
      const response = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          amount,
          currency
        }),
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        document.getElementById('deposit-address').textContent = data.data.address;
        document.getElementById('deposit-address-container').style.display = 'block';
        showNotification('Deposit address generated!', 'success');
      } else {
        throw new Error(data.message || 'Failed to generate deposit address');
      }
    } catch (error) {
      showNotification(error.message, 'error');
    }
  });
  
  document.getElementById('cancel-crypto-deposit').addEventListener('click', () => {
    modal.remove();
  });
}

function showWithdrawModal() {
  const modal = document.createElement('div');
  modal.className = 'modal show';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Withdraw Crypto</h3>
      <div class="form-group">
        <label>Amount (BTC)</label>
        <input type="number" id="withdraw-amount" step="0.00000001" placeholder="0.01">
      </div>
      <div class="form-group">
        <label>Withdrawal Address</label>
        <input type="text" id="withdraw-address" placeholder="Enter your crypto address">
      </div>
      <div class="modal-buttons">
        <button id="confirm-withdraw" class="btn btn-success">Withdraw</button>
        <button id="cancel-withdraw" class="btn btn-danger">Cancel</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('confirm-withdraw').addEventListener('click', async () => {
    const amount = parseFloat(document.getElementById('withdraw-amount').value);
    const address = document.getElementById('withdraw-address').value.trim();
    
    if (!amount || amount <= 0) {
      showNotification('Please enter a valid amount', 'error');
      return;
    }
    
    if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
      showNotification('Please enter a valid Bitcoin address', 'error');
      return;
    }
    
    try {
      const response = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          amount,
          address,
          currency: 'BTC'
        }),
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        showNotification(`Withdrawal initiated! TXID: ${data.data.txid}`, 'success');
        modal.remove();
        initCryptoWallet(); // Refresh balance
      } else {
        throw new Error(data.message || 'Withdrawal failed');
      }
    } catch (error) {
      showNotification(error.message, 'error');
    }
  });
  
  document.getElementById('cancel-withdraw').addEventListener('click', () => {
    modal.remove();
  });
}

async function loadPlayerProfile() {
  try {
    const response = await fetch('/api/user/me', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.data && data.data.user) {
        currentUser = data.data.user;
        playerRating = currentUser.rating;
        playerStats = {
          wins: currentUser.wins,
          losses: currentUser.losses,
          draws: currentUser.draws
        };
        showPlayerProfile(currentUser);
      }
    }
  } catch (error) {
    console.error('Failed to load player profile:', error);
  }
}

function showPlayerProfile(user) {
  const existingProfile = document.querySelector('.player-profile');
  if (existingProfile) {
    existingProfile.remove();
  }
  
  const profileHtml = `
    <div class="panel-card player-profile">
      <h3 class="panel-title">PLAYER PROFILE</h3>
      <div class="profile-info">
        <div class="profile-item">
          <span>Username:</span>
          <strong>${user.username}</strong>
        </div>
        <div class="profile-item">
          <span>Rating:</span>
          <strong id="player-rating">${user.rating}</strong>
        </div>
        <div class="profile-item">
          <span>Record:</span>
          <strong>${user.wins}-${user.losses}-${user.draws}</strong>
        </div>
        <div class="profile-item">
          <span>Wallet Balance:</span>
          <strong id="wallet-balance">${user.walletBalance?.toFixed(8) || '0.00000000'} BTC</strong>
        </div>
        <div class="wallet-actions" style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <button id="deposit-crypto" class="btn btn-control" style="flex: 1;">
            <i class="fas fa-plus-circle"></i> Deposit
          </button>
          <button id="withdraw-crypto" class="btn btn-control" style="flex: 1;">
            <i class="fas fa-minus-circle"></i> Withdraw
          </button>
        </div>
      </div>
    </div>
  `;
  
  document.querySelector('.game-info-panel').insertAdjacentHTML('afterbegin', profileHtml);
  
  // Add event listeners for wallet actions
  document.getElementById('deposit-crypto')?.addEventListener('click', showCryptoDepositModal);
  document.getElementById('withdraw-crypto')?.addEventListener('click', showWithdrawModal);
}

function setupSocketListeners() {
  if (!socket) return;

  socket.on('connect', () => {
    console.log('Connected to server');
    document.getElementById('connection-status').className = 'connection-status connected';
    document.getElementById('connection-status').querySelector('span').textContent = 'Connected';
    enableUI();
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    document.getElementById('connection-status').className = 'connection-status disconnected';
    document.getElementById('connection-status').querySelector('span').textContent = 'Disconnected';
    // Don't disable UI - let reconnect handle it
  });

  socket.on('connect_error', (err) => {
    console.error('Connection error:', err);
    showNotification(`Connection error: ${err.message}`, 'error');
    document.getElementById('connection-status').className = 'connection-status disconnected';
    document.getElementById('connection-status').querySelector('span').textContent = 'Connection error';
    showNotification('Connection error. Please log in again.', 'error');
    // Don't disable UI here - let reconnect attempts happen
  });

  socket.on('redirect', handleRedirect);
  socket.on('matchFound', handleMatchFound);
  socket.on('gameFull', handleGameFull);
  socket.on('gameState', handleGameState);
  socket.on('opponentLeft', handleOpponentLeft);
  socket.on('error', handleError);
  socket.on('timeUpdate', handleTimeUpdate);
  socket.on('gameOver', handleGameOver);
  socket.on('gameStats', handleGameStats);
  socket.on('drawOffered', handleDrawOffer);
  socket.on('drawDeclined', handleDrawDeclined);
  socket.on('matchmakingStatus', handleMatchmakingStatus);
  socket.on('cheatingWarning', handleCheatingWarning);
}

function setupUIListeners() {
  console.log('Setting up UI listeners');
  
  document.getElementById('create-game')?.addEventListener('click', createGame);
  document.getElementById('join-game')?.addEventListener('click', joinGame);
  document.getElementById('join-matchmaking')?.addEventListener('click', joinMatchmaking);
  document.getElementById('leave-matchmaking')?.addEventListener('click', leaveMatchmaking);
  document.getElementById('copy-id')?.addEventListener('click', copyGameId);
  
  document.querySelectorAll('.time-option').forEach(option => {
    option.addEventListener('click', () => {
      document.querySelectorAll('.time-option').forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      const minutes = parseInt(option.dataset.minutes);
      gameTime = minutes * 60;
      whiteTime = gameTime;
      blackTime = gameTime;
      updateClocks();
      
      if (!currentGameId) {
        showNotification(`Time control set to ${minutes} minutes`);
      }
    });
  });

  document.querySelector('.time-option[data-minutes="10"]').classList.add('active');

  document.getElementById('flip-board').addEventListener('click', function() {
    if (board) {
      board.flip();
    }
  });

  document.getElementById('resign-btn').addEventListener('click', function() {
    if (currentGameId) {
      showConfirmModal(
        'Confirm Resignation',
        'Are you sure you want to resign? This will end the game.',
        () => {
          socket.emit('resign', { gameId: currentGameId });
          showNotification('You resigned the game', 'error');
          document.getElementById('status').textContent = 'Game over - You resigned';
          stopClock();
        }
      );
    }
  });

  document.getElementById('offer-draw').addEventListener('click', function() {
    if (currentGameId) {
      socket.emit('offerDraw', { gameId: currentGameId });
      showNotification('Draw offer sent to opponent');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
}

function setupTimeControls() {
  document.querySelectorAll('.time-option').forEach(option => {
    option.addEventListener('click', () => {
      document.querySelectorAll('.time-option').forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      const minutes = parseInt(option.dataset.minutes);
      gameTime = minutes * 60;
      whiteTime = gameTime;
      blackTime = gameTime;
      
      // Show wager input
      document.getElementById('wager-input-container').classList.remove('hidden-section');
      
      updateClocks();
    });
  });
}

// Game Functions
function createGame() {
  const minutes = parseInt(document.querySelector('.time-option.active').dataset.minutes);
  const wagerInput = document.getElementById('wager-input');
  currentWager = wagerInput.value ? parseInt(wagerInput.value) : 0;
  
  gameTime = minutes * 60;
  whiteTime = gameTime;
  blackTime = gameTime;
  
  showNotification(`Creating ${minutes} minute game...`);
  
  socket.emit('createGame', { 
    timeControl: gameTime,
    wager: currentWager
  }, (response) => {
    if (response?.success) {
      handleRedirect({
        id: response.gameId,
        color: response.color,
        timeControl: response.timeControl
      });
    }
  });
}

function joinMatchmaking() {
  if (!socket) {
    showNotification('Not connected to server', 'error');
    return;
  }

  socket.emit('joinMatchmaking');
  showNotification('Searching for opponent...');
  document.getElementById('join-matchmaking').style.display = 'none';
  document.getElementById('leave-matchmaking').style.display = 'inline-flex';
}

function joinGame() {
  const gameIdInput = document.getElementById('game-id');
  const gameId = gameIdInput ? gameIdInput.value.trim() : '';
  
  if (gameId) {
    showNotification(`Joining game ${gameId}...`);
    socket.emit('joinGame', { gameId }, (response) => {
      if (response && response.success) {
        handleRedirect({
          id: gameId,
          color: response.color,
          timeControl: response.timeControl
        });
        showNotification(`Joined game ${gameId} as ${response.color}`);
      } else {
        showNotification(response?.error || 'Failed to join game', 'error');
      }
    });
  } else {
    showNotification('Please enter a Game ID', 'error');
  }
}

function joinMatchmaking() {
  const minutes = parseInt(document.querySelector('.time-option.active').dataset.minutes);
  const wagerInput = document.getElementById('wager-input');
  currentWager = wagerInput.value ? parseInt(wagerInput.value) : 0;
  
  socket.emit('joinMatchmaking', {
    timeControl: minutes * 60,
    wager: currentWager
  });
  
  showNotification('Searching for opponent...');
}

// Add match confirmation handler
function handleMatchProposal(data) {
  showConfirmModal(
    'Match Found',
    `Opponent: ${data.opponent.username}<br>
    Rating: ${data.opponent.rating}<br>
    Wager: $${data.opponentWager}<br>
    Time Control: ${data.timeControl / 60} minutes`,
    () => {
      socket.emit('acceptMatch', { matchId: data.matchId });
    },
    () => {
      socket.emit('declineMatch', { matchId: data.matchId });
      showNotification('Match declined');
    },
    'Accept',
    'Decline'
  );
}

function leaveMatchmaking() {
  socket.emit('leaveMatchmaking');
  showNotification('Left matchmaking queue');
  document.getElementById('join-matchmaking').style.display = 'inline-flex';
  document.getElementById('leave-matchmaking').style.display = 'none';
}

function onDragStart(source, piece) {
  return !game.game_over() && 
         game.turn() === playerColor && 
         ((playerColor === 'w' && piece.search(/^w/) !== -1) || 
          (playerColor === 'b' && piece.search(/^b/) !== -1));
}

function onDrop(source, target) {
  try {
    // Validate move on client side first
    const move = game.move({
      from: source,
      to: target,
      promotion: 'q'
    });

    if (move === null) {
      showNotification('Invalid move!', 'error');
      return 'snapback';
    }
    
    if (currentGameId) {
      // Add timestamp to prevent cheating
      const timestamp = Date.now();
      
      // Check if it's the player's turn
      if ((playerColor === 'w' && game.turn() !== 'b') || 
          (playerColor === 'b' && game.turn() !== 'w')) {
        showNotification('Not your turn!', 'error');
        return 'snapback';
      }

      socket.emit('move', {
        gameId: currentGameId,
        from: source,
        to: target,
        promotion: 'q',
        timestamp: timestamp
      });
    }
    
    updateStatus();
    updateMoveHistory();
    lastMoveTime = Date.now();
    return true;
  } catch (err) {
    console.error('Move error:', err);
    return 'snapback';
  }
}

function onSnapEnd() {
  board.position(game.fen());
}

function updateStatus() {
  let status = '';
  
  if (game.in_checkmate()) {
    status = `Game over - ${game.turn() === 'w' ? 'Black' : 'White'} wins by checkmate!`;
    stopClock();
  } else if (game.in_draw()) {
    status = 'Game over - Draw!';
    stopClock();
  } else if (game.in_check()) {
    status = `${game.turn() === 'w' ? 'White' : 'Black'} to move (In check)`;
  } else {
    status = `${game.turn() === 'w' ? 'White' : 'Black'} to move`;
  }
  
  document.getElementById('status').textContent = status;
}

function copyGameId() {
  if (currentGameId) {
    navigator.clipboard.writeText(currentGameId)
      .then(() => {
        showNotification('Game ID copied to clipboard!');
        const copyBtn = document.getElementById('copy-id');
        copyBtn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => {
          copyBtn.innerHTML = '<i class="far fa-copy"></i>';
        }, 2000);
      })
      .catch(err => {
        showNotification('Failed to copy Game ID', 'error');
        console.error('Failed to copy:', err);
      });
  }
}

function showNotification(message, type = 'info') {
  const notification = document.getElementById('notification');
  const notificationMsg = document.getElementById('notification-message');
  
  notificationMsg.textContent = message;
  notification.className = `notification ${type}`;
  notification.style.display = 'block';
  
  setTimeout(() => {
    notification.classList.add('show');
  }, 10);
  
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => {
      notification.style.display = 'none';
    }, 300);
  }, 3000);
}

// Clock functions
function startClock() {
  if (gameInterval) clearInterval(gameInterval);
  
  gameInterval = setInterval(() => {
    if (game.turn() === 'w') {
      whiteTime = Math.max(0, whiteTime - 1);
    } else {
      blackTime = Math.max(0, blackTime - 1);
    }
    
    updateClocks();
    
    if (whiteTime <= 0 || blackTime <= 0) {
      stopClock();
      const winner = whiteTime <= 0 ? 'Black' : 'White';
      showNotification(`Time's up! ${winner} wins by timeout`, 'error');
      document.getElementById('status').textContent = `${winner} wins on time`;
    }
  }, 1000);
}

function stopClock() {
  if (gameInterval) {
    clearInterval(gameInterval);
    gameInterval = null;
  }
}

function updateClocks() {
  const whiteTimeFormatted = formatTime(whiteTime);
  const blackTimeFormatted = formatTime(blackTime);
  
  if (playerColor === 'w') {
    document.getElementById('player-clock').textContent = whiteTimeFormatted;
    document.getElementById('opponent-clock').textContent = blackTimeFormatted;
  } else {
    document.getElementById('player-clock').textContent = blackTimeFormatted;
    document.getElementById('opponent-clock').textContent = whiteTimeFormatted;
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

let currentWager = 0;
let opponentWager = 0;
let opponentUsername = '';

// Socket.io Handlers
function handleRedirect(data) {
  currentGameId = data.id;
  playerColor = data.color === 'white' ? 'w' : 'b';
  gameTime = data.timeControl || 600;
  whiteTime = gameTime;
  blackTime = gameTime;
  
  // Show game room UI
  document.querySelector('.game-room-ui').classList.remove('hidden-section');
  
  // Hide main screen elements
  document.getElementById('game-controls-section').classList.add('hidden-section');
  document.getElementById('time-control-section').classList.add('hidden-section');
  document.getElementById('player-profile-section').classList.add('hidden-section');
  
  // Update game ID display
  document.getElementById('current-game-id').textContent = currentGameId;
  
  // Set player username
  if (currentUser) {
    document.getElementById('player-username').textContent = currentUser.username;
  }
  
  // Update clocks
  updateClocks();
}

function updateOpponentInfo(opponent) {
  if (opponent) {
    opponentUsername = opponent.username;
    opponentWager = opponent.wager || 0;
    
    document.querySelector('.opponent-username').textContent = opponentUsername;
    document.querySelector('.opponent-details .wager-amount').textContent = `Wager: $${opponentWager}`;
    document.getElementById('player-wager').textContent = currentWager;
  }
}

function handleMatchFound(data) {
  currentGameId = data.gameId;
  playerColor = data.color === 'white' ? 'w' : 'b';
  gameTime = data.timeControl || 600;
  whiteTime = gameTime;
  blackTime = gameTime;
  updateClocks();
  
  // Update UI
  document.getElementById('flip-board').style.display = 'inline-flex';
  document.getElementById('resign-btn').style.display = 'inline-flex';
  document.getElementById('offer-draw').style.display = 'inline-flex';
  document.getElementById('create-game').style.display = 'none';
  document.getElementById('join-game').style.display = 'none';
  document.getElementById('game-id').style.display = 'none';
  document.getElementById('join-matchmaking').style.display = 'none';
  document.getElementById('leave-matchmaking').style.display = 'none';
  
  document.getElementById('player-color').textContent = data.color.toUpperCase();
  document.getElementById('current-game-id').textContent = currentGameId;
  document.getElementById('status').textContent = `Matched with ${data.opponent} (${data.opponentRating})`;
  
  const badge = document.getElementById('player-color-badge');
  badge.style.backgroundColor = data.color === 'white' ? 'white' : '#2D3436';
  badge.style.color = data.color === 'white' ? '#2D3436' : 'white';
}

function handleGameFull(data) {
  playerColor = data.color === 'white' ? 'w' : 'b';
  game.load(data.state.fen);
  board.position(data.state.fen, true);
  board.orientation(data.color);
  gameTime = data.timeControl || 600;
  whiteTime = gameTime;
  blackTime = gameTime;
  
  // Show in-game controls
  document.getElementById('in-game-controls').classList.remove('hidden-section');
  
  // Update opponent info if available
  if (data.opponent) {
    updateOpponentInfo(data.opponent);
  }
  
  // Start the clock
  startClock();
  updateStatus();
  
  showNotification('Game started!');
}

function handleGameState(data) {
  game.load(data.fen);
  
  if (data.lastMove) {
    board.position(data.fen, true);
    highlightMove(data.lastMove.from, data.lastMove.to);
  } else {
    board.position(data.fen);
  }
  
  updateStatus();
  updateMoveHistory();
  startClock();
  
  if (game.turn() === playerColor && !game.game_over()) {
    const moveTime = data.timestamp ? formatMoveTime(data.timestamp) : 'just now';
    showNotification(`Opponent moved ${moveTime}. Your turn!`);
  }
}

function handleTimeUpdate(data) {
  whiteTime = data.whiteTime;
  blackTime = data.blackTime;
  updateClocks();
}

function handleOpponentLeft() {
  showNotification('Opponent has left the game', 'error');
  document.getElementById('status').textContent = 'Opponent disconnected - Game paused';
  stopClock();
}

function handleError(error) {
  showNotification(error, 'error');
}

function handleGameOver(data) {
  board.draggable = false;
  
  if (data.winner) {
    const winnerText = data.winner === (playerColor === 'w' ? 'White' : 'Black') ? 
                    'You win!' : `${data.winner} wins!`;
    showNotification(`${winnerText} (${data.reason})`, 'success');
    document.getElementById('status').textContent = `${winnerText} by ${data.reason}`;
  } else {
    showNotification('Game ended in a draw!', 'info');
    document.getElementById('status').textContent = 'Game ended in a draw';
  }
  
  stopClock();
  
  if (data.finalFen) {
    game.load(data.finalFen);
    board.position(data.finalFen);
  }
  
  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'btn btn-control';
  downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download Game';
  downloadBtn.onclick = () => {
    window.open(`/api/game/${currentGameId}/pgn`, '_blank');
  };
  document.querySelector('.board-controls').appendChild(downloadBtn);
  
  setTimeout(() => {
    resetGameState();
  }, 10000);
}

function handleGameStats(data) {
  const ratingElement = document.getElementById('player-rating');
  if (ratingElement) {
    const ratingChange = playerColor === 'w' ? data.whiteRatingChange : data.blackRatingChange;
    const newRating = playerRating + ratingChange;
    
    playerRating = newRating;
    
    ratingElement.textContent = newRating;
    
    const changeElement = document.createElement('span');
    changeElement.textContent = (ratingChange >= 0 ? '+' : '') + ratingChange;
    changeElement.className = ratingChange >= 0 ? 'rating-up' : 'rating-down';
    ratingElement.appendChild(changeElement);
    
    setTimeout(() => {
      changeElement.remove();
    }, 3000);
    
    loadPlayerProfile();
  }
}

function handleDrawOffer() {
  if (drawOfferActive) return;
  drawOfferActive = true;
  
  showConfirmModal(
    'Draw Offer',
    'Your opponent is offering a draw. Do you accept?',
    () => {
      socket.emit('acceptDraw', { gameId: currentGameId });
      drawOfferActive = false;
    },
    () => {
      socket.emit('declineDraw', { gameId: currentGameId });
      showNotification('Draw offer declined', 'info');
      drawOfferActive = false;
    },
    'Accept',
    'Decline'
  );
}

function handleDrawDeclined() {
  showNotification('Your draw offer was declined', 'info');
}

function handleMatchmakingStatus(data) {
  if (data.inQueue) {
    document.getElementById('join-matchmaking').style.display = 'none';
    document.getElementById('leave-matchmaking').style.display = 'inline-flex';
  } else {
    document.getElementById('join-matchmaking').style.display = 'inline-flex';
    document.getElementById('leave-matchmaking').style.display = 'none';
  }
}

function handleCheatingWarning(data) {
  showNotification(`Warning: ${data.message}`, 'warning');
}

// Helper Functions
function highlightMove(from, to) {
  $('.square-55d63').removeClass('highlight-move');
  $(`#${from}`).addClass('highlight-move');
  $(`#${to}`).addClass('highlight-move');
  
  setTimeout(() => {
    $('.square-55d63').removeClass('highlight-move');
  }, 1000);
}

function formatMoveTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  return `${hours} hours ago`;
}

function updateMoveHistory() {
  const moveHistory = document.getElementById('move-history');
  moveHistory.innerHTML = '';
  
  const moves = game.history({ verbose: true });
  const movePairs = [];
  
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push({
      white: moves[i],
      black: moves[i + 1] || null
    });
  }
  
  movePairs.forEach((pair, index) => {
    const moveEntry = document.createElement('div');
    moveEntry.className = 'move-entry';
    
    const moveNumber = document.createElement('span');
    moveNumber.className = 'move-number';
    moveNumber.textContent = `${index + 1}.`;
    
    const whiteMove = document.createElement('span');
    whiteMove.className = 'move-white';
    whiteMove.textContent = pair.white.san;
    whiteMove.onclick = () => highlightMove(pair.white.from, pair.white.to);
    
    moveEntry.appendChild(moveNumber);
    moveEntry.appendChild(whiteMove);
    
    if (pair.black) {
      const blackMove = document.createElement('span');
      blackMove.className = 'move-black';
      blackMove.textContent = pair.black.san;
      blackMove.onclick = () => highlightMove(pair.black.from, pair.black.to);
      moveEntry.appendChild(blackMove);
    }
    
    moveHistory.appendChild(moveEntry);
  });
  
  moveHistory.scrollTop = moveHistory.scrollHeight;
}

function updateTimeControlDisplay() {
  const timeOptions = document.querySelectorAll('.time-option');
  timeOptions.forEach(option => {
    option.classList.remove('active', 'white', 'black');
    const minutes = parseInt(option.dataset.minutes);
    if (minutes * 60 === gameTime) {
      option.classList.add('active');
      if (playerColor === 'w') {
        option.classList.add('white');
      } else {
        option.classList.add('black');
      }
    }
  });
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  if (currentTheme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('theme-toggle').innerHTML = '<i class="fas fa-moon"></i>';
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('theme-toggle').innerHTML = '<i class="fas fa-sun"></i>';
    localStorage.setItem('theme', 'dark');
  }
}

function resetGameState() {
  currentGameId = null;
  playerColor = null;
  gameTime = 10 * 60;
  whiteTime = gameTime;
  blackTime = gameTime;
  stopClock();
  updateClocks();
  
  // Reset UI
  document.getElementById('flip-board').style.display = 'none';
  document.getElementById('resign-btn').style.display = 'none';
  document.getElementById('offer-draw').style.display = 'none';
  document.getElementById('create-game').style.display = 'inline-flex';
  document.getElementById('join-game').style.display = 'inline-flex';
  document.getElementById('game-id').style.display = 'block';
  document.getElementById('join-matchmaking').style.display = 'inline-flex';
  document.getElementById('leave-matchmaking').style.display = 'none';
  
  document.getElementById('player-color').textContent = 'WAITING';
  document.getElementById('current-game-id').textContent = '-----';
  document.getElementById('status').textContent = 'Create or join a game to begin';
  
  const badge = document.getElementById('player-color-badge');
  badge.style.backgroundColor = '';
  badge.style.color = '';
  
  // Reset board
  game = new Chess();
  board.position('start');
  board.draggable = true;
  
  // Remove download button if exists
  const downloadBtn = document.querySelector('.board-controls .btn-control:last-child');
  if (downloadBtn && downloadBtn.textContent.includes('Download')) {
    downloadBtn.remove();
  }
  
  // Reset time control display
  updateTimeControlDisplay();
}

function showConfirmModal(title, message, confirmCallback, cancelCallback, confirmText = 'Confirm', cancelText = 'Cancel') {
  const modal = document.createElement('div');
  modal.className = 'modal show';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>${title}</h3>
      <p>${message}</p>
      <div class="modal-buttons">
        <button id="confirm-action" class="btn btn-success">${confirmText}</button>
        <button id="cancel-action" class="btn btn-danger">${cancelText}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  
  document.getElementById('confirm-action').addEventListener('click', function() {
    if (confirmCallback) confirmCallback();
    modal.remove();
  });
  
  document.getElementById('cancel-action').addEventListener('click', function() {
    if (cancelCallback) cancelCallback();
    modal.remove();
  });
}

// Auth Functions
async function checkAuthStatus() {
  try {
    // First check localStorage, then cookies
    const token = localStorage.getItem('jwt') || getCookie('jwt');
    
    if (!token || token === 'loggedout') {
      console.log('No valid token found');
      return false;
    }
    
    const response = await fetch('/api/user/me', {
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.data?.user) {
        // Store the token in localStorage for future use
        localStorage.setItem('jwt', token);
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Auth check failed:', error);
    return false;
  }
}

function showAuthModal() {
  document.querySelector('.auth-modal').style.display = 'flex';
  setTimeout(() => {
    document.querySelector('.auth-modal').classList.add('show');
  }, 10);
  
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
  document.getElementById('login-form').classList.add('active');
  
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

function hideAuthModal() {
  document.querySelector('.auth-modal').classList.remove('show');
  setTimeout(() => {
    document.querySelector('.auth-modal').style.display = 'none';
  }, 300);
}

function setupAuthFormHandlers() {
  // Close modal handler
  document.getElementById('close-auth-modal')?.addEventListener('click', hideAuthModal);

  // Tab switching functionality
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', function() {
      const tabName = this.dataset.tab;
      
      // Update active tab
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      
      // Update active form
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      document.getElementById(`${tabName}-form`).classList.add('active');
    });
  });

  // Password strength indicator
  document.getElementById('signup-password')?.addEventListener('input', function() {
    const strengthBars = document.querySelectorAll('.strength-bar');
    const strengthText = document.querySelector('.strength-text');
    const password = this.value;
    
    // Reset
    strengthBars.forEach(bar => {
      bar.style.backgroundColor = '#ddd';
      bar.style.width = '0%';
    });
    
    if (password.length === 0) {
      strengthText.textContent = 'Password strength';
      return;
    }
    
    // Calculate strength
    let strength = 0;
    if (password.length >= 8) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[0-9]/.test(password)) strength++;
    if (/[^A-Za-z0-9]/.test(password)) strength++;
    
    // Update UI
    for (let i = 0; i < strength; i++) {
      strengthBars[i].style.width = '100%';
      strengthBars[i].style.backgroundColor = 
        strength < 2 ? '#ff4d4d' : 
        strength < 4 ? '#ffcc00' : '#00cc66';
    }
    
    strengthText.textContent = 
      strength < 2 ? 'Weak' : 
      strength < 4 ? 'Medium' : 'Strong';
  });

  // Login handler
  document.getElementById('login-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;
    
    if (!email || !password) {
      showNotification('Please enter both email and password', 'error');
      return;
    }

    const loginBtn = document.getElementById('login-btn');
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
        credentials: 'include'
      });

      // First check if response is JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(text || 'Login failed');
      }

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }

      // Store the token in localStorage
      if (data.token) {
        localStorage.setItem('jwt', data.token);
      }

      showNotification('Login successful!', 'success');
      hideAuthModal();
      document.querySelector('.game-container').style.display = 'grid';
      initGame();
    } catch (error) {
      console.error('Login error:', error);
      showNotification(error.message || 'Login failed. Please try again.', 'error');
      
      // If 401 specifically, reset form
      if (error.message.includes('401') || error.message.includes('Incorrect')) {
        document.getElementById('login-password').value = '';
      }
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });
  
  // Forgot password handler
  document.getElementById('forgot-password')?.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('reset-form').classList.add('active');
  });
  
  // Back to login from reset
  document.getElementById('back-to-login')?.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('login-form').classList.add('active');
    document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
  });
  
  // Reset password handler
  document.getElementById('reset-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('reset-email').value;
    
    if (!email) {
      showNotification('Please enter your email', 'error');
      return;
    }
    
    const resetBtn = document.getElementById('reset-btn');
    resetBtn.disabled = true;
    resetBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email }),
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        showNotification(data.message || 'Password reset instructions sent', 'success');
      } else {
        showNotification(data.message || 'Failed to send reset instructions', 'error');
      }
    } catch (error) {
      showNotification('Network error. Please try again.', 'error');
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Send Reset Link';
    }
  });
  
  // Signup handler
  document.getElementById('signup-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('signup-email').value;
    const phone = document.getElementById('signup-phone').value;
    const username = document.getElementById('signup-username').value;
    const password = document.getElementById('signup-password').value;
    const countryCode = document.getElementById('signup-country').value;

    if (!email || !phone || !username || !password || !countryCode) {
      showNotification('Please fill all fields', 'error');
      return;
    }

    const signupBtn = document.getElementById('signup-btn');
    signupBtn.disabled = true;
    signupBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing Up...';

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          email, 
          phone, 
          username, 
          password, 
          countryCode 
        }),
        credentials: 'include'
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'Signup failed');
      }

      showNotification('Verification code sent to your phone!', 'success');
      
      // Store the token if received
      if (data.token) {
        localStorage.setItem('jwt', data.token);
      }

      // Switch to verification form
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
      document.getElementById('verify-form').classList.add('active');
      
      startResendTimer();
    } catch (error) {
      console.error('Signup error:', error);
      showNotification(error.message || 'Signup failed. Please try again.', 'error');
    } finally {
      signupBtn.disabled = false;
      signupBtn.textContent = 'Sign Up';
    }
  });
  
  // Verification handler
  document.getElementById('verify-btn')?.addEventListener('click', async () => {
    const code = document.getElementById('verify-code').value;
    
    if (!code || !/^\d{6}$/.test(code)) {
      showNotification('Please enter a valid 6-digit code', 'error');
      return;
    }
    
    const verifyBtn = document.getElementById('verify-btn');
    verifyBtn.disabled = true;
    verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
    
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code }),
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        showNotification('Account verified! Welcome to ChessBet', 'success');
        hideAuthModal();
        document.querySelector('.game-container').style.display = 'grid';
        initGame();
        enableUI(); // Explicitly enable UI after verification
      } else {
        showNotification(data.message || 'Verification failed', 'error');
      }
    } catch (error) {
      showNotification('Network error. Please try again.', 'error');
    } finally {
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify';
    }
  });
  
  // Resend code handler
  document.getElementById('resend-code')?.addEventListener('click', async () => {
    const email = document.getElementById('signup-email').value;
    if (!email) {
      showNotification('Please enter your email to resend the code', 'error');
      return;
    }
    
    const resendBtn = document.getElementById('resend-code');
    resendBtn.disabled = true;
    resendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    
    try {
      const response = await fetch('/api/auth/resend-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email }),
        credentials: 'include'
      });
      
      const data = await response.json();
      
      if (response.ok) {
        showNotification('New verification code sent!', 'success');
        startResendTimer();
      } else {
        showNotification(data.message || 'Failed to resend code', 'error');
      }
    } catch (error) {
      showNotification('Network error. Please try again.', 'error');
    } finally {
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend Code';
    }
  });
}

function startResendTimer() {
  const resendBtn = document.getElementById('resend-code');
  const timerElement = document.getElementById('resend-timer');
  
  if (resendTimerInterval) clearInterval(resendTimerInterval);
  
  resendBtn.disabled = true;
  let seconds = 30;
  
  timerElement.style.display = 'inline';
  timerElement.textContent = `Resend available in ${seconds}s`;
  
  resendTimerInterval = setInterval(() => {
    seconds--;
    timerElement.textContent = `Resend available in ${seconds}s`;
    
    if (seconds <= 0) {
      clearInterval(resendTimerInterval);
      resendBtn.disabled = false;
      timerElement.style.display = 'none';
    }
  }, 1000);
}

async function logout() {
  try {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    
    // Clear both localStorage and cookies
    localStorage.removeItem('jwt');
    document.cookie = 'jwt=loggedout; path=/; max-age=0';

    const response = await fetch('/api/auth/logout', {
      credentials: 'include'
    });
    
    // Check if logout was successful
    if (response.ok) {
      showNotification('Logged out successfully', 'success');
      resetGameState();
      document.querySelector('.game-container').style.display = 'none';
      showAuthModal();
      
      // Force a hard refresh to clear any state
      setTimeout(() => {
        window.location.reload(true);
      }, 1000);
    } else {
      throw new Error('Logout failed');
    }
  } catch (err) {
    console.error('Logout failed:', err);
    showNotification('Logout failed', 'error');
  }
}


function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}