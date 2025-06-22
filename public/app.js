document.addEventListener('DOMContentLoaded', function() {
    // Theme toggle
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle.addEventListener('click', toggleTheme);
    
    // Check for saved theme preference
    if (localStorage.getItem('theme') === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
    }

    const socket = io();
    console.log('Socket.io initialized:', socket.connected);

    let game;
    let board;
    let currentGameId = null;
    let playerColor = null;
    let gameTime = 10 * 60;
    let whiteTime = gameTime;
    let blackTime = gameTime;
    let gameInterval;
    let lastMoveTime = null;

    // Initialize chessboard
    function initChessboard() {
        board = Chessboard('board', {
            draggable: true,
            position: 'start',
            pieceTheme: 'https://lichess1.org/assets/pieces/merida/{piece}.png',
            onDragStart: onDragStart,
            onDrop: onDrop,
            onSnapEnd: onSnapEnd,
            showNotation: true,
            sparePieces: false,
            appearSpeed: 100,
            moveSpeed: 200,
            snapbackSpeed: 100
        });
        
        setTimeout(() => {
            board.position('start');
        }, 100);
    }

    // Initialize game
    function initGame() {
        game = new Chess();
        initChessboard();
        updateClocks();
    }

    // DOM Elements
    const createGameBtn = document.getElementById('create-game');
    const joinGameBtn = document.getElementById('join-game');
    const copyIdBtn = document.getElementById('copy-id');
    const timeOptions = document.querySelectorAll('.time-option');

    // Initialize the game
    initGame();

    // Event Listeners
    createGameBtn.addEventListener('click', createGame);
    joinGameBtn.addEventListener('click', joinGame);
    copyIdBtn.addEventListener('click', copyGameId);
    
    timeOptions.forEach(option => {
        option.addEventListener('click', () => {
            timeOptions.forEach(opt => opt.classList.remove('active'));
            option.classList.add('active');
            const minutes = parseInt(option.dataset.minutes);
            gameTime = minutes * 60;
            whiteTime = gameTime;
            blackTime = gameTime;
            updateClocks();
        });
    });

    // Socket.io Event Listeners
    socket.on('connect', () => {
        console.log('Connected to server');
    });

    socket.on('redirect', handleRedirect);
    socket.on('gameFull', handleGameFull);
    socket.on('gameState', handleGameState);
    socket.on('opponentLeft', handleOpponentLeft);
    socket.on('error', handleError);
    socket.on('timeUpdate', handleTimeUpdate);
    socket.on('gameOver', handleGameOver);
    socket.on('drawOffered', handleDrawOffer);
    socket.on('drawDeclined', handleDrawDeclined);

    // Game Functions
    function createGame() {
        showNotification('Creating private game...');
        socket.emit('createGame', { timeControl: gameTime });
    }

    function joinGame() {
        const gameId = document.getElementById('game-id').value.trim();
        if (gameId) {
            showNotification(`Joining game ${gameId}...`);
            socket.emit('joinGame', { id: gameId });
        } else {
            showNotification('Please enter a Game ID', 'error');
        }
    }

    function onDragStart(source, piece) {
        return !game.game_over() && 
               game.turn() === playerColor && 
               ((playerColor === 'w' && piece.search(/^w/) !== -1) || 
                (playerColor === 'b' && piece.search(/^b/) !== -1));
    }

    function onDrop(source, target) {
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
            socket.emit('move', {
                gameId: currentGameId,
                from: source,
                to: target,
                promotion: 'q',
                timestamp: Date.now()
            });
        }
        
        updateStatus();
        updateMoveHistory();
        lastMoveTime = Date.now();
        return true;
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
        document.getElementById('white-clock').textContent = formatTime(whiteTime);
        document.getElementById('black-clock').textContent = formatTime(blackTime);
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    // Socket.io Handlers
    function handleRedirect(data) {
        currentGameId = data.id;
        playerColor = data.color === 'white' ? 'w' : 'b';
        gameTime = data.timeControl || 600;
        whiteTime = gameTime;
        blackTime = gameTime;
        updateClocks();
        
        document.getElementById('player-color').textContent = data.color.toUpperCase();
        document.getElementById('current-game-id').textContent = currentGameId;
        
        const badge = document.getElementById('player-color-badge');
        badge.style.backgroundColor = data.color === 'white' ? 'white' : '#2D3436';
        badge.style.color = data.color === 'white' ? '#2D3436' : 'white';
        
        board.orientation(data.color);
        showNotification(`Game created! Your ID: ${currentGameId}`);
    }

    function handleGameFull(data) {
        playerColor = data.color === 'white' ? 'w' : 'b';
        game.load(data.state.fen);
        board.position(data.state.fen, true);
        board.orientation(data.color);
        gameTime = data.timeControl || 600;
        whiteTime = gameTime;
        blackTime = gameTime;
        updateClocks();
        startClock();
        
        document.getElementById('player-color').textContent = data.color.toUpperCase();
        const badge = document.getElementById('player-color-badge');
        badge.style.backgroundColor = data.color === 'white' ? 'white' : '#2D3436';
        badge.style.color = data.color === 'white' ? '#2D3436' : 'white';
        
        updateStatus();
        showNotification('Game started! Your turn: ' + (playerColor === 'w' ? 'White' : 'Black'));
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
        if (data.winner) {
            showNotification(`${data.winner} wins by ${data.reason}!`, 'success');
            document.getElementById('status').textContent = `${data.winner} wins by ${data.reason}`;
        } else {
            showNotification('Game ended in a draw!', 'info');
            document.getElementById('status').textContent = 'Game ended in a draw';
        }
        stopClock();
    }

    function handleDrawOffer() {
        const modal = document.getElementById('draw-modal');
        modal.classList.add('show');
        
        document.getElementById('accept-draw').onclick = function() {
            socket.emit('acceptDraw', { gameId: currentGameId });
            modal.classList.remove('show');
        };
        
        document.getElementById('decline-draw').onclick = function() {
            socket.emit('declineDraw', { gameId: currentGameId });
            modal.classList.remove('show');
            showNotification('Draw offer declined', 'info');
        };
    }

    function handleDrawDeclined() {
        showNotification('Your draw offer was declined', 'info');
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

    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        if (currentTheme === 'dark') {
            document.documentElement.removeAttribute('data-theme');
            themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
            localStorage.setItem('theme', 'light');
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
            localStorage.setItem('theme', 'dark');
        }
    }

    // Flip board
    document.getElementById('flip-board').addEventListener('click', function() {
        if (board) {
            board.flip();
        }
    });

    // Resign game
    document.getElementById('resign-btn').addEventListener('click', function() {
        if (currentGameId && confirm('Are you sure you want to resign?')) {
            socket.emit('resign', { gameId: currentGameId });
            showNotification('You resigned the game', 'error');
            document.getElementById('status').textContent = 'Game over - You resigned';
            stopClock();
        }
    });

    // Offer draw
    document.getElementById('offer-draw').addEventListener('click', function() {
        if (currentGameId) {
            socket.emit('offerDraw', { gameId: currentGameId });
            showNotification('Draw offer sent to opponent');
        }
    });
});