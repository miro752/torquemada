/**
 * Main entry point for the checkers web app
 * Wires together: GameState, SearchManager, TurnController, MoveInput, BoardUI
 */

const _v = new URL(import.meta.url).searchParams.get('v') || '';
const _q = _v ? `?v=${_v}` : '';
const { getEngine } = await import(`./engine-api.js${_q}`);
const { GameState } = await import(`./game-state.js${_q}`);
const { SearchManager } = await import(`./search-manager.js${_q}`);
const { TurnController } = await import(`./turn-controller.js${_q}`);
const { MoveInput } = await import(`./move-input.js${_q}`);
const { BoardUI } = await import(`./board-ui.js${_q}`);
const { playMoveSound } = await import(`./sound.js${_q}`);
const { TablebaseLoader, loadNNModelFile } = await import(`./tablebase-loader.js${_q}`);
const { initGameStorage, pushGames, upsertGame, saveGame, getGames, setGames, deleteGame, clearGames, computeStats } = await import(`./game-storage.js${_q}`);
await initGameStorage();
const FG = await import(`./fastgame.js${_q}`);
const { isSoundEnabled, setSoundEnabled } = await import(`./sound.js${_q}`);

// --- Module instances (set during init) ---
let engine = null;
let gameState = null;
let searchManager = null;
let turnController = null;
let moveInput = null;
let boardUI = null;
let tablebaseLoader = null;

// Edit mode state
let editMode = false;
let editPieceType = 'empty';  // 'empty', 'white-man', 'white-king', 'black-man', 'black-king'
let editWhiteToMove = true;
let editBoard = { white: 0, black: 0, kings: 0 };

// Analysis display state
let showAnalysis = false;

// Match play state
let matchPlayActive = false;
let matchStats = { wins: 0, draws: 0, losses: 0 };
const MATCH_STATS_KEY = 'torquemada-match-stats';
let drawOfferResolve = null;

// Opening book state
let useBook = true;

// Opening names: maps "white,black,kings" position key to opening name
const openingNames = new Map();

// Saved options for restoring after match play
let savedPonder = false;
let savedShowAnalysis = false;
let savedUseBook = true;

/**
 * Initialize the application
 */
async function init() {
    const canvas = document.getElementById('board');
    const statusEl = document.getElementById('status');
    const loadingEl = document.getElementById('loading');
    const gameContainerEl = document.getElementById('game-container');

    if (loadingEl) loadingEl.style.display = 'flex';
    if (gameContainerEl) gameContainerEl.style.display = 'none';

    try {
        // Initialize engine
        updateLoadingStatus('Iniciando motor...');
        engine = getEngine();
        await engine.init();

        // Initialize tablebase loader
        try {
            tablebaseLoader = new TablebaseLoader();
            await tablebaseLoader.init();
        } catch (err) {
            console.warn('OPFS not available:', err);
        }

        // Load NN model
        updateLoadingStatus('Chargement du réseau de neurones...');
        try {
            const nnData = await loadNNModelFile('./models/model_007.bin');
            await engine.loadNNModel(nnData);
        } catch (err) {
            console.warn('Could not load NN model:', err);
        }

        // Load opening book
        try {
            const bookResponse = await fetch('./opening-a822ebc72d1b.cbook');
            if (bookResponse.ok) {
                const bookText = await bookResponse.text();
                await engine.loadOpeningBook(bookText);
                console.log('Opening book loaded');
            }
        } catch (err) {
            console.warn('Could not load opening book:', err);
        }

        // Load opening names
        try {
            const resp = await fetch('./openings.txt');
            if (resp.ok) {
                const text = await resp.text();
                for (const line of text.split('\n')) {
                    if (!line.trim()) continue;
                    const match = line.match(/^([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.+)$/);
                    if (match) {
                        const w = parseInt(match[1], 16);
                        const b = parseInt(match[2], 16);
                        const k = parseInt(match[3], 16);
                        openingNames.set(`${w},${b},${k}`, match[4]);
                    }
                }
                console.log('Opening names loaded:', openingNames.size);
            }
        } catch (err) {
            console.warn('Could not load opening names:', err);
        }

        // Create modules
        updateLoadingStatus('Démarrage de la partie...');
        boardUI = new BoardUI(canvas);
        gameState = new GameState(engine);
        searchManager = new SearchManager(engine);
        turnController = new TurnController(gameState, searchManager);
        moveInput = new MoveInput();

        // Wire events BEFORE init so we don't miss the initial legalMovesUpdated
        wireGameStateEvents();
        wireSearchManagerEvents();
        wireTurnControllerEvents();
        wireBoardClicks();

        // Initialize
        await gameState.init();
        turnController.init();

        // Restore preferences
        await restoreSavedPreferences();

        // Set up UI event handlers
        setupEventHandlers();
        updateBoardFromState();
        updateModeButtons();
        updateOptionsButtons();
        updateUndoRedoButtons();
        updatePlayButton();

        // Update status
        statusEl.textContent = 'Nouvelle partie';

        // Hide loading, show game
        if (loadingEl) loadingEl.style.display = 'none';
        if (gameContainerEl) gameContainerEl.style.display = 'flex';

        const status = await engine.getStatus();
        console.log('Engine status:', status);

    } catch (err) {
        console.error('Initialization failed:', err);
        updateLoadingStatus(`Erreur : ${err.message}`);
    }
}

// --- Event wiring ---

function wireGameStateEvents() {
    gameState.addEventListener('newGame', (e) => {
        updateBoardFromState();
        clearInputState();
        boardUI.setSelected(null);
        boardUI.clearLastMove();
        clearSearchInfo();
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        searchManager.clearPV();
        updateOpeningName(null);
        updateStatus('');
    });

    gameState.addEventListener('move', (e) => {
        const { move, board, gameOver } = e.detail;
        updateBoardFromState();
        clearInputState(false);
        boardUI.setLastMove(move.from, move.to, move.notation);
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        updateOpeningName(board);
        if (!gameOver) {
            updateStatus('');
        }
    });

    gameState.addEventListener('undo', (e) => {
        const { board, undoneMove } = e.detail;
        updateBoardFromState();
        clearInputState();
        boardUI.setSelected(null);
        // Restore last move highlight if there's still history
        if (gameState.history.length > 0) {
            const prevMove = gameState.history[gameState.history.length - 1].move;
            boardUI.setLastMove(prevMove.from, prevMove.to, prevMove.notation);
        }
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        searchManager.clearPV();
        updateOpeningName(board);
        updateStatus('');
    });

    gameState.addEventListener('redo', (e) => {
        const { board, move } = e.detail;
        updateBoardFromState();
        clearInputState();
        boardUI.setSelected(null);
        boardUI.setLastMove(move.from, move.to, move.notation);
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        searchManager.clearPV();
        updateOpeningName(board);
        updateStatus('');
    });

    gameState.addEventListener('positionChanged', (e) => {
        updateBoardFromState();
        clearInputState();
        boardUI.setSelected(null);
        boardUI.clearLastMove();
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        updateOpeningName(null);
        updateStatus('');
    });

    gameState.addEventListener('gameLoaded', (e) => {
        updateBoardFromState();
        clearInputState();
        boardUI.setSelected(null);
        boardUI.clearLastMove();
        updateMoveHistory();
        updateUndoRedoButtons();
        updatePlayButton();
        updateOpeningName(gameState.board);
        updateStatus('Partie chargée');
    });

    gameState.addEventListener('legalMovesUpdated', (e) => {
        const { moves } = e.detail;
        moveInput.setLegalMoves(moves);
        boardUI.setLegalMoves(moves);
    });

    gameState.addEventListener('gameOver', (e) => {
        const { winner, reason } = e.detail;
        showGameOver(winner, reason);
        updatePlayButton();
    });
}

function wireSearchManagerEvents() {
    searchManager.addEventListener('searchInfo', (e) => {
        updateSearchInfo(e.detail);
        updatePlayButton();
    });

    searchManager.addEventListener('searchStart', (e) => {
        if (e.detail.type === 'think') {
            updateStatus('Le moteur réfléchit...');
        }
        updatePlayButton();
        updateUndoRedoButtons();
    });

    searchManager.addEventListener('searchEnd', () => {
        updatePlayButton();
        updateUndoRedoButtons();
    });

    searchManager.addEventListener('timeUpdate', (e) => {
        updateTimeDisplay(e.detail.secondsLeft);
    });
}

function wireTurnControllerEvents() {
    turnController.addEventListener('humanColorChanged', () => {
        updateModeButtons();
        updatePlayButton();
    });

    turnController.addEventListener('drawOffer', (e) => {
        const { resolve } = e.detail;
        drawOfferResolve = resolve;
        document.getElementById('draw-offer-dialog').style.display = 'flex';
    });

    // Engine move: animate + sound + commit, then signal done
    turnController.addEventListener('engineMove', async (e) => {
        const { move, resolve } = e.detail;
        await animateAndMakeMove(move, true);  // always animate engine moves
        resolve();
    });
}

function wireBoardClicks() {
    boardUI.onClick = async (square) => {
        if (editMode) {
            handleEditClick(square);
            return;
        }

        if (gameState.gameOver) return;
        if (searchManager.state === 'thinking') return;
        if (!turnController.isHumanTurn()) return;

        // Stop pondering so the worker is free
        if (searchManager.state === 'pondering') {
            await searchManager.abort();
        }

        const result = moveInput.handleClick(square);

        if (!result) {
            // Click didn't match — clear highlights
            clearInputState();
            return;
        }

        if (result.move) {
            await animateAndMakeMove(result.move, result.animate);
        } else if (result.highlights) {
            applyHighlights(result.highlights);
        }
    };
}

// --- Board / UI helpers ---

function updateBoardFromState() {
    if (!gameState.board) return;
    const b = gameState.board;
    boardUI.setPosition(b.white, b.black, b.kings, b.whiteToMove);
}

function clearInputState(render = true) {
    moveInput.clear();
    boardUI.selectedSquare = null;
    boardUI.partialPath = [];
    boardUI.outOfOrderClicks = [];
    boardUI.flexibleHighlights = [];
    boardUI.lastMove = null;
    if (render) {
        boardUI.setLegalMoves(gameState.legalMoves);
    } else {
        boardUI.legalMoves = gameState.legalMoves;
    }
}

function applyHighlights(highlights) {
    boardUI.legalMoves = [];  // suppress default green highlights
    boardUI.outOfOrderClicks = highlights.selected;
    boardUI.flexibleHighlights = highlights.valid;
    if (highlights.partialPath.length > 0) {
        boardUI.selectedSquare = highlights.partialPath[0];
        boardUI.partialPath = highlights.partialPath;
    } else {
        boardUI.selectedSquare = null;
        boardUI.partialPath = [];
    }
    boardUI.render();
}

/**
 * Animate multi-jump moves step-by-step, then commit the move.
 */
async function animateAndMakeMove(move, animate) {
    if (animate && move.path && move.path.length > 2) {
        for (let i = 1; i < move.path.length; i++) {
            const partialPath = move.path.slice(0, i + 1);
            boardUI.setPartialPath(partialPath);
            boardUI.render();
            playMoveSound();
            await sleep(200);
        }
    } else {
        playMoveSound();
    }
    await gameState.makeMove(move);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getOpeningName(board) {
    if (!board) return null;
    const key = `${board.white},${board.black},${board.kings}`;
    return openingNames.get(key) || null;
}

function updateStatus(message) {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

function updateOpeningName(board) {
    const el = document.getElementById('opening-name');
    if (el) el.textContent = getOpeningName(board) || '';
}

function updateLoadingStatus(message) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = message;
}

// --- Mode buttons ---

function updateModeButtons() {
    const btnEngineWhite = document.getElementById('btn-engine-white');
    const btnEngineBlack = document.getElementById('btn-engine-black');
    const btnTwoPlayer = document.getElementById('btn-two-player');

    if (!btnEngineWhite || !btnEngineBlack || !btnTwoPlayer) return;

    btnEngineWhite.classList.remove('active');
    btnEngineBlack.classList.remove('active');
    btnTwoPlayer.classList.remove('active');

    switch (turnController.humanColor) {
        case 'black':
            btnEngineWhite.classList.add('active');
            break;
        case 'white':
            btnEngineBlack.classList.add('active');
            break;
        case 'both':
            btnTwoPlayer.classList.add('active');
            break;
    }
}

// --- Preferences ---

const PREFS_KEY = 'torquemada-preferences';

function savePreferences() {
    const prefs = {
        ponder: turnController.ponderEnabled,
        showAnalysis,
        useBook,
        sound: isSoundEnabled(),
    };
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function loadPreferences() {
    try {
        const data = localStorage.getItem(PREFS_KEY);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

async function restoreSavedPreferences() {
    const prefs = loadPreferences();
    if (!prefs) return;

    if (prefs.ponder) await togglePondering(true);
    if (prefs.showAnalysis) toggleShowAnalysis(true);
    if (prefs.useBook === false) {
        useBook = false;
        engine.setUseBook(false);
    }
    setSoundEnabled(prefs.sound !== false);
}

function updateOptionsButtons() {
    const chkPonder = document.getElementById('chk-ponder');
    const chkUseBook = document.getElementById('chk-use-book');
    const chkShowAnalysis = document.getElementById('chk-show-analysis');

    if (chkPonder) chkPonder.checked = turnController.ponderEnabled;
    if (chkUseBook) chkUseBook.checked = useBook;
    if (chkShowAnalysis) chkShowAnalysis.checked = showAnalysis;

    const chkSound = document.getElementById('chk-sound');
    if (chkSound) chkSound.checked = isSoundEnabled();
}

// --- Undo/Redo ---

function updateUndoRedoButtons() {
    if (!gameState) return;
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    const { canUndo, canRedo } = gameState.getUndoRedoState();
    const thinking = searchManager.state === 'thinking';

    // Undo is allowed during thinking (aborts search first)
    if (undoBtn) undoBtn.disabled = !canUndo;
    // Redo is blocked during thinking (engine is about to play)
    if (redoBtn) redoBtn.disabled = !canRedo || thinking;
}

// --- Edit Mode ---

async function enterEditMode() {
    await searchManager.abort();
    clearSearchInfo();
    const evalBar = document.getElementById('eval-bar');
    if (evalBar) evalBar.style.visibility = 'hidden';
    editMode = true;

    const board = gameState.board;
    editBoard = { white: board.white, black: board.black, kings: board.kings };
    editWhiteToMove = board.whiteToMove;

    editPieceType = 'empty';
    updatePieceSelector();

    document.getElementById('game-controls').style.display = 'none';
    document.getElementById('edit-controls').style.display = 'block';
    document.querySelectorAll('.controls-section .control-group:not(#game-controls):not(#edit-controls)').forEach(el => {
        el.style.display = 'none';
    });

    updateSideToMoveButtons();
    boardUI.setLegalMoves([]);
    boardUI.setSelected(null);
    updatePlayButton();
}

async function exitEditMode() {
    editMode = false;

    // Temporarily disable auto-play so setPosition doesn't trigger engine
    const savedAutoPlay = turnController.autoPlay;
    turnController.autoPlay = false;
    searchManager.resetTimeBank();
    turnController.drawDeclined = false;
    await gameState.setPosition(editBoard.white, editBoard.black, editBoard.kings, editWhiteToMove);
    turnController.autoPlay = savedAutoPlay;

    // Set player assignments
    if (turnController.humanColor !== 'both') {
        turnController.setHumanColor(editWhiteToMove ? 'white' : 'black');
    }

    document.getElementById('game-controls').style.display = 'flex';
    document.getElementById('edit-controls').style.display = 'none';
    document.querySelectorAll('.controls-section .control-group:not(#game-controls):not(#edit-controls)').forEach(el => {
        el.style.display = 'block';
    });

    if (showAnalysis) {
        const evalBar = document.getElementById('eval-bar');
        if (evalBar) evalBar.style.visibility = '';
    }

    updateMoveHistory();
    updateUndoRedoButtons();
    updateModeButtons();
    updatePlayButton();
}

function getPieceAt(square) {
    const bit = 1 << (square - 1);
    const isWhite = (editBoard.white & bit) !== 0;
    const isBlack = (editBoard.black & bit) !== 0;
    const isKing = (editBoard.kings & bit) !== 0;

    if (isWhite && isKing) return 'white-king';
    if (isWhite) return 'white-man';
    if (isBlack && isKing) return 'black-king';
    if (isBlack) return 'black-man';
    return 'empty';
}

function nextPieceType(current) {
    const order = ['empty', 'white-man', 'white-king', 'black-man', 'black-king'];
    const idx = order.indexOf(current);
    return order[(idx + 1) % order.length];
}

function updatePieceSelector() {
    document.querySelectorAll('.piece-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.piece === editPieceType);
    });
}

function isInvalidPlacement(pieceType, square) {
    // White men can't be placed on rank 8 (squares 29-32) — they would promote
    if (pieceType === 'white-man' && square >= 29) return true;
    // Black men can't be placed on rank 1 (squares 1-4) — they would promote
    if (pieceType === 'black-man' && square <= 4) return true;
    return false;
}

function handleEditClick(square) {
    if (!editMode || square < 1 || square > 32) return;

    const bit = 1 << (square - 1);

    const currentPiece = getPieceAt(square);
    if (currentPiece === editPieceType || isInvalidPlacement(editPieceType, square)) {
        editPieceType = nextPieceType(editPieceType);
        if (isInvalidPlacement(editPieceType, square)) {
            editPieceType = nextPieceType(editPieceType);
        }
        updatePieceSelector();
    }

    editBoard.white &= ~bit;
    editBoard.black &= ~bit;
    editBoard.kings &= ~bit;

    switch (editPieceType) {
        case 'white-man':
            editBoard.white |= bit;
            break;
        case 'white-king':
            editBoard.white |= bit;
            editBoard.kings |= bit;
            break;
        case 'black-man':
            editBoard.black |= bit;
            break;
        case 'black-king':
            editBoard.black |= bit;
            editBoard.kings |= bit;
            break;
    }

    boardUI.setPosition(editBoard.white, editBoard.black, editBoard.kings, editWhiteToMove);
}

function clearEditBoard() {
    editBoard = { white: 0, black: 0, kings: 0 };
    boardUI.setPosition(0, 0, 0, editWhiteToMove);
}

function updateSideToMoveButtons() {
    const whiteBtn = document.getElementById('btn-white-to-move');
    const blackBtn = document.getElementById('btn-black-to-move');
    if (whiteBtn && blackBtn) {
        whiteBtn.classList.toggle('active', editWhiteToMove);
        blackBtn.classList.toggle('active', !editWhiteToMove);
    }
}

// --- Time dialog ---

function showTimeDialog() {
    const dialog = document.getElementById('time-dialog');
    const input = document.getElementById('time-input');
    if (dialog && input) {
        input.value = searchManager.secondsPerMove;
        dialog.style.display = 'flex';
        input.select();
    }
}

function hideTimeDialog() {
    const dialog = document.getElementById('time-dialog');
    if (dialog) dialog.style.display = 'none';
}

function applyTimePerMove() {
    const input = document.getElementById('time-input');
    if (!input) return;

    let value = parseFloat(input.value);
    if (isNaN(value) || value < 0.1) value = 0.1;

    searchManager.setSecondsPerMove(value);
    searchManager.resetTimeBank();
    updateTimePerMoveLabel(value);
    hideTimeDialog();
}

function updateTimePerMoveLabel(seconds) {
    const el = document.getElementById('btn-time-per-move');
    if (!el) return;
    let text;
    if (seconds >= 1 && seconds === Math.floor(seconds)) {
        text = `+${seconds}s/coup`;
    } else {
        text = `+${parseFloat(seconds.toFixed(1))}s/coup`;
    }
    el.textContent = text;
}

// --- New game dialog ---

function showNewGameDialog() {
    const dialog = document.getElementById('new-game-dialog');
    if (dialog) dialog.style.display = 'flex';
}

function hideNewGameDialog() {
    const dialog = document.getElementById('new-game-dialog');
    if (dialog) dialog.style.display = 'none';
}

async function startNewGame(playAs) {
    hideNewGameDialog();
    clearSearchInfo();

    await searchManager.abort();
    await gameState.newGame();

    if (playAs === 'white') {
        boardUI.setFlipped(false);
        turnController.setHumanColor('white');
    } else if (playAs === 'black') {
        boardUI.setFlipped(true);
        turnController.setHumanColor('black');
    } else {
        boardUI.setFlipped(false);
        turnController.setHumanColor('both');
    }

    updateModeButtons();
    updateUndoRedoButtons();
    updateMoveHistory();
    updatePlayButton();
}

// --- Analyse étendue (réflexion sur tous les coups) ---

let extRun = 0;
let extActive = false;
let extRows = [];
let extSel = -1;

function fmtScore(s) {
    if (Math.abs(s) > 29000) {
        const m = Math.ceil((30000 - Math.abs(s)) / 2);
        return s > 0 ? `M${m}` : `-M${m}`;
    }
    if (Math.abs(s) <= 10000) return (s >= 0 ? '+' : '') + (s / 100).toFixed(2);
    const raw = s > 0 ? s - 10000 : s + 10000;
    return (raw > 0 ? '+' : '') + (raw / 100).toFixed(2);
}

function extLine(row) {
    const all = [row.move.notation, ...(row.pv || [])];
    let out = '', n = 1;
    all.forEach((m, i) => {
        if (i % 2 === 0) out += `${i ? ' ' : ''}${n++}.${m}`; else out += ` ${m}`;
    });
    return out;
}

function renderExt() {
    const box = document.getElementById('ext-rows');
    if (!box) return;
    const sorted = extRows.map((r, i) => ({ r, i })).sort((a, b) => b.r.score - a.r.score);
    box.innerHTML = '';
    sorted.forEach(({ r, i }) => {
        const d = document.createElement('div');
        d.className = 'ext-row' + (i === extSel ? ' sel' : '');
        const sc = r.done || r.depth ? fmtScore(r.score) : '...';
        d.innerHTML = `<span class="sc ${r.score > 20 ? 'pos' : r.score < -20 ? 'neg' : ''}">${sc}</span><span class="dp">${r.depth ? '[' + r.depth + ']' : ''}</span><span class="ln"></span>`;
        d.querySelector('.ln').textContent = extLine(r);
        d.addEventListener('click', () => {
            extSel = i;
            const nums = (r.move.notation.match(/\d+/g) || []).map(Number);
            if (boardUI && nums.length > 1) boardUI.setArrow(nums);
            renderExt();
        });
        box.appendChild(d);
    });
}

function setExtStatus(t) {
    const el = document.getElementById('ext-status');
    if (el) el.textContent = t;
}

function stopExtAnalysis() {
    if (!extActive) return;
    extRun++;
    extActive = false;
    engine.stopSearch();
}

async function startExtAnalysis() {
    if (extActive) { stopExtAnalysis(); return; }
    if (editMode || gameState.gameOver || !gameState.legalMoves.length) return;
    if (searchManager.state === 'thinking') { setExtStatus("Attendez la fin du coup de l'ordinateur."); document.getElementById('ext-panel').style.display = 'block'; return; }

    const run = ++extRun;
    extActive = true;
    const panel = document.getElementById('ext-panel');
    const lp = document.getElementById('learn-panel'); if (lp) lp.style.display = 'none';
    panel.style.display = 'block';
    const board = gameState.board;
    const moves = gameState.legalMoves.slice();
    const secs = parseFloat(document.getElementById('ext-time').value) || 2;
    const wasPonder = turnController.ponderEnabled;
    const savedAuto = turnController.autoPlay;
    turnController.autoPlay = false;
    if (wasPonder) await togglePondering(false);
    await searchManager.abort();
    if (boardUI) boardUI.setArrow(null);

    extRows = moves.map(m => ({ move: m, score: -99999, depth: 0, pv: [], done: false }));
    extSel = -1;
    renderExt();

    try {
        for (let k = 0; k < moves.length; k++) {
            if (run !== extRun || gameState.board !== board) break;
            setExtStatus(`Coup ${k + 1} / ${moves.length} : ${moves[k].notation} (${secs} s par coup)`);
            const child = await engine.makeMove(board, moves[k]);
            const reply = await engine.getLegalMoves(child);
            const row = extRows[k];
            if (reply.length === 0) {
                row.score = 30000; row.depth = 0; row.done = true; renderExt(); continue;
            }
            const onProg = (r) => {
                if (run !== extRun || r.score === undefined) return;
                row.score = -r.score; row.depth = r.depth; row.pv = r.pv || [];
                renderExt();
            };
            const res = await engine.search(child, secs, secs, onProg, true);
            if (run !== extRun) break;
            if (res && !res.error && res.score !== undefined) {
                row.score = -res.score; row.depth = res.depth; row.pv = res.pv || [];
            }
            row.done = true;
            renderExt();
        }
        if (run === extRun) {
            setExtStatus('Analyse terminée. Cliquez sur une ligne pour voir la flèche.');
            const best = extRows.reduce((b, r, i) => (b < 0 || r.score > extRows[b].score) ? i : b, -1);
            if (best >= 0) {
                extSel = best;
                const nums = (extRows[best].move.notation.match(/\d+/g) || []).map(Number);
                if (boardUI && nums.length > 1) boardUI.setArrow(nums);
                renderExt();
            }
        } else {
            setExtStatus('Analyse arrêtée.');
        }
    } catch (err) {
        console.error('Analyse étendue:', err);
        setExtStatus('Erreur pendant l\'analyse.');
    } finally {
        if (run === extRun) extActive = false;
        turnController.autoPlay = savedAuto;
        if (wasPonder && !turnController.ponderEnabled) await togglePondering(true);
        const b = document.getElementById('btn-ext');
        if (b) b.textContent = 'Réflexion';
    }
}

function setupExtAnalysis() {
    const btn = document.getElementById('btn-ext');
    if (btn) btn.addEventListener('click', () => {
        const panel = document.getElementById('ext-panel');
        if (extActive) { stopExtAnalysis(); return; }
        if (panel.style.display !== 'none') { panel.style.display = 'none'; if (boardUI) boardUI.setArrow(null); return; }
        startExtAnalysis();
    });
    const stop = document.getElementById('ext-stop');
    if (stop) stop.addEventListener('click', () => { if (extActive) stopExtAnalysis(); else startExtAnalysis(); });
    const close = document.getElementById('ext-close');
    if (close) close.addEventListener('click', () => {
        stopExtAnalysis();
        document.getElementById('ext-panel').style.display = 'none';
        if (boardUI) boardUI.setArrow(null);
    });
    const panelIds = ['ext-panel', 'learn-panel'];
    const refreshOpen = () => {
        const open = panelIds.some(id => { const el = document.getElementById(id); return el && el.style.display !== 'none'; });
        document.body.classList.toggle('ext-open', open);
        window.dispatchEvent(new Event('resize'));
        setTimeout(() => window.dispatchEvent(new Event('resize')), 150);
    };
    panelIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) new MutationObserver(refreshOpen).observe(el, { attributes: true, attributeFilter: ['style'] });
    });
    if (gameState) gameState.addEventListener('move', () => { stopExtAnalysis(); const p = document.getElementById('ext-panel'); if (p) p.style.display = 'none'; });
}

// --- Enregistrement automatique des parties ---

let autoSaveId = null;
let autoSaveOff = false;   // partie chargée pour analyse : pas d'enregistrement
let autoSaveCustom = false; // partie commencée depuis une position composée

function autoSaveGame(result, reason) {
    if (matchPlayActive || autoSaveOff || !gameState) return;
    const moves = gameState.history.map(h => h.notation);
    if (moves.length < 2) return;
    if (!autoSaveId) autoSaveId = Date.now();
    const prev = getGames().find(g => g.id === autoSaveId);
    const startBoard = gameState.history[0] && gameState.history[0].board;
    upsertGame({
        id: autoSaveId,
        start: autoSaveCustom && startBoard
            ? { white: startBoard.white, black: startBoard.black, kings: startBoard.kings, whiteToMove: startBoard.whiteToMove }
            : undefined,
        date: prev ? prev.date : new Date().toISOString(),
        moves,
        result: result || (gameState.gameOver ? gameState.winner : (prev && prev.result) || 'unfinished'),
        resultReason: reason || (prev && prev.resultReason) || null,
        playerColor: turnController.humanColor,
        free: true
    });
}

function setupAutoSave() {
    if (!gameState) return;
    gameState.addEventListener('newGame', () => { autoSaveId = null; autoSaveOff = false; autoSaveCustom = false; });
    gameState.addEventListener('positionChanged', () => { autoSaveId = null; autoSaveOff = false; autoSaveCustom = true; });
    gameState.addEventListener('gameLoaded', () => { autoSaveId = null; autoSaveOff = true; autoSaveCustom = false; });
    gameState.addEventListener('move', () => autoSaveGame());
    gameState.addEventListener('gameOver', (e) => autoSaveGame(e.detail.winner, e.detail.reason));
}

// --- Navigation : début / fin / revoir la partie automatiquement ---

let autoRun = 0;
let autoPlaying = false;

function updateNavButtons() {
    if (!gameState) return;
    const { canUndo, canRedo } = gameState.getUndoRedoState();
    const busy = searchManager.state === 'thinking';
    const s = document.getElementById('btn-start'), e = document.getElementById('btn-end'), a = document.getElementById('btn-auto');
    if (s) s.disabled = !canUndo || busy || autoPlaying;
    if (e) e.disabled = !canRedo || busy || autoPlaying;
    if (a) a.disabled = (!canUndo && !canRedo) || (busy && !autoPlaying) || editMode;
    const pl = document.getElementById('btn-play-replay'), pa = document.getElementById('btn-pause-replay'), st = document.getElementById('btn-stop-replay');
    const any = (canUndo || canRedo) && !editMode;
    if (pl) pl.disabled = !any || autoPlaying || busy;
    if (pa) pa.disabled = !autoPlaying;
    if (st) st.disabled = !autoPlaying;
    if (pl) pl.classList.toggle('on', autoPlaying);
}

async function reviewSession(fn) {
    const savedAuto = turnController.autoPlay;
    const wasPonder = turnController.ponderEnabled;
    turnController.autoPlay = false;
    if (wasPonder) await togglePondering(false);
    await searchManager.abort();
    try { await fn(); } finally {
        turnController.autoPlay = savedAuto;
        if (wasPonder && !turnController.ponderEnabled) await togglePondering(true);
        updateNavButtons();
    }
}

function stopAutoReplay() {
    if (!autoPlaying) return;
    autoRun++;
    autoPlaying = false;
    const a = document.getElementById('btn-auto');
    if (a) { a.textContent = '▶ Revoir la partie'; a.classList.remove('playing'); }
    updateNavButtons();
}

async function goStart() {
    stopAutoReplay();
    await reviewSession(async () => { while (gameState.getUndoRedoState().canUndo) await gameState.undo(); });
}

async function goEnd() {
    stopAutoReplay();
    await reviewSession(async () => { while (gameState.getUndoRedoState().canRedo) await gameState.redo(); });
}

async function toggleAutoReplay() {
    if (autoPlaying) { stopAutoReplay(); return; }
    if (editMode) return;
    const run = ++autoRun;
    autoPlaying = true;
    const a = document.getElementById('btn-auto');
    a.textContent = '⏸ Pause'; a.classList.add('playing');
    updateNavButtons();
    const ext = document.getElementById('ext-panel');
    await reviewSession(async () => {
        // si on est déjà à la fin, on recommence depuis le début
        if (!gameState.getUndoRedoState().canRedo) {
            while (run === autoRun && gameState.getUndoRedoState().canUndo) await gameState.undo();
            if (run === autoRun) await new Promise(r => setTimeout(r, 600));
        }
        while (run === autoRun && gameState.getUndoRedoState().canRedo) {
            await gameState.redo();
            const delay = parseInt(document.getElementById('auto-speed').value) || 1200;
            await new Promise(r => setTimeout(r, delay));
        }
    });
    if (run === autoRun) {
        autoPlaying = false;
        a.textContent = '▶ Revoir la partie'; a.classList.remove('playing');
        updateNavButtons();
    }
}

function setupNavButtons() {
    const s = document.getElementById('btn-start'), e = document.getElementById('btn-end'), a = document.getElementById('btn-auto');
    if (s) s.addEventListener('click', goStart);
    if (e) e.addEventListener('click', goEnd);
    if (a) a.addEventListener('click', toggleAutoReplay);
    const pl = document.getElementById('btn-play-replay'), pa = document.getElementById('btn-pause-replay'), st = document.getElementById('btn-stop-replay');
    if (pl) pl.addEventListener('click', () => { if (!autoPlaying) toggleAutoReplay(); });
    if (pa) pa.addEventListener('click', () => stopAutoReplay());
    if (st) st.addEventListener('click', () => goEnd());
    // toute action manuelle arrête la lecture automatique
    for (const id of ['btn-undo', 'btn-redo', 'btn-new-game', 'btn-edit', 'btn-play']) {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', stopAutoReplay, true);
    }
    if (gameState) for (const ev of ['move', 'undo', 'redo', 'newGame', 'positionChanged', 'gameLoaded']) {
        gameState.addEventListener(ev, updateNavButtons);
    }
    searchManager.addEventListener('searchStart', updateNavButtons);
    searchManager.addEventListener('searchEnd', updateNavButtons);
    updateNavButtons();
}

// --- Mémoire des erreurs ---

const MEM_KEY = 'sambrk.errors';
function memLoad() { try { return JSON.parse(localStorage.getItem(MEM_KEY)) || {}; } catch (e) { return {}; } }
function memSave(m) { try { localStorage.setItem(MEM_KEY, JSON.stringify(m)); } catch (e) { console.warn(e); } }
function memPosKey(b) { return `${b.white},${b.black},${b.kings}`; }
function memCount() { return Object.keys(memLoad()).length; }

let learnRun = 0;
let learnActive = false;

function setLearnStatus(t) { const el = document.getElementById('learn-status'); if (el) el.textContent = t; }
function showLearnPanel() {
    const ep = document.getElementById('ext-panel'); if (ep) ep.style.display = 'none';
    document.getElementById('learn-panel').style.display = 'block';
}
function stopLearn() {
    if (!learnActive) return;
    learnRun++;
    learnActive = false;
    engine.stopSearch();
}

async function learnFromGame() {
    if (learnActive) { stopLearn(); return; }
    showLearnPanel();
    const rows = document.getElementById('learn-rows');
    rows.innerHTML = '';
    if (editMode) { setLearnStatus('Quittez le mode édition avant.'); return; }
    const hc = turnController.humanColor;
    if (hc === 'both') { setLearnStatus('Choisissez « Moteur blancs » (B) ou « Moteur noirs » (N), pour que je sache quels coups du moteur analyser.'); return; }
    if (searchManager.state === 'thinking') { setLearnStatus("Attendez la fin du coup de l'ordinateur."); return; }
    const hist = gameState.history.slice();
    if (hist.length < 4) { setLearnStatus('La partie est trop courte pour apprendre quelque chose.'); return; }

    const engineWhite = hc === 'black';
    const boards = hist.map(h => h.board);
    const startBoard = gameState.board;
    boards.push(startBoard);
    const run = ++learnRun;
    learnActive = true;
    const secs = parseFloat(document.getElementById('learn-time').value) || 2;
    const thr = parseInt(document.getElementById('learn-thr').value) || 50;

    const savedAuto = turnController.autoPlay;
    const wasPonder = turnController.ponderEnabled;
    turnController.autoPlay = false;
    if (wasPonder) await togglePondering(false);
    await searchManager.abort();

    const cache = new Map();
    const alive = () => run === learnRun && gameState.board === startBoard;
    async function evalPos(i) {
        if (cache.has(i)) return cache.get(i);
        const b = boards[i];
        const legal = await engine.getLegalMoves(b);
        let r;
        if (legal.length === 0) r = { score: -30000, bestMove: null, legalCount: 0 };
        else {
            const s = await engine.search(b, secs, secs, null, true);
            r = (s && !s.error && s.score !== undefined) ? { score: s.score, bestMove: s.bestMove, legalCount: legal.length } : null;
        }
        cache.set(i, r);
        return r;
    }

    const mem = memLoad();
    let found = 0;
    const engineIdx = [];
    for (let k = 0; k < hist.length; k++) if (boards[k].whiteToMove === engineWhite) engineIdx.push(k);
    try {
        for (let n = 0; n < engineIdx.length; n++) {
            if (!alive()) break;
            const k = engineIdx[n];
            setLearnStatus(`Analyse du coup ${n + 1} / ${engineIdx.length} du moteur (${secs} s par position) — ${found} erreur(s) trouvée(s)`);
            const a = await evalPos(k);
            if (!alive() || !a || a.legalCount < 2 || !a.bestMove) continue;
            const b = await evalPos(k + 1);
            if (!alive() || !b) continue;
            const eBefore = a.score, eAfter = -b.score;
            if ((eBefore <= -800 && eAfter <= -800) || (eBefore >= 800 && eAfter >= 800)) continue;
            const loss = eBefore - eAfter;
            const played = hist[k].notation;
            const better = a.bestMove.notation;
            if (loss >= thr && better && better !== played) {
                const key = memPosKey(boards[k]);
                const old = mem[key];
                const bad = Array.from(new Set([...((old && old.bad) || []), played]));
                mem[key] = { ...(old || {}), bad, better, loss: Math.round(loss), date: new Date().toISOString() };
                memSave(mem);
                found++;
                const d = document.createElement('div');
                d.className = 'ext-row';
                d.innerHTML = '<span class="sc neg"></span><span class="dp"></span><span class="ln"></span>';
                d.querySelector('.sc').textContent = loss >= 1500 ? 'perdu' : '-' + (loss / 100).toFixed(2);
                d.querySelector('.dp').textContent = '#' + (Math.floor(k / 2) + 1);
                d.querySelector('.ln').textContent = `Coup joué ${played} → mieux : ${better}`;
                rows.appendChild(d);
            }
        }
        if (alive()) {
            setLearnStatus(found
                ? `Terminé : ${found} erreur(s) retenue(s). Mémoire totale : ${memCount()} position(s). Le moteur jouera autrement s'il retrouve ces positions.`
                : `Terminé : aucune erreur nette trouvée (seuil ${(thr / 100).toFixed(2)}). Mémoire totale : ${memCount()} position(s).`);
        } else {
            setLearnStatus(`Analyse arrêtée. ${found} erreur(s) retenue(s). Mémoire totale : ${memCount()} position(s).`);
        }
    } catch (err) {
        console.error('Apprentissage:', err);
        setLearnStatus("Erreur pendant l'analyse.");
    } finally {
        if (run === learnRun) learnActive = false;
        turnController.autoPlay = savedAuto;
        if (wasPonder && !turnController.ponderEnabled) await togglePondering(true);
    }
}

function setupLearning() {
    const btn = document.getElementById('btn-learn');
    if (btn) btn.addEventListener('click', learnFromGame);
    const stop = document.getElementById('learn-stop');
    if (stop) stop.addEventListener('click', () => { if (learnActive) stopLearn(); else learnFromGame(); });
    const teach = document.getElementById('learn-teach');
    if (teach) teach.addEventListener('click', () => {
        showLearnPanel();
        const rows = document.getElementById('learn-rows');
        rows.innerHTML = '';
        const hist = gameState.history;
        if (!hist.length) { setLearnStatus("Jouez d'abord la partie (par exemple en mode 2 joueurs), puis cliquez ici."); return; }
        const side = document.getElementById('teach-side').value;
        const mem = memLoad();
        let n = 0;
        hist.forEach((h, k) => {
            const isWhite = h.board.whiteToMove;
            if (side === 'white' && !isWhite) return;
            if (side === 'black' && isWhite) return;
            const key = memPosKey(h.board);
            mem[key] = { ...(mem[key] || {}), play: h.notation, date: new Date().toISOString() };
            n++;
            const d = document.createElement('div');
            d.className = 'ext-row';
            d.innerHTML = '<span class="sc pos"></span><span class="dp"></span><span class="ln"></span>';
            d.querySelector('.sc').textContent = isWhite ? 'Blancs' : 'Noirs';
            d.querySelector('.dp').textContent = '#' + (Math.floor(k / 2) + 1);
            d.querySelector('.ln').textContent = `Coup retenu : ${h.notation}`;
            rows.appendChild(d);
        });
        memSave(mem);
        setLearnStatus(`${n} coup(s) retenu(s). Mémoire totale : ${memCount()} position(s). Le moteur les jouera s'il retrouve ces positions.`);
    });
    const close = document.getElementById('learn-close');
    if (close) close.addEventListener('click', () => { stopLearn(); document.getElementById('learn-panel').style.display = 'none'; });
    const clear = document.getElementById('learn-clear');
    if (clear) clear.addEventListener('click', () => {
        if (confirm(`Effacer les ${memCount()} position(s) mémorisées ?`)) {
            localStorage.removeItem(MEM_KEY);
            document.getElementById('learn-rows').innerHTML = '';
            setLearnStatus('Mémoire effacée.');
        }
    });
    // le moteur évite les coups déjà reconnus comme mauvais
    turnController.errorMemoryHook = (board, best) => {
        const e = memLoad()[memPosKey(board)];
        if (!e) return null;
        const cur = gameState.legalMoves.find(m => m.from_xor_to === best.from_xor_to && m.captures === best.captures);
        const notation = cur ? cur.notation : best.notation;
        if (e.play) {
            if (notation === e.play) return null;
            const pm = gameState.legalMoves.find(m => m.notation === e.play);
            if (pm) return pm;
        }
        if (!e.bad || !e.bad.includes(notation)) return null;
        return gameState.legalMoves.find(m => m.notation === e.better) || null;
    };
}

// --- Prise obligatoire automatique ---

let forcedTimer = null;
function setupAutoCapture() {
    const chk = document.getElementById('chk-autocapture');
    try { const v = localStorage.getItem('sambrk.autoCapture'); if (chk && v !== null) chk.checked = v === '1'; } catch (e) {}
    if (chk) chk.addEventListener('change', () => { try { localStorage.setItem('sambrk.autoCapture', chk.checked ? '1' : '0'); } catch (e) {} });
    gameState.addEventListener('move', () => {
        clearTimeout(forcedTimer);
        const board = gameState.board;
        forcedTimer = setTimeout(async () => {
            if (!chk || !chk.checked) return;
            if (gameState.board !== board || gameState.gameOver || editMode) return;
            if (extActive || learnActive || autoPlaying) return;
            if (searchManager.state === 'thinking' || !turnController.isHumanTurn()) return;
            const moves = gameState.legalMoves;
            if (moves.length !== 1 || !String(moves[0].notation).includes('x')) return;
            await animateAndMakeMove(moves[0], true);
        }, 500);
    });
}

// --- Raccourcis clavier (PC) ---

function setupShortcuts() {
    const click = (id) => { const b = document.getElementById(id); if (b && !b.disabled) b.click(); };
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target;
        if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
        if (document.querySelector('.dialog')) {
            for (const d of document.querySelectorAll('.dialog')) if (d.style.display && d.style.display !== 'none') return;
        }
        switch (e.key) {
            case 'b': case 'B': click('btn-engine-white'); break;
            case 'n': case 'N': click('btn-engine-black'); break;
            case 'j': case 'J': case '2': click('btn-two-player'); break;
            case 'r': case 'R': click('btn-ext'); break;
            case 'ArrowLeft': click('btn-undo'); break;
            case 'ArrowRight': click('btn-redo'); break;
            case 'Home': click('btn-start'); break;
            case 'End': click('btn-end'); break;
            case ' ':
                if (t && t.tagName === 'BUTTON') return;
                click('btn-auto'); break;
            default: return;
        }
        e.preventDefault();
    });
}

// --- Play button ---

function updatePlayButton() {
    const playBtn = document.getElementById('btn-play');
    if (!playBtn) return;

    const searchInfo = document.getElementById('search-info');
    if (searchInfo && showAnalysis && !editMode) {
        searchInfo.style.display = 'block';
    }

    if (editMode || gameState.gameOver || gameState.legalMoves.length === 0) {
        playBtn.disabled = true;
        return;
    }

    if (searchManager.state === 'pondering') {
        playBtn.disabled = searchManager.currentPV.length === 0;
        return;
    }

    if (searchManager.state === 'thinking') {
        playBtn.disabled = false;
        return;
    }

    // Idle: enabled if it's human's turn
    playBtn.disabled = !turnController.isHumanTurn();
}

// --- Time display ---

function updateTimeDisplay(seconds) {
    const el = document.getElementById('engine-time-left');
    if (!el) return;

    if (seconds < 0) seconds = 0;

    // Round to tenths first to avoid "00:60.0" when e.g. 59.96 rounds up
    const tenths = Math.round(seconds * 10) / 10;

    let text;
    if (tenths >= 3600) {
        const h = Math.floor(tenths / 3600);
        const m = Math.floor((tenths % 3600) / 60);
        const s = Math.floor(tenths % 60);
        text = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
        const m = Math.floor(tenths / 60);
        const s = tenths % 60;
        text = `${String(m).padStart(2, '0')}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
    }
    el.textContent = text;
}

// --- Search info ---

function clearSearchInfo() {
    const searchInfo = document.getElementById('search-info');
    if (searchInfo) searchInfo.style.display = 'none';
    if (boardUI) boardUI.setArrow(null);
}

function updateSearchInfo(info) {
    const searchInfo = document.getElementById('search-info');
    if (!searchInfo) return;

    if (showAnalysis && !editMode) searchInfo.style.display = 'block';

    const summaryEl = document.getElementById('search-summary');
    const pvEl = document.getElementById('search-pv');

    if (summaryEl) {
        let depth = info.depth || '-';
        if (info.phase) {
            const phaseLabel = info.phase === 'winning' ? 'gagnant' : info.phase === 'losing' ? 'perdant' : info.phase;
            depth += ` (${phaseLabel})`;
        }
        const score = info.scoreStr || '-';
        const nodes = info.nodes || 0;
        const nodesStr = nodes.toLocaleString();
        const nps = info.nps || 0;
        let npsStr;
        if (nps >= 1000000) {
            npsStr = (nps / 1000000).toFixed(1) + 'M';
        } else if (nps >= 1000) {
            npsStr = (nps / 1000).toFixed(0) + 'k';
        } else {
            npsStr = nps > 0 ? nps.toString() : '-';
        }
        summaryEl.innerHTML = `${depth}. ${score} <span class="search-label">nodes:</span> ${nodesStr} <span class="search-label">nps:</span> ${npsStr}`;
    }
    if (pvEl) pvEl.textContent = info.pvStr || '-';
    if (boardUI && showAnalysis && !editMode && info.pvStr) {
        const mv = /^\s*(\d+(?:\s*[-x]\s*\d+)+)/.exec(info.pvStr);
        if (mv) boardUI.setArrow(mv[1].match(/\d+/g).map(Number));
    }

    // Root moves display
    let rootMovesEl = document.getElementById('search-root-moves');
    if (info.rootMoves && info.rootMoves.length > 0) {
        if (!rootMovesEl) {
            rootMovesEl = document.createElement('div');
            rootMovesEl.id = 'search-root-moves';
            rootMovesEl.className = 'search-info-row search-root-moves';
            searchInfo.appendChild(rootMovesEl);
        }
        const parts = info.rootMoves.map(m => {
            let s;
            if (Math.abs(m.score) > 29000) {
                const mateIn = Math.ceil((30000 - Math.abs(m.score)) / 2);
                s = m.score > 0 ? `M${mateIn}` : `-M${mateIn}`;
            } else if (Math.abs(m.score) <= 10000) {
                const val = (m.score / 100).toFixed(2);
                s = (m.score >= 0 ? '+' : '') + val + '=';
            } else {
                const raw = m.score > 0 ? m.score - 10000 : m.score + 10000;
                const val = (raw / 100).toFixed(2);
                s = raw > 0 ? `+${val}` : val;
            }
            return `${m.notation}: ${s}`;
        });
        rootMovesEl.textContent = parts.join('  ');
        rootMovesEl.style.display = '';
    } else if (rootMovesEl) {
        rootMovesEl.style.display = 'none';
    }

    // Book moves display
    let bookMovesEl = document.getElementById('search-book-moves');
    if (info.bookMoves && info.bookMoves.length > 0) {
        if (!bookMovesEl) {
            bookMovesEl = document.createElement('div');
            bookMovesEl.id = 'search-book-moves';
            bookMovesEl.className = 'search-info-row search-book-moves';
            searchInfo.appendChild(bookMovesEl);
        }
        const parts = info.bookMoves.map(m => {
            const pct = (m.probability * 100).toFixed(0);
            const q = (m.q / 100).toFixed(1);
            return `${m.notation}: ${pct}% (${q})`;
        });
        bookMovesEl.innerHTML = `<span class="search-label">livre :</span> ${parts.join('  ')}`;
        bookMovesEl.style.display = '';
    } else if (bookMovesEl) {
        bookMovesEl.style.display = 'none';
    }

    // Update eval bar
    if (info.score !== undefined) {
        updateEvalBar(info.score);
    }
}

// --- Eval bar ---

function normalizeScore(score) {
    if (Math.abs(score) <= 10000) return 0;
    if (Math.abs(score) > 28000) return score > 0 ? 10000 : -10000;
    return score > 0 ? score - 10000 : score + 10000;
}

let lastEvalScore = null;

function updateEvalBar(score) {
    lastEvalScore = score;
    const bar = document.getElementById('eval-bar-white');
    if (!bar) return;

    const flipped = boardUI.flipped;
    const whiteScore = boardUI.whiteToMove ? score : -score;
    const displayScore = normalizeScore(whiteScore);
    const clamped = Math.max(-10000, Math.min(10000, displayScore));
    const pct = ((clamped + 10000) / 20000) * 100;
    bar.style.height = `${pct}%`;

    if (flipped) {
        bar.style.bottom = '';
        bar.style.top = '0';
    } else {
        bar.style.top = '';
        bar.style.bottom = '0';
    }
}

// --- Move history ---

function updateMoveHistory() {
    const historyEl = document.getElementById('move-history');
    if (!historyEl || !gameState) return;

    const { history, redo } = gameState.getMoveHistoryForDisplay();
    const allMoves = [...history, ...redo];

    if (allMoves.length === 0) {
        historyEl.innerHTML = '';
        return;
    }

    let html = '';
    const lastPlayedIndex = history.length - 1;
    for (let i = 0; i < allMoves.length; i++) {
        const moveNum = Math.floor(i / 2) + 1;
        const isRedo = i >= history.length;

        if (i % 2 === 0) {
            html += `${moveNum}. `;
        }

        if (isRedo) {
            html += `<span class="redo-move">${allMoves[i]}</span> `;
        } else if (i === lastPlayedIndex) {
            html += `<span id="last-played-move">${allMoves[i]}</span> `;
        } else {
            html += `${allMoves[i]} `;
        }
    }

    historyEl.innerHTML = html.trim();

    if (history.length > 0) {
        const lastEl = document.getElementById('last-played-move');
        if (lastEl) {
            // Scroll within the history container only, not the page
            const top = lastEl.offsetTop - historyEl.offsetTop;
            historyEl.scrollTop = top - historyEl.clientHeight / 2;
        }
    } else {
        historyEl.scrollTop = 0;
    }
}

// --- Game over ---

function showGameOver(winner, reason) {
    let message;
    if (winner === 'draw') {
        message = reason ? `Partie nulle — ${reason} !` : 'Partie nulle !';
    } else {
        const name = winner === 'white' ? 'blancs' : 'noirs';
        message = reason ? `Les ${name} gagnent (${reason}) !` : `Les ${name} gagnent !`;
    }

    // Update status text
    if (winner === 'draw') {
        const msg = reason ? `Partie nulle — ${reason} !` : 'Partie nulle !';
        updateStatus(msg);
    } else {
        const winnerName = winner === 'white' ? 'blancs' : 'noirs';
        updateStatus(`Les ${winnerName} gagnent !`);
    }

    console.log(message);

    if (matchPlayActive) {
        saveGame({
            id: Date.now(),
            date: new Date().toISOString(),
            moves: gameState.history.map(h => h.notation),
            result: winner,
            resultReason: reason || null,
            playerColor: turnController.humanColor
        });

        matchStats = computeStats();

        let title, resultMsg;
        if (winner === 'draw') {
            title = 'Partie nulle';
            resultMsg = message;
        } else if (winner === turnController.humanColor) {
            title = 'Vous avez gagné !';
            resultMsg = message;
        } else {
            title = 'Vous avez perdu';
            resultMsg = message;
        }
        setTimeout(() => showMatchResultDialog(title, resultMsg), 100);
    } else {
        setTimeout(() => alert(message), 100);
    }
}

// --- Analysis display ---

function toggleShowAnalysis(enabled) {
    showAnalysis = enabled;

    const evalBar = document.getElementById('eval-bar');
    const searchInfo = document.getElementById('search-info');

    if (enabled) {
        if (evalBar) evalBar.style.visibility = '';
        if (searchInfo) searchInfo.style.display = 'block';
    } else {
        if (evalBar) evalBar.style.visibility = 'hidden';
        if (searchInfo) searchInfo.style.display = 'none';
    }

    updateOptionsButtons();
    savePreferences();
}

// --- Pondering ---

async function togglePondering(enabled) {
    if (enabled) {
        if (turnController.ponderEnabled) return;
        turnController.setPonderEnabled(true);
        updateOptionsButtons();
        updatePlayButton();
    } else {
        if (!turnController.ponderEnabled) return;
        turnController.setPonderEnabled(false);
        updateOptionsButtons();
        updatePlayButton();
    }
    savePreferences();
}

// --- Match Play ---

function getLegacyStats() {
    try {
        const data = localStorage.getItem(MATCH_STATS_KEY);
        if (data) return JSON.parse(data);
    } catch (e) { /* ignore */ }
    return null;
}

async function startMatchPlay() {
    hideNewGameDialog();

    savedPonder = turnController.ponderEnabled;
    savedShowAnalysis = showAnalysis;
    savedUseBook = useBook;

    toggleShowAnalysis(false);

    matchStats = computeStats();
    matchPlayActive = true;
    document.body.classList.add('match-play');
    document.getElementById('game-controls').style.display = 'none';
    document.getElementById('match-toolbar').style.display = 'flex';
    clearSearchInfo();

    const games = getGames();
    const lastGame = games.length > 0 ? games[games.length - 1] : null;
    const color = lastGame ? (lastGame.playerColor === 'white' ? 'black' : 'white') : 'white';

    searchManager.setSecondsPerMove(3);
    useBook = true;
    engine.setUseBook(true);

    await searchManager.abort();
    await gameState.newGame();
    boardUI.setFlipped(color === 'black');
    turnController.setHumanColor(color);

    await togglePondering(true);
}

let resignResolve = null;

function matchResign() {
    document.getElementById('resign-confirm-dialog').style.display = 'flex';
    return new Promise(resolve => {
        resignResolve = resolve;
    }).then(async (confirmed) => {
        if (!confirmed) return;
        await searchManager.abort();

        const engineColor = turnController.humanColor === 'white' ? 'black' : 'white';
        saveGame({
            id: Date.now(),
            date: new Date().toISOString(),
            moves: gameState.history.map(h => h.notation),
            result: engineColor,
            resultReason: 'abandon',
            playerColor: turnController.humanColor
        });
        matchStats = computeStats();
        showMatchResultDialog('Abandon', 'Vous avez abandonné la partie.');
    });
}

function showMatchResultDialog(title, message) {
    document.getElementById('match-result-title').textContent = title;
    document.getElementById('match-result-message').textContent = message;
    document.getElementById('match-stat-w').textContent = matchStats.wins;
    document.getElementById('match-stat-d').textContent = matchStats.draws;
    document.getElementById('match-stat-l').textContent = matchStats.losses;
    document.getElementById('match-result-dialog').style.display = 'flex';
}

// --- Base de parties ---

const BASES_KEY = 'sambrk.bases';
const DEFAULT_BASE = 'Mes parties';
let currentBase = DEFAULT_BASE;
let baseQuery = '';
let baseFilter = null;          // Map id -> numéro du coup où la position apparaît
let selectedGameId = null;
let baseBusy = false;
let shownCount = 200;
const PAGE = 200;

function getBases() {
    let b = null;
    try { b = JSON.parse(localStorage.getItem(BASES_KEY)); } catch (e) {}
    if (!Array.isArray(b)) b = [];
    if (!b.includes(DEFAULT_BASE)) b.unshift(DEFAULT_BASE);
    for (const g of getGames()) { const n = g.base || DEFAULT_BASE; if (!b.includes(n)) b.push(n); }
    return b;
}
function saveBases(b) { try { localStorage.setItem(BASES_KEY, JSON.stringify(b)); } catch (e) {} }
function gameBase(g) { return g.base || DEFAULT_BASE; }
function setBaseStatus(t) { const el = document.getElementById('base-status'); if (el) el.textContent = t; }
function bitCount(n) { n = n >>> 0; let c = 0; while (n) { n &= n - 1; c++; } return c; }

const nMoves = (g) => g.ms ? g.ms.split(' ').length : 0;
const textCache = new WeakMap();
function gameText(g) {
    let t = textCache.get(g);
    if (t === undefined) { t = `${g.white || ''} ${g.black || ''} ${g.event || ''} ${g.date || ''} ${g.ms || ''}`.toLowerCase(); textCache.set(g, t); }
    return t;
}
const keyCache = new Map();   // id -> Uint32Array (empreintes de position, en mémoire seulement)
const yieldUI = () => new Promise(r => setTimeout(r, 0));

function filteredGames() {
    let games = getGames().filter(g => gameBase(g) === currentBase);
    const q = baseQuery.trim().toLowerCase();
    if (q) {
        const toks = q.split(/\s+/);
        games = games.filter(g => { const text = gameText(g); return text.includes(q) || toks.every(t => text.includes(t)); });
    }
    if (baseFilter) games = games.filter(g => baseFilter.has(g.id));
    return games.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}

function renderBase() {
    const sel = document.getElementById('base-select');
    const bases = getBases();
    if (!bases.includes(currentBase)) currentBase = DEFAULT_BASE;
    sel.innerHTML = '';
    for (const b of bases) {
        const o = document.createElement('option');
        o.value = b;
        o.textContent = `${b} (${getGames().filter(g => gameBase(g) === b).length})`;
        if (b === currentBase) o.selected = true;
        sel.appendChild(o);
    }
    const stats = computeStats();
    const legacy = getLegacyStats();
    const ds = (stats.wins + stats.draws + stats.losses > 0) ? stats : legacy || { wins: 0, draws: 0, losses: 0 };
    document.getElementById('history-stat-w').textContent = ds.wins;
    document.getElementById('history-stat-d').textContent = ds.draws;
    document.getElementById('history-stat-l').textContent = ds.losses;

    const games = filteredGames();
    const listEl = document.getElementById('history-list');
    listEl.innerHTML = '';
    if (!games.length) {
        const d = document.createElement('div');
        d.className = 'history-empty';
        d.textContent = baseFilter || baseQuery ? 'Aucune partie ne correspond.' : 'Aucune partie dans cette base.';
        listEl.appendChild(d);
    }
    const total = games.length;
    for (const g of games.slice(0, shownCount)) {
        const d = new Date(g.date);
        const dateStr = isNaN(d) ? (g.date || '') : d.toLocaleDateString('fr', { day: 'numeric', month: 'short', year: '2-digit' });
        const row = document.createElement('div');
        row.className = 'history-item' + (g.id === selectedGameId ? ' selected' : '');
        row.dataset.id = g.id;
        const names = (g.white || g.black) ? `${g.white || '?'} – ${g.black || '?'}` : '';
        const mvl = g.ms ? g.ms.split(' ') : [];
        const preview = mvl.slice(0, 6).join(' ') + (mvl.length > 6 ? ' ...' : '');
        let label, cls = 'draw';
        if (g.free || g.imported) label = g.result === 'white' ? '1-0' : g.result === 'black' ? '0-1' : g.result === 'draw' ? '½' : '…';
        else if (g.result === 'draw') label = 'N';
        else if (g.result === g.playerColor) { label = 'V'; cls = 'win'; } else { label = 'D'; cls = 'loss'; }
        const ply = baseFilter ? baseFilter.get(g.id) : null;
        row.innerHTML = '<span class="history-date"></span><span class="history-moves"></span><span class="history-result"></span>';
        row.querySelector('.history-date').textContent = dateStr;
        const mv = row.querySelector('.history-moves');
        mv.textContent = `${names ? names + ' · ' : ''}${g.event ? g.event + ' · ' : ''}${preview} (${mvl.length} coups${g.start ? ', position composée' : ''}${ply != null ? ', position au coup ' + ply : ''})`;
        const r = row.querySelector('.history-result');
        r.textContent = label; r.classList.add(cls);
        listEl.appendChild(row);
    }
    if (total > shownCount) {
        const more = document.createElement('button');
        more.className = 'history-more';
        more.textContent = `Afficher ${Math.min(PAGE, total - shownCount)} de plus (${shownCount} / ${total})`;
        more.addEventListener('click', () => { shownCount += PAGE; renderBase(); });
        listEl.appendChild(more);
    } else if (total > PAGE) {
        const e = document.createElement('div'); e.className = 'history-empty'; e.textContent = `${total} parties affichées.`; listEl.appendChild(e);
    }
    updateHistoryButtons();
}

function showHistoryDialog() {
    const dialog = document.getElementById('history-dialog');
    if (!dialog) return;
    selectedGameId = null;
    baseFilter = null;
    baseQuery = '';
    shownCount = PAGE;
    document.getElementById('base-search').value = '';
    setBaseStatus('');
    renderBase();
    dialog.style.display = 'flex';
}

function hideHistoryDialog() {
    const dialog = document.getElementById('history-dialog');
    if (dialog) dialog.style.display = 'none';
    selectedGameId = null;
}

function updateHistoryButtons() {
    for (const id of ['btn-history-watch', 'btn-history-analyze', 'btn-history-delete', 'btn-history-info', 'btn-history-move'])
        { const b = document.getElementById(id); if (b) b.disabled = !selectedGameId || baseBusy; }
}

function selectedGame() { return getGames().find(g => g.id === selectedGameId); }

// ---- format PDN ----
function sqList(mask, kings, wantKings) {
    const out = [];
    for (let i = 0; i < 32; i++) if ((mask >>> i) & 1) { const k = (kings >>> i) & 1; if (!!k === wantKings) out.push(i + 1); }
    return out;
}
function fenOf(s) {
    const side = (m) => [...sqList(m & s.kings, s.kings, true).map(n => 'K' + n), ...sqList(m & ~s.kings, s.kings, false)].join(',');
    // dames d'abord, puis pions
    const w = [...sqList(s.white & s.kings, s.kings, true).map(n => 'K' + n), ...sqList(s.white & ~s.kings, s.kings, false).map(String)].join(',');
    const bl = [...sqList(s.black & s.kings, s.kings, true).map(n => 'K' + n), ...sqList(s.black & ~s.kings, s.kings, false).map(String)].join(',');
    return `${s.whiteToMove ? 'W' : 'B'}:W${w}:B${bl}`;
}
function parseFen(fen) {
    const m = /^\s*([WB])\s*:\s*W([^:]*):\s*B([^:]*)\s*$/i.exec(fen || '');
    if (!m) return null;
    const mask = (txt) => { let w = 0, k = 0; for (const t of txt.split(',')) { const mm = /^\s*(K?)(\d+)\.?\s*$/i.exec(t); if (!mm) continue; const bit = (parseInt(mm[2]) - 1) >>> 0; if (bit > 31) continue; w |= (1 << bit); if (mm[1]) k |= (1 << bit); } return { w: w >>> 0, k: k >>> 0 }; };
    const a = mask(m[2]), b = mask(m[3]);
    return { white: a.w, black: b.w, kings: (a.k | b.k) >>> 0, whiteToMove: m[1].toUpperCase() === 'W' };
}
function toPDN(g) {
    const res = g.result === 'white' ? '1-0' : g.result === 'black' ? '0-1' : g.result === 'draw' ? '1/2-1/2' : '*';
    const d = new Date(g.date);
    const ds = isNaN(d) ? '????.??.??' : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    let t = `[Event "${g.event || ''}"]\n[Date "${ds}"]\n[White "${g.white || ''}"]\n[Black "${g.black || ''}"]\n[Result "${res}"]\n`;
    if (g.start) t += `[SetUp "1"]\n[FEN "${fenOf(g.start)}"]\n`;
    let mt = '';
    const blackFirst = g.start && !g.start.whiteToMove;
    g.moves.forEach((m, i) => {
        const idx = blackFirst ? i + 1 : i;
        if (idx % 2 === 0) mt += `${Math.floor(idx / 2) + 1}.${m} `; else mt += (i === 0 ? `1... ` : '') + `${m} `;
    });
    return t + '\n' + mt.trim() + ' ' + res + '\n';
}
function parsePDN(text) {
    const games = [];
    const chunks = text.replace(/\r/g, '').split(/\n\s*\n(?=\s*\[)/);
    for (const ch of chunks) {
        const tags = {};
        ch.replace(/\[(\w+)\s+"([^"]*)"\]/g, (_, k, v) => { tags[k] = v; return ''; });
        let mt = ch.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/;[^\n]*/g, ' ');
        const moves = [];
        for (let tok of mt.split(/\s+/)) {
            if (!tok) continue;
            if (/^(1-0|0-1|2-0|0-2|1\/2-1\/2|½-½|\*)$/.test(tok)) continue;
            tok = tok.replace(/^\d+\.(\.\.)?/, '').replace(/^\.\.+/, '');
            if (!tok) continue;
            tok = tok.replace(/[+#!?]+$/g, '').replace(/\b0(\d)/g, '$1').replace(/[:]/g, 'x');
            if (/^\d+([-x]\d+)+$/.test(tok)) moves.push(tok);
        }
        if (moves.length) games.push({ tags, moves });
    }
    return games;
}
function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

async function importFile(file) {
    baseBusy = true; updateHistoryButtons();
    try {
        const text = await file.text();
        const existing = getGames();
        let added = 0, failed = 0;
        let incoming = [];
        const t = text.trim();
        if (t.startsWith('[') && /^\[\s*[{\]]/.test(t) || t.startsWith('{')) {
            let data = JSON.parse(t);
            if (!Array.isArray(data)) data = data.games || [];
            incoming = data.filter(g => g && (Array.isArray(g.moves) || typeof g.ms === 'string')).map(g => ({ ...g, json: true }));
        } else {
            for (const p of parsePDN(text)) {
                const res = p.tags.Result || '';
                incoming.push({
                    moves: p.moves, white: p.tags.White || '', black: p.tags.Black || '', event: p.tags.Event || '',
                    date: (p.tags.Date && /^\d{4}\.\d\d\.\d\d$/.test(p.tags.Date)) ? p.tags.Date.replace(/\./g, '-') : undefined,
                    result: res === '1-0' ? 'white' : res === '0-1' ? 'black' : /1\/2|½/.test(res) ? 'draw' : 'unfinished',
                    start: p.tags.FEN ? parseFen(p.tags.FEN) || undefined : undefined
                });
            }
        }
        let n = 0, buf = [];
        const t0 = Date.now(), baseId = Date.now() * 1000;
        const dedupe = new Set();
        for (const g of existing) if (gameBase(g) === currentBase && g.imported) dedupe.add(g.ms);
        let dup = 0;
        for (const g of incoming) {
            n++;
            if (n % 500 === 0) { setBaseStatus(`Import : partie ${n} / ${incoming.length}…`); await yieldUI(); }
            const mv = Array.isArray(g.moves) ? g.moves : (typeof g.ms === 'string' && g.ms ? g.ms.split(' ') : []);
            const startPos = g.start ? FG.startPosOf(g) : null;
            const r = mv.length ? FG.replayMoves(startPos, mv) : { ok: false };
            if (!r.ok) { failed++; continue; }
            const ms = mv.join(' ');
            if (dedupe.has(ms) && !g.start) { dup++; continue; }
            dedupe.add(ms);
            const rec = {
                id: baseId + added, date: g.date ? new Date(g.date).toISOString() : new Date().toISOString(),
                ms, result: g.result || 'unfinished', playerColor: 'white', free: true, imported: true,
                white: g.white, black: g.black, event: g.event, start: g.start, base: g.base && g.json ? g.base : currentBase
            };
            buf.push(rec); added++;
        }
        setBaseStatus('Enregistrement dans la base…');
        await pushGames(buf);
        setBaseStatus(`${added} partie(s) importée(s) dans « ${currentBase} »${failed ? `, ${failed} ignorée(s) (coups illisibles)` : ''}${dup ? `, ${dup} doublon(s) écarté(s)` : ''}.`);
    } catch (err) {
        console.error(err);
        setBaseStatus("Impossible de lire ce fichier. Formats acceptés : PDN (.pdn, .txt) ou sauvegarde SAM_brk (.json).");
    } finally {
        baseBusy = false;
        renderBase();
    }
}

async function searchPosition() {
    if (baseBusy) return;
    baseBusy = true; updateHistoryButtons();
    try {
        const target = FG.hashPos(FG.posFromBoard(gameState.board));
        const inBase = getGames().filter(g => gameBase(g) === currentBase);
        baseFilter = new Map();
        let i = 0;
        for (const g of inBase) {
            i++;
            if (i % 1000 === 0) { setBaseStatus(`Recherche de la position : ${i} / ${inBase.length}…`); await yieldUI(); }
            let k = keyCache.get(g.id);
            if (!k) { k = FG.replayMoves(FG.startPosOf(g), g.ms ? g.ms.split(' ') : []).keys; keyCache.set(g.id, k); }
            const p = k.indexOf(target); if (p >= 0) baseFilter.set(g.id, p);
        }
        setBaseStatus(baseFilter.size
            ? `${baseFilter.size} partie(s) contiennent la position actuelle du damier. Cliquez sur une partie, puis « Analyser » pour l'ouvrir à cet endroit.`
            : 'Aucune partie de cette base ne contient la position actuelle du damier.');
    } catch (err) { console.error(err); setBaseStatus('Erreur pendant la recherche.'); }
    finally { baseBusy = false; renderBase(); }
}

function setupHistoryDialogHandlers() {
    const dialog = document.getElementById('history-dialog');
    if (!dialog) return;
    const listEl = document.getElementById('history-list');
    listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.history-item');
        if (!item) return;
        listEl.querySelectorAll('.history-item.selected').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        selectedGameId = parseInt(item.dataset.id);
        updateHistoryButtons();
    });
    document.getElementById('btn-history-close').addEventListener('click', hideHistoryDialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) hideHistoryDialog(); });

    document.getElementById('base-select').addEventListener('change', (e) => { currentBase = e.target.value; baseFilter = null; selectedGameId = null; setBaseStatus(''); renderBase(); });
    document.getElementById('base-new').addEventListener('click', () => {
        const n = (prompt('Nom de la nouvelle base :') || '').trim();
        if (!n) return;
        const b = getBases();
        if (!b.includes(n)) { b.push(n); saveBases(b); }
        currentBase = n; baseFilter = null; renderBase(); setBaseStatus(`Base « ${n} » créée. Importez ou déplacez-y des parties.`);
    });
    document.getElementById('base-rename').addEventListener('click', () => {
        if (currentBase === DEFAULT_BASE) { setBaseStatus('La base « Mes parties » ne peut pas être renommée.'); return; }
        const n = (prompt('Nouveau nom :', currentBase) || '').trim();
        if (!n || n === currentBase) return;
        const games = getGames(); games.forEach(g => { if (gameBase(g) === currentBase) g.base = n; });
        setGames(games);
        saveBases(getBases().map(b => b === currentBase ? n : b));
        currentBase = n; renderBase();
    });
    document.getElementById('base-del').addEventListener('click', () => {
        if (currentBase === DEFAULT_BASE) { setBaseStatus('La base « Mes parties » ne peut pas être supprimée.'); return; }
        const cnt = getGames().filter(g => gameBase(g) === currentBase).length;
        if (!confirm(`Supprimer la base « ${currentBase} » et ses ${cnt} partie(s) ?`)) return;
        setGames(getGames().filter(g => gameBase(g) !== currentBase));
        saveBases(getBases().filter(b => b !== currentBase));
        currentBase = DEFAULT_BASE; baseFilter = null; selectedGameId = null; renderBase();
    });
    let _dbt = null;
    document.getElementById('base-search').addEventListener('input', (e) => { baseQuery = e.target.value; shownCount = PAGE; clearTimeout(_dbt); _dbt = setTimeout(renderBase, 300); });
    document.getElementById('base-pos').addEventListener('click', searchPosition);
    document.getElementById('base-all').addEventListener('click', () => { baseFilter = null; baseQuery = ''; document.getElementById('base-search').value = ''; setBaseStatus(''); renderBase(); });
    document.getElementById('base-import').addEventListener('click', () => document.getElementById('base-file').click());
    document.getElementById('base-file').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importFile(f); });
    document.getElementById('base-export-pdn').addEventListener('click', () => {
        const games = filteredGames().slice().reverse();
        if (!games.length) { setBaseStatus('Rien à exporter.'); return; }
        download(`${currentBase.replace(/[^\w-]+/g, '_')}.pdn`, games.map(toPDN).join('\n'), 'text/plain');
        setBaseStatus(`${games.length} partie(s) exportée(s) au format PDN.`);
    });
    document.getElementById('base-export-json').addEventListener('click', () => {
        const games = getGames().map(g => ({ ...g }));
        download('sambrk-sauvegarde.json', JSON.stringify({ bases: getBases(), games }, null, 1), 'application/json');
        setBaseStatus(`Sauvegarde complète : ${games.length} partie(s), toutes bases.`);
    });

    document.getElementById('btn-history-delete').addEventListener('click', () => {
        if (!selectedGameId) return;
        if (!confirm('Supprimer cette partie ?')) return;
        deleteGame(selectedGameId);
        selectedGameId = null;
        renderBase();
    });
    document.getElementById('btn-history-info').addEventListener('click', () => {
        const g = selectedGame(); if (!g) return;
        const w = prompt('Joueur des blancs :', g.white || ''); if (w === null) return;
        const b = prompt('Joueur des noirs :', g.black || ''); if (b === null) return;
        const ev = prompt('Événement / commentaire :', g.event || ''); if (ev === null) return;
        g.white = w.trim(); g.black = b.trim(); g.event = ev.trim();
        upsertGame(g); renderBase();
    });
    document.getElementById('btn-history-move').addEventListener('click', () => {
        const g = selectedGame(); if (!g) return;
        const bases = getBases();
        const ans = prompt('Déplacer vers quelle base ? Tapez le numéro :\n' + bases.map((b, i) => `${i + 1}. ${b}`).join('\n'));
        const idx = parseInt(ans) - 1;
        if (!(idx >= 0 && idx < bases.length)) return;
        g.base = bases[idx]; upsertGame(g); selectedGameId = null; renderBase();
    });
    document.getElementById('btn-history-watch').addEventListener('click', () => {
        const game = selectedGame();
        if (game) { hideHistoryDialog(); watchGame(game); }
    });
    document.getElementById('btn-history-analyze').addEventListener('click', async () => {
        const game = selectedGame();
        if (!game) return;
        const ply = baseFilter ? baseFilter.get(game.id) : 0;
        hideHistoryDialog();
        await loadGameForAnalysis(game);
        for (let i = 0; i < (ply || 0); i++) await gameState.redo();
        updateMoveHistory(); updateUndoRedoButtons(); updateNavButtons();
    });
}

async function loadGameForAnalysis(game) {
    await togglePondering(false);
    clearSearchInfo();

    const savedAutoPlay = turnController.autoPlay;
    turnController.autoPlay = false;
    await searchManager.abort();
    await gameState.loadGame(game.moves, game.start || null);
    turnController.autoPlay = savedAutoPlay;

    boardUI.setFlipped(game.playerColor === 'black');
    turnController.setHumanColor('both');
    toggleShowAnalysis(true);
    await togglePondering(true);

    updateMoveHistory();
    updateUndoRedoButtons();
    updateModeButtons();
}

async function watchGame(game) {
    stopExtAnalysis();
    stopLearn();
    stopAutoReplay();
    await togglePondering(false);
    clearSearchInfo();
    const savedAutoPlay = turnController.autoPlay;
    turnController.autoPlay = false;
    await searchManager.abort();
    await gameState.loadGame(game.moves, game.start || null);
    turnController.autoPlay = savedAutoPlay;
    boardUI.setFlipped(game.playerColor === 'black');
    turnController.setHumanColor('both');
    toggleShowAnalysis(false);
    updateMoveHistory();
    updateUndoRedoButtons();
    updateModeButtons();
    updateNavButtons();
    await new Promise(r => setTimeout(r, 400));
    toggleAutoReplay();
}

async function exitMatchPlay() {
    matchPlayActive = false;
    document.body.classList.remove('match-play');
    document.getElementById('match-toolbar').style.display = 'none';
    document.getElementById('game-controls').style.display = 'flex';
    document.getElementById('match-result-dialog').style.display = 'none';

    await togglePondering(savedPonder);
    toggleShowAnalysis(savedShowAnalysis);
    useBook = savedUseBook;
    engine.setUseBook(useBook);
    updateOptionsButtons();

    updateModeButtons();
    updateUndoRedoButtons();
    updateMoveHistory();
}

// --- Tablebase download ---

async function showDownloadDialog(type = 'dtm') {
    const dialog = document.getElementById('download-dialog');
    if (!dialog) {
        alert('Téléchargement des finales indisponible');
        return;
    }

    if (!tablebaseLoader || !tablebaseLoader.isAvailable()) {
        alert('Le stockage des finales demande OPFS, qui nécessite HTTPS ou localhost.');
        return;
    }

    dialog.style.display = 'flex';

    const progressEl = dialog.querySelector('.progress');
    const statusEl = dialog.querySelector('.status');
    const titleEl = dialog.querySelector('h2');
    const cancelBtn = dialog.querySelector('.cancel-btn');

    if (titleEl) {
        titleEl.textContent = type === 'cwdl'
            ? 'Téléchargement des finales WDL 6-8 pièces'
            : 'Téléchargement des finales DTM 5-7 pièces';
    }

    let cancelled = false;
    cancelBtn.onclick = () => {
        cancelled = true;
        dialog.style.display = 'none';
    };

    try {
        const downloadFn = type === 'cwdl'
            ? tablebaseLoader.downloadCWDLTablebases.bind(tablebaseLoader)
            : tablebaseLoader.downloadTablebases.bind(tablebaseLoader);

        await downloadFn((loaded, total, file) => {
            if (cancelled) return;
            const pct = Math.round((loaded / total) * 100);
            if (progressEl) progressEl.style.width = `${pct}%`;
            if (statusEl) statusEl.textContent = `Téléchargement : ${file} (${loaded}/${total})`;
        });

        if (!cancelled) {
            statusEl.textContent = 'Terminé ! Elles seront utilisées automatiquement.';
            setTimeout(() => {
                dialog.style.display = 'none';
                window.location.reload();
            }, 1500);
        }
    } catch (err) {
        if (statusEl) statusEl.textContent = `Erreur : ${err.message}`;
    }
}

// --- Event handlers setup ---

function setupEventHandlers() {
    // New game
    const newGameBtn = document.getElementById('btn-new-game');
    if (newGameBtn) newGameBtn.addEventListener('click', showNewGameDialog);

    const playWhiteBtn = document.getElementById('btn-play-white');
    const playBlackBtn = document.getElementById('btn-play-black');
    const playBothBtn = document.getElementById('btn-play-both');
    if (playWhiteBtn) playWhiteBtn.addEventListener('click', () => startNewGame('white'));
    if (playBlackBtn) playBlackBtn.addEventListener('click', () => startNewGame('black'));
    if (playBothBtn) playBothBtn.addEventListener('click', () => startNewGame('both'));

    const newGameDialog = document.getElementById('new-game-dialog');
    if (newGameDialog) {
        newGameDialog.addEventListener('click', (e) => {
            if (e.target === newGameDialog) hideNewGameDialog();
        });
    }

    // Undo/Redo
    const undoBtn = document.getElementById('btn-undo');
    if (undoBtn) {
        undoBtn.addEventListener('click', async () => {
            await searchManager.abort();
            await gameState.undo();
        });
    }

    const redoBtn = document.getElementById('btn-redo');
    if (redoBtn) {
        redoBtn.addEventListener('click', async () => {
            if (searchManager.state === 'thinking') return;
            if (searchManager.state === 'pondering') await searchManager.abort();
            await gameState.redo();
        });
    }

    // Flip board
    const flipBtn = document.getElementById('btn-flip');
    if (flipBtn) {
        flipBtn.addEventListener('click', () => {
            boardUI.setFlipped(!boardUI.flipped);
            if (lastEvalScore !== null) updateEvalBar(lastEvalScore);
        });
    }

    // Mode toggle buttons
    const btnEngineWhite = document.getElementById('btn-engine-white');
    const btnEngineBlack = document.getElementById('btn-engine-black');
    const btnTwoPlayer = document.getElementById('btn-two-player');

    if (btnEngineWhite) {
        btnEngineWhite.addEventListener('click', async () => {
            if (searchManager.state === 'pondering') await searchManager.abort();
            turnController.setHumanColor('black');
        });
    }
    if (btnEngineBlack) {
        btnEngineBlack.addEventListener('click', async () => {
            if (searchManager.state === 'pondering') await searchManager.abort();
            turnController.setHumanColor('white');
        });
    }
    if (btnTwoPlayer) {
        btnTwoPlayer.addEventListener('click', async () => {
            if (searchManager.state === 'pondering') await searchManager.abort();
            turnController.setHumanColor('both');
        });
    }

    // Pondering checkbox
    const chkPonder = document.getElementById('chk-ponder');
    if (chkPonder) {
        chkPonder.addEventListener('change', () => togglePondering(chkPonder.checked));
    }

    // Time per move
    const timePerMoveBtn = document.getElementById('btn-time-per-move');
    if (timePerMoveBtn) timePerMoveBtn.addEventListener('click', showTimeDialog);

    // Book checkbox
    const chkUseBook = document.getElementById('chk-use-book');
    if (chkUseBook) {
        chkUseBook.addEventListener('change', () => {
            useBook = chkUseBook.checked;
            engine.setUseBook(useBook);
            savePreferences();
        });
    }

    // Analysis display checkbox
    const chkShowAnalysis = document.getElementById('chk-show-analysis');
    if (chkShowAnalysis) {
        chkShowAnalysis.addEventListener('change', () => toggleShowAnalysis(chkShowAnalysis.checked));
    }

    // Sound checkbox
    const chkSound = document.getElementById('chk-sound');
    if (chkSound) {
        chkSound.addEventListener('change', () => {
            setSoundEnabled(chkSound.checked);
            savePreferences();
        });
    }

    // Time dialog
    const timeDialog = document.getElementById('time-dialog');
    const timeInput = document.getElementById('time-input');
    const timeOkBtn = document.getElementById('btn-time-ok');
    const timeCancelBtn = document.getElementById('btn-time-cancel');

    if (timeDialog) {
        timeDialog.addEventListener('click', (e) => {
            if (e.target === timeDialog) hideTimeDialog();
        });
    }
    if (timeOkBtn) timeOkBtn.addEventListener('click', applyTimePerMove);
    if (timeCancelBtn) timeCancelBtn.addEventListener('click', hideTimeDialog);
    if (timeInput) {
        timeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyTimePerMove();
            if (e.key === 'Escape') hideTimeDialog();
        });
    }

    // Play button
    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
        playBtn.addEventListener('click', async () => {
            if (searchManager.state === 'pondering') {
                await turnController.playPonderMove();
            } else if (searchManager.state === 'thinking') {
                searchManager.stop();
            } else {
                await turnController.engineMoveNow();
            }
        });
    }

    // Download tablebases
    const downloadBtn = document.getElementById('btn-download-tb');
    if (downloadBtn) downloadBtn.addEventListener('click', () => showDownloadDialog('dtm'));

    const downloadCwdlBtn = document.getElementById('btn-download-cwdl');
    if (downloadCwdlBtn) downloadCwdlBtn.addEventListener('click', () => showDownloadDialog('cwdl'));

    const clearTbBtn = document.getElementById('btn-clear-tb');
    if (clearTbBtn) clearTbBtn.addEventListener('click', async () => {
        if (!tablebaseLoader || !tablebaseLoader.isAvailable()) {
            alert('Aucune finale enregistrée.');
            return;
        }
        if (!confirm('Supprimer toutes les finales téléchargées ?')) return;
        await tablebaseLoader.clearTablebases();
        // Also remove legacy "tablebases" directory if it exists
        try {
            const opfsRoot = await navigator.storage.getDirectory();
            await opfsRoot.removeEntry('tablebases', { recursive: true });
        } catch (e) {
            // Ignore if it doesn't exist
        }
        alert('Finales supprimées.');
        window.location.reload();
    });

    // Edit mode
    const editBtn = document.getElementById('btn-edit');
    if (editBtn) editBtn.addEventListener('click', enterEditMode);

    // Piece selector
    document.querySelectorAll('.piece-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.piece-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            editPieceType = btn.dataset.piece;
        });
    });

    // Clear board
    const clearBtn = document.getElementById('btn-clear-board');
    if (clearBtn) clearBtn.addEventListener('click', clearEditBoard);

    // Side to move
    const whiteToMoveBtn = document.getElementById('btn-white-to-move');
    const blackToMoveBtn = document.getElementById('btn-black-to-move');
    if (whiteToMoveBtn) {
        whiteToMoveBtn.addEventListener('click', () => {
            editWhiteToMove = true;
            updateSideToMoveButtons();
        });
    }
    if (blackToMoveBtn) {
        blackToMoveBtn.addEventListener('click', () => {
            editWhiteToMove = false;
            updateSideToMoveButtons();
        });
    }

    // Done button
    const doneBtn = document.getElementById('btn-edit-done');
    if (doneBtn) doneBtn.addEventListener('click', exitEditMode);

    // Draw offer dialog
    const acceptDrawBtn = document.getElementById('btn-accept-draw');
    const declineDrawBtn = document.getElementById('btn-decline-draw');
    if (acceptDrawBtn) {
        acceptDrawBtn.addEventListener('click', () => {
            document.getElementById('draw-offer-dialog').style.display = 'none';
            if (drawOfferResolve) { drawOfferResolve(true); drawOfferResolve = null; }
        });
    }
    if (declineDrawBtn) {
        declineDrawBtn.addEventListener('click', () => {
            document.getElementById('draw-offer-dialog').style.display = 'none';
            if (drawOfferResolve) { drawOfferResolve(false); drawOfferResolve = null; }
        });
    }

    // Match play
    const matchPlayBtn = document.getElementById('btn-match-play');
    if (matchPlayBtn) matchPlayBtn.addEventListener('click', startMatchPlay);

    setupExtAnalysis();
    setupAutoSave();
    setupNavButtons();
    setupLearning();
    setupAutoCapture();
    setupShortcuts();

    const statsBtn = document.getElementById('btn-stats');
    if (statsBtn) statsBtn.addEventListener('click', showHistoryDialog);

    const matchResignBtn = document.getElementById('btn-match-resign');
    if (matchResignBtn) matchResignBtn.addEventListener('click', matchResign);

    // Resign confirm dialog
    const resignYesBtn = document.getElementById('btn-resign-yes');
    const resignNoBtn = document.getElementById('btn-resign-no');
    const resignDialog = document.getElementById('resign-confirm-dialog');
    if (resignYesBtn) {
        resignYesBtn.addEventListener('click', () => {
            resignDialog.style.display = 'none';
            if (resignResolve) { resignResolve(true); resignResolve = null; }
        });
    }
    if (resignNoBtn) {
        resignNoBtn.addEventListener('click', () => {
            resignDialog.style.display = 'none';
            if (resignResolve) { resignResolve(false); resignResolve = null; }
        });
    }
    if (resignDialog) {
        resignDialog.addEventListener('click', (e) => {
            if (e.target === resignDialog) {
                resignDialog.style.display = 'none';
                if (resignResolve) { resignResolve(false); resignResolve = null; }
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && resignDialog.style.display !== 'none') {
                resignDialog.style.display = 'none';
                if (resignResolve) { resignResolve(false); resignResolve = null; }
            }
        });
    }

    // Match result dialog
    const matchResultOkBtn = document.getElementById('btn-match-result-ok');
    if (matchResultOkBtn) matchResultOkBtn.addEventListener('click', exitMatchPlay);

    // History dialog
    setupHistoryDialogHandlers();
}

// --- Board resize ---

function resizeBoard() {
    if (boardUI && boardUI.applySize) boardUI.applySize();
}

// Start application
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for debugging
window.gameState = () => gameState;
window.searchManager = () => searchManager;
window.turnController = () => turnController;
window.engine = getEngine;
