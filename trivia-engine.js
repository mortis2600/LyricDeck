// Trivia GameEngine for Oma's Deli unified signage app.
// Solo players only. Classic Pub Trivia. Endless mode: questions cycle forever,
// no points, no leaderboard — just "who got it right" each round.
// State machine: OFFLINE -> LOBBY -> QUESTION -> REVEAL -> CORRECT -> INTERMISSION -> QUESTION...
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'trivia_history.json');

// Endless mode timing (ms)
const TRIVIA_LOBBY_MS = 8000;
const TRIVIA_QUESTION_MS = 30000;
const TRIVIA_REVEAL_MS = 8000;
const TRIVIA_CORRECT_MS = 8000;
const TRIVIA_INTERMISSION_MS = 10000;

function loadJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(p, data) {
    try { fs.writeFileSync(p, JSON.stringify(data, null, 1)); } catch (e) { console.error('[trivia] save failed:', e.message); }
}

const GameEngine = {
    state: 'OFFLINE',           // OFFLINE | LOBBY | QUESTION | REVEAL | CORRECT | INTERMISSION
    players: {},                // socketId -> { name, discordId, answer, answeredAt }
    currentQuestion: null,      // { q, answers[4], correct, category, difficulty }
    playerCategories: {},     // socketId -> [categoryId, ...] (empty/unset = all)
    questionIndex: 0,
    questionAskedAt: null,
    revealedAt: null,
    correctPlayers: [],         // [{ name, at, ms }] — who got it right this round, sorted by speed
    roundHistory: [],
    startedAt: null,
};

function removePlayer(socketId) {
    delete GameEngine.players[socketId];
    if (GameEngine.playerCategories) delete GameEngine.playerCategories[socketId];
}

function resetGame() {
    GameEngine.state = 'OFFLINE';
    GameEngine.players = {};
    GameEngine.currentQuestion = null;
    GameEngine.questionIndex = 0;
    GameEngine.questionAskedAt = null;
    GameEngine.revealedAt = null;
    GameEngine.correctPlayers = [];
    GameEngine._countedQ = null;
    GameEngine.roundHistory = [];
    GameEngine.startedAt = null;
}

function openLobby() {
    resetGame();
    GameEngine.state = 'LOBBY';
    GameEngine.startedAt = Date.now();
    return snapshot();
}

// Register/update a player (solo, no teams, no scores)
function registerPlayer(socketId, playerName, discordId) {
    // Remove any existing entry with same name (prevents duplicates on refresh)
    for (const sid of Object.keys(GameEngine.players)) {
        if (GameEngine.players[sid].name === playerName && sid !== socketId) delete GameEngine.players[sid];
    }
    const name = String(playerName || 'Player').slice(0, 30);
    if (!GameEngine.players[socketId]) {
        GameEngine.players[socketId] = { name, discordId: discordId || null, answer: null, answeredAt: null, sessionCorrect: 0 };
    } else {
        GameEngine.players[socketId].name = name;
        if (discordId) GameEngine.players[socketId].discordId = discordId;
    }
    return { ok: true, name };
}

// Solo answer — one answer per player per question
function answerQuestion(socketId, answerIndex) {
    const p = GameEngine.players[socketId];
    if (!p) return { error: 'Register first' };
    if (GameEngine.state !== 'QUESTION') return { error: 'Not accepting answers' };
    if (p.answer !== null && p.answer !== undefined) return { alreadyLocked: true };
    const a = parseInt(answerIndex, 10);
    if (isNaN(a) || a < 0 || a > 3) return { error: 'Invalid answer' };
    p.answer = a;
    p.answeredAt = Date.now();
    return { ok: true, locked: true };
}

function getQuestion() {
    return GameEngine.currentQuestion;
}

// OpenTDB categories (id -> name)
const CATEGORIES = [
    [9,"General Knowledge"],[10,"Books"],[11,"Film"],[12,"Music"],
    [13,"Musicals & Theatres"],[14,"Television"],[15,"Video Games"],
    [16,"Board Games"],[17,"Science & Nature"],[18,"Computers"],
    [19,"Mathematics"],[20,"Mythology"],[21,"Sports"],[22,"Geography"],
    [23,"History"],[24,"Politics"],[25,"Art"],[26,"Celebrities"],
    [27,"Animals"],[28,"Comics"],[29,"Gadgets"],[31,"Anime & Manga"],
    [32,"Cartoons"],
];
// ---- Custom question endpoint ----
// Lets a venue run trivia on their own questions (e.g. LoreForge).
// Contract:
//   GET {base}/categories -> { "categories": [{ "id": "spells", "name": "Spells" }] }
//   GET {base}/questions?count=N&categories=id1,id2
//     -> { "questions": [{ "question": "...", "correct": "...",
//                          "incorrect": ["...","...","..."], "category": "..." }] }
let questionSource = { type: 'opentdb', endpointUrl: '' };
let customCategories = null;
let customCategoriesAt = 0;
function setQuestionSource(cfg) {
    cfg = cfg || {};
    questionSource = {
        type: cfg.type === 'custom' ? 'custom' : 'opentdb',
        endpointUrl: String(cfg.endpointUrl || '').replace(/\/$/, ''),
    };
    customCategories = null;
    if (questionSource.type === 'custom' && questionSource.endpointUrl) {
        fetchCustomCategories().catch(() => {});
    }
}
function httpGetJson(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('bad json')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs || 5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}
async function fetchCustomCategories() {
    if (customCategories && Date.now() - customCategoriesAt < 3600000) return customCategories;
    const data = await httpGetJson(questionSource.endpointUrl + '/categories');
    const list = (data.categories || [])
        .map(c => ({ id: String(c.id), name: String(c.name) }))
        .filter(c => c.id && c.name);
    if (list.length) { customCategories = list; customCategoriesAt = Date.now(); }
    return customCategories || [];
}
// Sync category list for the snapshot (custom list once cached, else OpenTDB)
function getCategoryList() {
    if (questionSource.type === 'custom') {
        if (customCategories) return customCategories;
        fetchCustomCategories().catch(() => {});
    }
    return CATEGORIES.map(c => ({ id: c[0], name: c[1] }));
}
async function fetchCustomQuestion() {
    const ids = getActiveCategories().map(String);
    let url = questionSource.endpointUrl + '/questions?count=1';
    if (ids.length) url += '&categories=' + ids.map(encodeURIComponent).join(',');
    const data = await httpGetJson(url);
    const q = (data.questions || [])[0];
    if (!q || !q.question || !q.correct || !Array.isArray(q.incorrect) || q.incorrect.length < 3) return null;
    const answers = [String(q.correct), ...q.incorrect.slice(0, 3).map(String)]
        .sort(() => Math.random() - 0.5);
    return {
        q: String(q.question),
        answers,
        correct: answers.indexOf(String(q.correct)),
        category: String(q.category || ''),
        difficulty: 'medium',
    };
}
function getActiveCategories() {
    const all = getCategoryList().map(c => c.id);
    const sels = Object.values(GameEngine.playerCategories || {}).filter(a => a && a.length);
    if (!sels.length) return all;
    const union = new Set();
    for (const s of sels) for (const id of s) union.add(id);
    return union.size ? [...union] : all;
}
function setPlayerCategories(socketId, cats) {
    const valid = new Set(getCategoryList().map(c => String(c.id)));
    GameEngine.playerCategories[socketId] = (cats || []).filter(id => valid.has(String(id)));
}

// Fetch a question: custom endpoint first (if configured), then OpenTDB, then local
function fetchQuestion() {
    return new Promise(async (resolve) => {
        if (questionSource.type === 'custom' && questionSource.endpointUrl) {
            try {
                const q = await fetchCustomQuestion();
                if (q) return resolve(q);
            } catch (e) { /* fall through to OpenTDB */ }
        }
        const _cats = getActiveCategories();
        const _cat = _cats[Math.floor(Math.random() * _cats.length)];
        const req = https.get('https://opentdb.com/api.php?amount=1&type=multiple&category=' + _cat, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    const q = j.results[0];
                    const answers = [...q.incorrect_answers, q.correct_answer]
                        .map(a => decodeHtml(a))
                        .sort(() => Math.random() - 0.5);
                    resolve({
                        q: decodeHtml(q.question),
                        answers,
                        correct: answers.indexOf(decodeHtml(q.correct_answer)),
                        category: decodeHtml(q.category),
                        difficulty: q.difficulty,
                    });
                } catch (e) { resolve(localQuestion()); }
            });
        });
        req.on('error', () => resolve(localQuestion()));
        req.setTimeout(5000, () => { req.destroy(); resolve(localQuestion()); });
    });
}

function decodeHtml(s) {
    return String(s).replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&eacute;/g, 'é');
}

function localQuestion() {
    const fallback = [
        { q: 'What is the capital of Germany?', answers: ['Munich', 'Berlin', 'Hamburg', 'Frankfurt'], correct: 1, category: 'Geography', difficulty: 'easy' },
        { q: 'Which beer style originated in Cologne?', answers: ['Pilsner', 'Weizen', 'Kölsch', 'Bock'], correct: 2, category: 'Beer', difficulty: 'medium' },
    ];
    return fallback[Math.floor(Math.random() * fallback.length)];
}

async function nextQuestion() {
    GameEngine.currentQuestion = await fetchQuestion();
    GameEngine.questionIndex++;
    GameEngine.questionAskedAt = Date.now();
    GameEngine.state = 'QUESTION';
    // Clear previous answers
    for (const id in GameEngine.players) {
        GameEngine.players[id].answer = null;
        GameEngine.players[id].answeredAt = null;
    }
    GameEngine.correctPlayers = [];
    return snapshot();
}

function revealAnswer() {
    if (GameEngine.state !== 'QUESTION') return null;
    GameEngine.state = 'REVEAL';
    GameEngine.revealedAt = Date.now();
    // Compute who got it right, sorted by speed. No points — endless mode.
    const correct = GameEngine.currentQuestion.correct;
    GameEngine.correctPlayers = Object.entries(GameEngine.players)
        .filter(([id, p]) => p.answer === correct)
        .map(([id, p]) => ({ name: p.name, ms: p.answeredAt - GameEngine.questionAskedAt }))
        .sort((a, b) => a.ms - b.ms);
    // Save to history
    GameEngine.roundHistory.push({
        q: GameEngine.currentQuestion.q,
        correct: GameEngine.correctPlayers.length,
        total: Object.keys(GameEngine.players).length,
        at: new Date().toISOString(),
    });
    return snapshot();
}

function showCorrect() {
    GameEngine.state = 'CORRECT';
    return snapshot();
}

function showIntermission() {
    GameEngine.state = 'INTERMISSION';
    return snapshot();
}

function playerList() {
    return Object.entries(GameEngine.players)
        .map(([id, p]) => ({ name: p.name, locked: p.answer !== null && p.answer !== undefined, sessionCorrect: p.sessionCorrect || 0 }));
}

function snapshot() {
    return {
        state: GameEngine.state,
        playerCount: Object.keys(GameEngine.players).length,
        questionIndex: GameEngine.questionIndex,
        question: GameEngine.currentQuestion ? {
            q: GameEngine.currentQuestion.q,
            answers: GameEngine.currentQuestion.answers,
            category: GameEngine.currentQuestion.category,
            // correct answer only revealed in REVEAL/CORRECT
            correct: ['REVEAL', 'CORRECT'].includes(GameEngine.state) ? GameEngine.currentQuestion.correct : null,
            // deadline for the play-page timer (ms epoch)
            endsAt: GameEngine.questionAskedAt ? GameEngine.questionAskedAt + TRIVIA_QUESTION_MS : null,
        } : null,
        correctPlayers: GameEngine.correctPlayers,
        players: playerList(),
        answerCounts: countAnswers(),
        categories: getCategoryList(),
        activeCategories: getActiveCategories(),
    };
}

function countAnswers() {
    const counts = [0, 0, 0, 0];
    const qkey = GameEngine.currentQuestion ? (GameEngine.currentQuestion.q || '') : '';
    if (GameEngine._countedQ !== qkey && GameEngine.correctPlayers.length) {
        GameEngine._countedQ = qkey;
        for (const cp of GameEngine.correctPlayers) { const pl = Object.values(GameEngine.players).find(x => x.name === cp.name); if (pl) pl.sessionCorrect = (pl.sessionCorrect||0)+1; }
    }
    for (const id in GameEngine.players) {
        const p = GameEngine.players[id];
        if (p.answer !== null && p.answer !== undefined) counts[p.answer]++;
    }
    return counts;
}

module.exports = {
    CATEGORIES,
    GameEngine,
    resetGame, openLobby, registerPlayer, removePlayer, answerQuestion, setPlayerCategories, getActiveCategories,
    nextQuestion, revealAnswer, showCorrect, showIntermission,
    setQuestionSource,
    snapshot, playerList,
    TRIVIA_LOBBY_MS, TRIVIA_QUESTION_MS, TRIVIA_REVEAL_MS, TRIVIA_CORRECT_MS, TRIVIA_INTERMISSION_MS,
};
